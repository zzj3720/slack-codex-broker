import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createHttpHandler } from "../src/http/router.js";
import { AdminService } from "../src/services/admin-service.js";
import { SessionManager } from "../src/services/session-manager.js";
import { StateStore } from "../src/store/state-store.js";
import type { AppConfig } from "../src/config.js";

describe("admin realtime e2e", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("streams durable events written by a separate state-store writer", async () => {
    const fixture = await startAdminFixture();
    const controller = new AbortController();
    const eventPromise = readSseEvent(`${fixture.baseUrl}/admin/api/events?after=0`, controller.signal);

    await delay(25);
    const writerStore = new StateStore(fixture.config.stateDir, fixture.config.sessionsRoot);
    await writerStore.load();
    cleanups.push(async () => {
      writerStore.close();
    });
    await writerStore.upsertSession({
      key: "C123:111.222",
      channelId: "C123",
      channelName: "ops",
      rootThreadTs: "111.222",
      workspacePath: path.join(fixture.config.sessionsRoot, "C123-111-222", "workspace"),
      createdAt: "2026-05-09T00:00:00.000Z",
      updatedAt: "2026-05-09T00:00:01.000Z",
      activeTurnId: "turn-1"
    });

    const message = await eventPromise;
    controller.abort();
    expect(message.event).toBe("admin-event");
    expect(message.id).toBe("1");
    expect(message.data).toMatchObject({
      ok: true,
      event: {
        sequence: 1,
        kind: "session.upsert",
        sessionKey: "C123:111.222",
        session: {
          key: "C123:111.222",
          channelLabel: "#ops",
          activeTurnId: "turn-1"
        }
      }
    });
  });

  it("starts zero-cursor streams from the current tail instead of replaying retained events", async () => {
    const fixture = await startAdminFixture();
    await fixture.sessions.ensureSession("COLD", "100.000", {
      channelName: "old"
    });

    const controller = new AbortController();
    const eventPromise = readSseEvent(`${fixture.baseUrl}/admin/api/events?after=0`, controller.signal);

    await delay(25);
    const writerStore = new StateStore(fixture.config.stateDir, fixture.config.sessionsRoot);
    await writerStore.load();
    cleanups.push(async () => {
      writerStore.close();
    });
    await writerStore.upsertSession({
      key: "CNEW:200.000",
      channelId: "CNEW",
      channelName: "new",
      rootThreadTs: "200.000",
      workspacePath: path.join(fixture.config.sessionsRoot, "CNEW-200-000", "workspace"),
      createdAt: "2026-05-09T00:00:02.000Z",
      updatedAt: "2026-05-09T00:00:03.000Z"
    });

    const message = await eventPromise;
    controller.abort();
    expect(message.id).toBe("2");
    expect(message.data).toMatchObject({
      ok: true,
      event: {
        sequence: 2,
        kind: "session.upsert",
        sessionKey: "CNEW:200.000"
      }
    });
  });

  it("replays missed events from the supplied cursor", async () => {
    const fixture = await startAdminFixture();
    await fixture.sessions.ensureSession("C123", "111.222", {
      channelName: "ops"
    });
    await fixture.sessions.upsertAgentTraceEvent({
      id: "trace-1",
      sessionKey: "C123:111.222",
      source: "agent_runtime",
      type: "agent_tool_call",
      at: "2026-05-09T00:00:01.000Z",
      sequence: 1,
      title: "工具调用",
      summary: "exec_command",
      detail: "{\"cmd\":\"pnpm test\"}",
      status: "running",
      role: "assistant",
      toolName: "exec_command",
      callId: "call-1",
      turnId: "turn-1",
      createdAt: "2026-05-09T00:00:01.000Z",
      updatedAt: "2026-05-09T00:00:01.000Z"
    });

    const controller = new AbortController();
    const message = await readSseEvent(`${fixture.baseUrl}/admin/api/events?after=1`, controller.signal);
    controller.abort();
    expect(message.id).toBe("2");
    expect(message.data).toMatchObject({
      ok: true,
      event: {
        sequence: 2,
        kind: "trace.append",
        sessionKey: "C123:111.222",
        timelineEvent: {
          type: "agent_tool_call",
          toolName: "exec_command",
          detailAvailable: true
        }
      }
    });
    expect((message.data.event as Record<string, unknown>).timelineEvent).not.toHaveProperty("detail");
    const event = message.data.event as Record<string, unknown>;
    expect(event.trace).toBeUndefined();
    expect(event.session).toBeUndefined();
  });

  it("uses Last-Event-ID instead of the original after query on SSE reconnect", async () => {
    const fixture = await startAdminFixture();
    await fixture.sessions.ensureSession("COLD1", "100.000", {
      channelName: "old-one"
    });
    await fixture.sessions.ensureSession("COLD2", "200.000", {
      channelName: "old-two"
    });

    const controller = new AbortController();
    const eventPromise = readSseEvent(`${fixture.baseUrl}/admin/api/events?after=1`, controller.signal, {
      "last-event-id": "2"
    });

    await delay(25);
    await fixture.sessions.ensureSession("CNEW", "300.000", {
      channelName: "new"
    });

    const message = await eventPromise;
    controller.abort();
    expect(message.id).toBe("3");
    expect(message.data).toMatchObject({
      ok: true,
      event: {
        sequence: 3,
        kind: "session.upsert",
        sessionKey: "CNEW:300.000"
      }
    });
  });

  async function startAdminFixture(): Promise<{
    readonly baseUrl: string;
    readonly config: AppConfig;
    readonly sessions: SessionManager;
  }> {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-realtime-"));
    cleanups.push(async () => {
      await fs.rm(dataRoot, { force: true, recursive: true });
    });

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      DATA_ROOT: dataRoot,
      SERVICE_ROOT: dataRoot,
      ADMIN_LAUNCHD_LABEL: "admin.test",
      WORKER_LAUNCHD_LABEL: "worker.test",
      ADMIN_PLIST_PATH: path.join(dataRoot, "admin.plist"),
      WORKER_PLIST_PATH: path.join(dataRoot, "worker.plist")
    } as NodeJS.ProcessEnv);
    await fs.mkdir(config.codexHome, { recursive: true });
    await fs.mkdir(config.logDir, { recursive: true });

    const stateStore = new StateStore(config.stateDir, config.sessionsRoot);
    const sessions = new SessionManager({
      stateStore,
      sessionsRoot: config.sessionsRoot
    });
    await sessions.load();
    cleanups.push(async () => {
      stateStore.close();
    });

    const adminService = new AdminService({
      config,
      sessions,
      startedAt: new Date("2026-05-09T00:00:00.000Z"),
      authProfiles: {
        listProfilesStatus: async () => ({
          managedRoot: path.join(dataRoot, "auth-profiles"),
          profilesRoot: path.join(dataRoot, "auth-profiles", "docker", "profiles"),
          profiles: []
        }),
        addProfile: async () => ({ name: "profile" }),
        deleteProfile: async () => {}
      } as never,
      githubAuthorMappings: {
        load: async () => {},
        listMappings: () => [],
        upsertManualMapping: async () => ({}),
        deleteMapping: async () => {}
      } as never,
      runtime: {
        restartRuntime: async () => {},
        readAccountSummary: async () => ({
          account: {
            email: "admin@example.com",
            type: "chatgpt",
            planType: "team"
          },
          requiresOpenaiAuth: false
        }),
        readAccountRateLimits: async () => ({
          rateLimits: null,
          rateLimitsByLimitId: {}
        })
      } as never,
      deployment: {
        getStatus: async () => ({ ok: true }),
        deploy: async () => ({ ok: true }),
        rollback: async () => ({ ok: true }),
        restartWorker: async () => {}
      } as never
    });

    const server = http.createServer(
      createHttpHandler({
        adminService,
        config
      })
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to start admin fixture");
    }

    return {
      baseUrl: `http://127.0.0.1:${address.port}`,
      config,
      sessions
    };
  }
});

async function readSseEvent(url: string, signal: AbortSignal, extraHeaders: Record<string, string> = {}): Promise<{
  readonly event: string;
  readonly id: string;
  readonly data: Record<string, unknown>;
}> {
  const response = await fetch(url, {
    headers: {
      accept: "text/event-stream",
      ...extraHeaders
    },
    signal
  });
  expect(response.ok).toBe(true);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  if (!response.body) {
    throw new Error("missing response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 5_000) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      buffer += decoder.decode(result.value, { stream: true });
      const index = buffer.indexOf("\n\n");
      if (index < 0) {
        continue;
      }
      const block = buffer.slice(0, index);
      const lines = block.split("\n");
      const event = lines.find((line) => line.startsWith("event:"))?.slice("event:".length).trim() || "message";
      const id = lines.find((line) => line.startsWith("id:"))?.slice("id:".length).trim() || "";
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n");
      if (!data) {
        continue;
      }
      return {
        event,
        id,
        data: JSON.parse(data) as Record<string, unknown>
      };
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  throw new Error(`timed out waiting for SSE event from ${url}`);
}
