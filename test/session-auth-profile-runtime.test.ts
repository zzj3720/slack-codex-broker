import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import {
  AuthProfileUnavailableError,
  SessionAuthProfileRuntime
} from "../src/services/agent-runtime/session-auth-profile-runtime.js";
import type {
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentSession,
  AgentSubmitInputResult,
  AgentTurnSnapshot,
  SubmitAgentInput
} from "../src/services/agent-runtime/types.js";
import type { AuthProfileSummary, AuthProfilesStatus } from "../src/services/auth-profile-service.js";
import type { SlackSessionRecord, SlackUserIdentity } from "../src/types.js";

describe("SessionAuthProfileRuntime", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
  });

  it("binds a new session to the best usable auth profile and routes through that runtime", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "session-auth-runtime-"));
    tempDirs.push(dataRoot);
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      DATA_ROOT: dataRoot
    } as NodeJS.ProcessEnv);
    const session = createSession();
    const sessions = createSessionManagerMock(session);
    const runtimes = new Map<string, MockAgentRuntime>();
    const runtime = new SessionAuthProfileRuntime({
      config,
      sessions: sessions as never,
      authProfiles: authProfilesMock(profileStatus([
        profile("low", 10, 80),
        profile("best", 20, 10)
      ])) as never,
      createProfileRuntime: ({ profile }) => {
        const mockRuntime = new MockAgentRuntime(profile.name);
        runtimes.set(profile.name, mockRuntime);
        return mockRuntime;
      }
    });

    const agentSession = await runtime.ensureSession(session);

    expect(agentSession).toMatchObject({
      id: "best-thread",
      runtime: "codex-app-server"
    });
    expect(sessions.get(session.key)?.authProfileName).toBe("best");
    expect(runtimes.get("best")?.ensureSession).toHaveBeenCalledWith(expect.objectContaining({
      authProfileName: "best"
    }));
    expect(runtimes.has("low")).toBe(false);
  });

  it("keeps an existing usable binding instead of switching to a higher quota profile", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "session-auth-runtime-bound-"));
    tempDirs.push(dataRoot);
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      DATA_ROOT: dataRoot
    } as NodeJS.ProcessEnv);
    const session = createSession({
      authProfileName: "bound",
      authProfileBoundAt: "2026-05-09T00:00:00.000Z"
    });
    const sessions = createSessionManagerMock(session);
    const runtimes = new Map<string, MockAgentRuntime>();
    const runtime = new SessionAuthProfileRuntime({
      config,
      sessions: sessions as never,
      authProfiles: authProfilesMock(profileStatus([
        profile("bound", 60, 40),
        profile("bigger", 1, 1)
      ])) as never,
      createProfileRuntime: ({ profile }) => {
        const mockRuntime = new MockAgentRuntime(profile.name);
        runtimes.set(profile.name, mockRuntime);
        return mockRuntime;
      }
    });

    await runtime.submitInput({
      session,
      input: [],
      inputId: "input-1",
      source: "slack_user"
    });

    expect(runtimes.get("bound")?.submitInput).toHaveBeenCalledTimes(1);
    expect(runtimes.has("bigger")).toBe(false);
    expect(sessions.get(session.key)?.authProfileName).toBe("bound");
  });

  it("does not auto-switch when the bound auth profile is unavailable", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "session-auth-runtime-blocked-"));
    tempDirs.push(dataRoot);
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      DATA_ROOT: dataRoot
    } as NodeJS.ProcessEnv);
    const session = createSession({
      authProfileName: "empty",
      authProfileBoundAt: "2026-05-09T00:00:00.000Z"
    });
    const sessions = createSessionManagerMock(session);
    const runtimes = new Map<string, MockAgentRuntime>();
    const runtime = new SessionAuthProfileRuntime({
      config,
      sessions: sessions as never,
      authProfiles: authProfilesMock(profileStatus([
        profile("empty", 100, 10),
        profile("usable", 0, 0)
      ])) as never,
      createProfileRuntime: ({ profile }) => {
        const mockRuntime = new MockAgentRuntime(profile.name);
        runtimes.set(profile.name, mockRuntime);
        return mockRuntime;
      }
    });

    await expect(runtime.submitInput({
      session,
      input: [],
      inputId: "input-1",
      source: "slack_user"
    })).rejects.toBeInstanceOf(AuthProfileUnavailableError);

    expect(runtimes.size).toBe(0);
    expect(sessions.get(session.key)?.authProfileName).toBe("empty");
  });
});

class MockAgentRuntime extends EventEmitter implements AgentRuntime {
  readonly ensureSession = vi.fn(async (session: SlackSessionRecord): Promise<AgentSession> => ({
    id: `${this.profileName}-thread`,
    brokerSessionKey: session.key,
    runtime: "codex-app-server",
    createdAt: "2026-05-09T00:00:00.000Z"
  }));
  readonly submitInput = vi.fn(async (input: SubmitAgentInput): Promise<AgentSubmitInputResult> => ({
    receipt: {
      agentSessionId: `${this.profileName}-thread`,
      turnId: `${this.profileName}-turn`,
      inputId: input.inputId,
      delivery: "started_turn",
      deliveredAt: "2026-05-09T00:00:00.000Z"
    },
    completion: Promise.resolve({
      agentSessionId: `${this.profileName}-thread`,
      turnId: `${this.profileName}-turn`,
      finalMessage: "",
      aborted: false
    })
  }));
  readonly interrupt = vi.fn(async () => undefined);
  readonly readSession = vi.fn(async () => null);
  readonly readTurn = vi.fn(async (): Promise<AgentTurnSnapshot | null> => null);
  readonly start = vi.fn(async () => undefined);
  readonly stop = vi.fn(async () => undefined);
  readonly setSlackBotIdentity = vi.fn((_identity: SlackUserIdentity | null) => undefined);

  constructor(private readonly profileName: string) {
    super();
  }

  getCapabilities(): AgentRuntimeCapabilities {
    return {
      submitWhileActive: true,
      interrupt: true,
      readTurn: true,
      readSession: true,
      rawEvents: true,
      tokenUsage: "exact",
      toolCalls: true,
      systemPromptEcho: true
    };
  }
}

function createSession(patch: Partial<SlackSessionRecord> = {}): SlackSessionRecord {
  return {
    key: "C123:111.222",
    channelId: "C123",
    rootThreadTs: "111.222",
    workspacePath: "/tmp/workspace",
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
    ...patch
  };
}

function createSessionManagerMock(initial: SlackSessionRecord) {
  const sessions = new Map<string, SlackSessionRecord>([[initial.key, initial]]);
  return {
    get: (key: string) => sessions.get(key),
    getSessionByKey: vi.fn((key: string) => sessions.get(key)),
    listSessions: vi.fn(() => [...sessions.values()]),
    setSessionAuthProfile: vi.fn(async (sessionKey: string, profileName: string) => {
      const existing = sessions.get(sessionKey);
      if (!existing) throw new Error(`Unknown session: ${sessionKey}`);
      const updated = {
        ...existing,
        authProfileName: profileName,
        authProfileBoundAt: "2026-05-09T00:00:01.000Z",
        updatedAt: "2026-05-09T00:00:01.000Z"
      };
      sessions.set(sessionKey, updated);
      return updated;
    })
  };
}

function authProfilesMock(status: AuthProfilesStatus) {
  return {
    listProfilesStatus: vi.fn(async () => status)
  };
}

function profileStatus(profiles: readonly AuthProfileSummary[]): AuthProfilesStatus {
  return {
    managedRoot: "/tmp/auth-profiles",
    profilesRoot: "/tmp/auth-profiles/docker/profiles",
    activeProfile: profiles[0]?.name ?? null,
    activeAuthPath: "/tmp/codex-home/auth.json",
    profiles
  };
}

function profile(name: string, primaryUsed: number, secondaryUsed: number): AuthProfileSummary {
  return {
    name,
    path: `/tmp/auth-profiles/docker/profiles/${name}.json`,
    active: false,
    source: "probe",
    checkedAt: "2026-05-09T00:00:00.000Z",
    account: {
      ok: true,
      account: {
        email: `${name}@example.com`,
        type: "chatgpt",
        planType: "pro"
      },
      requiresOpenaiAuth: false
    },
    rateLimits: {
      ok: true,
      rateLimits: {
        limitId: "codex",
        limitName: "Codex",
        primary: {
          usedPercent: primaryUsed,
          windowDurationMins: 300,
          resetsAt: 1_779_000_000
        },
        secondary: {
          usedPercent: secondaryUsed,
          windowDurationMins: 10_080,
          resetsAt: 1_780_000_000
        },
        credits: null,
        planType: "pro"
      },
      rateLimitsByLimitId: {}
    }
  };
}
