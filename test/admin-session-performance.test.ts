import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createHttpHandler } from "../src/http/router.js";
import { AdminService } from "../src/services/admin-service.js";
import { GitHubAuthorMappingService } from "../src/services/github-author-mapping-service.js";
import { SessionManager } from "../src/services/session-manager.js";
import { StateStore } from "../src/store/state-store.js";

describe("admin session performance contract", () => {
  const tempDirs: string[] = [];
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
    await Promise.all(
      tempDirs.splice(0).map((directory) =>
        fs.rm(directory, {
          force: true,
          recursive: true
        })
      )
    );
  });

  it("documents the summary and timeline pagination contract", async () => {
    const doc = await fs.readFile(new URL("../docs/admin-session-performance.md", import.meta.url), "utf8");
    expect(doc).toContain("/admin/api/sessions");
    expect(doc).toContain("before_sequence");
    expect(doc).toContain("per-session redundant");
    expect(doc).toContain("加载更早活动");
  });

  it("keeps session summaries off raw trace and turn-usage scans", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-session-summary-fast-"));
    tempDirs.push(dataRoot);
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      DATA_ROOT: dataRoot
    } as NodeJS.ProcessEnv);

    const service = new AdminService({
      config,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
      sessions: {
        listSessions: () => [
          {
            key: "C123:111.222",
            channelId: "C123",
            rootThreadTs: "111.222",
            workspacePath: "/tmp/session",
            createdAt: "2026-03-19T00:00:00.000Z",
            updatedAt: "2026-03-19T00:00:00.000Z"
          }
        ],
        listInboundMessages: () => [],
        listBackgroundJobs: () => [],
        listAgentSessionUsageSummaries: () => [
          {
            sessionKey: "C123:111.222",
            channelId: "C123",
            rootThreadTs: "111.222",
            turnCount: 1,
            exactTurns: 1,
            estimatedTurns: 0,
            missingTurns: 0,
            inputTokens: 10,
            cachedInputTokens: 4,
            outputTokens: 5,
            reasoningTokens: 1,
            totalTokens: 16,
            updatedAt: "2026-03-19T00:00:02.000Z",
            lastTurnAt: "2026-03-19T00:00:02.000Z",
            model: "test-model",
            effort: "low"
          }
        ],
        listAgentTurnUsage: () => {
          throw new Error("session summaries must not scan raw turn usage");
        },
        listAgentTraceEvents: () => {
          throw new Error("session summaries must not read trace events");
        },
        load: async () => {
          throw new Error("session summaries must not refresh session directories");
        }
      } as never,
      authProfiles: {
        listProfilesStatus: async () => ({
          managedRoot: path.join(dataRoot, "auth-profiles"),
          profilesRoot: path.join(dataRoot, "auth-profiles", "docker", "profiles"),
          profiles: []
        })
      } as never,
      githubAuthorMappings: {
        load: async () => {},
        listMappings: () => []
      } as never,
      runtime: {
        readAccountSummary: async () => ({
          account: null,
          requiresOpenaiAuth: true
        }),
        readAccountRateLimits: async () => ({
          rateLimits: null,
          rateLimitsByLimitId: {}
        })
      } as never
    });

    const summaries = await service.listSessionSummaries();
    expect(summaries).toMatchObject({
      sessions: [
        {
          key: "C123:111.222",
          usage: {
            totalTokens: 16,
            turnCount: 1
          }
        }
      ]
    });
  });

  it("serves timeline pages from newest to older with bounded responses", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-session-timeline-page-"));
    tempDirs.push(dataRoot);
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      DATA_ROOT: dataRoot
    } as NodeJS.ProcessEnv);
    await fs.mkdir(config.codexHome, { recursive: true });
    await fs.mkdir(config.logDir, { recursive: true });

    const stateStore = new StateStore(config.stateDir, config.sessionsRoot);
    const sessions = new SessionManager({
      stateStore,
      sessionsRoot: config.sessionsRoot
    });
    await sessions.load();
    await sessions.ensureSession("C123", "111.222");
    for (let index = 1; index <= 120; index += 1) {
      await sessions.upsertAgentTraceEvent({
        id: `trace-${index}`,
        sessionKey: "C123:111.222",
        source: "agent_runtime",
        type: "agent_assistant_message",
        at: new Date(Date.UTC(2030, 2, 19, 0, 0, index)).toISOString(),
        sequence: index,
        title: `event ${index}`,
        summary: `summary ${index}`,
        status: "completed",
        role: "assistant",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      });
    }

    const service = new AdminService({
      config,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
      sessions,
      authProfiles: {
        listProfilesStatus: async () => ({
          managedRoot: path.join(dataRoot, "auth-profiles"),
          profilesRoot: path.join(dataRoot, "auth-profiles", "docker", "profiles"),
          profiles: []
        })
      } as never,
      githubAuthorMappings: new GitHubAuthorMappingService({ stateDir: dataRoot }),
      runtime: {
        readAccountSummary: async () => ({
          account: null,
          requiresOpenaiAuth: true
        }),
        readAccountRateLimits: async () => ({
          rateLimits: null,
          rateLimitsByLimitId: {}
        })
      } as never
    });
    (sessions as unknown as { load: () => Promise<void> }).load = async () => {
      throw new Error("timeline reads must not refresh session directories");
    };

    const first = await service.getSessionTimeline("C123:111.222", { limit: 25 });
    const firstTraceSequences = (first.events as Array<Record<string, unknown>>)
      .map((event) => event.sequence)
      .filter((sequence): sequence is number => typeof sequence === "number");
    expect(first.events).toHaveLength(25);
    expect((first.events as Array<Record<string, unknown>>).map((event) => event.type)).toEqual(
      Array.from({ length: 25 }, () => "agent_assistant_message")
    );
    expect(firstTraceSequences.slice(0, 3)).toEqual([96, 97, 98]);
    expect(firstTraceSequences.at(-1)).toBe(120);
    expect(first.page).toMatchObject({
      limit: 25,
      hasMore: true,
      nextBeforeSequence: 96
    });
    expect(first.trace).toMatchObject({
      eventCount: 120,
      categories: {
        agent_assistant_message: 120
      }
    });

    const older = await service.getSessionTimeline("C123:111.222", { limit: 25, beforeSequence: 96 });
    const olderTraceSequences = (older.events as Array<Record<string, unknown>>)
      .map((event) => event.sequence)
      .filter((sequence): sequence is number => typeof sequence === "number");
    expect(olderTraceSequences.slice(0, 3)).toEqual([71, 72, 73]);
    expect(olderTraceSequences.at(-1)).toBe(95);
    expect(older.page).toMatchObject({
      hasMore: true,
      nextBeforeSequence: 71
    });
  });

  it("passes timeline pagination query parameters through the HTTP route", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const baseUrl = await startAdminServer({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test"
    } as NodeJS.ProcessEnv, {
      getSessionTimeline: async (sessionKey: string, options: Record<string, unknown>) => {
        calls.push({ sessionKey, ...options });
        return { ok: true, events: [], page: { limit: options.limit, hasMore: false } };
      }
    });

    const response = await fetch(`${baseUrl}/admin/api/sessions/${encodeURIComponent("C123:111.222")}/timeline?limit=25&before_sequence=96`);
    expect(response.status).toBe(200);
    expect(response.headers.get("server-timing")).toContain("session-timeline");
    expect(Number(response.headers.get("x-admin-duration-ms"))).toBeGreaterThanOrEqual(0);
    await response.json();
    expect(calls).toEqual([
      {
        sessionKey: "C123:111.222",
        limit: 25,
        beforeSequence: 96
      }
    ]);
  });

  it("keeps the React timeline request bounded and exposes load-older UI", async () => {
    const source = await fs.readFile(new URL("../src/admin-ui/session-view.tsx", import.meta.url), "utf8");
    expect(source).toContain("TIMELINE_PAGE_SIZE");
    expect(source).toContain("before_sequence");
    expect(source).toContain("加载更早活动");
  });

  async function startAdminServer(configEnv: NodeJS.ProcessEnv, adminService: Record<string, unknown>): Promise<string> {
    const config = loadConfig(configEnv);
    const server = http.createServer(
      createHttpHandler({
        adminService: adminService as never,
        bridge: {} as never,
        isolatedMcp: {} as never,
        jobManager: {} as never,
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
      throw new Error("failed to start test server");
    }
    return `http://127.0.0.1:${address.port}`;
  }
});
