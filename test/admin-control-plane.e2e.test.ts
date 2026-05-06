import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createHttpHandler } from "../src/http/router.js";
import { AdminService } from "../src/services/admin-service.js";
import { SessionManager } from "../src/services/session-manager.js";
import { StateStore } from "../src/store/state-store.js";
import type { AppConfig } from "../src/config.js";
import type { PersistedBackgroundJob, PersistedInboundMessage } from "../src/types.js";

describe("admin control plane e2e", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("exposes overview, sessions, timeline, and preflight as separate control-plane resources", async () => {
    const { baseUrl, sessions } = await startAdminFixture();
    await seedActiveSession(sessions);

    const overview = await readJson(`${baseUrl}/admin/api/overview`);
    expect(overview).toMatchObject({
      ok: true,
      state: {
        activeCount: 1,
        openInboundCount: 1,
        runningBackgroundJobCount: 1
      }
    });
    expect((overview.state as Record<string, unknown>).sessions).toBeUndefined();
    expect((overview.state as Record<string, unknown>).recentBrokerLogs).toBeUndefined();

    const sessionList = await readJson(`${baseUrl}/admin/api/sessions`);
    expect(sessionList).toMatchObject({
      ok: true,
      sessions: [
        {
          key: "C123:111.222",
          activeTurnId: "turn-1",
          openInboundCount: 1,
          runningBackgroundJobCount: 1
        }
      ]
    });

    const timeline = await readJson(`${baseUrl}/admin/api/sessions/${encodeURIComponent("C123:111.222")}/timeline`);
    expect(timeline).toMatchObject({
      ok: true,
      session: {
        key: "C123:111.222",
        lastTurnSignalKind: "wait"
      }
    });
    expect((timeline.events as Array<{ type: string; summary?: string }>).map((event) => event.type)).toEqual([
      "session_created",
      "inbound_message",
      "background_job",
      "turn_signal"
    ]);
    expect(timeline.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "inbound_message",
          status: "pending",
          summary: "follow up"
        }),
        expect.objectContaining({
          type: "background_job",
          status: "running",
          summary: "watch_ci"
        }),
        expect.objectContaining({
          type: "turn_signal",
          status: "wait",
          summary: "waiting on CI"
        })
      ])
    );

    const preflight = await readJson(`${baseUrl}/admin/api/preflight?operation=deploy`);
    expect(preflight).toMatchObject({
      ok: true,
      operation: "deploy",
      safe: false,
      requiresAllowActive: true,
      activeCount: 1,
      openInboundCount: 1,
      runningBackgroundJobCount: 1
    });
    expect(preflight.impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "active_turn", sessionKey: "C123:111.222" }),
        expect.objectContaining({ type: "open_inbound", sessionKey: "C123:111.222" }),
        expect.objectContaining({ type: "running_background_job", sessionKey: "C123:111.222" })
      ])
    );
  });

  it("records deploy requests as durable admin operations with audit events", async () => {
    const { baseUrl, deploymentCalls } = await startAdminFixture();

    const deploy = await postJson(`${baseUrl}/admin/api/deploy`, {
      ref: "main",
      allow_active: false
    });
    expect(deploy).toMatchObject({
      ok: true,
      operation: {
        kind: "deploy",
        status: "succeeded",
        request: {
          ref: "main"
        }
      }
    });
    expect(deploymentCalls).toEqual([{ kind: "deploy", ref: "main" }]);

    const operations = await readJson(`${baseUrl}/admin/api/operations`);
    expect(operations).toMatchObject({
      ok: true,
      operations: [
        {
          id: deploy.operation.id,
          kind: "deploy",
          status: "succeeded",
          request: {
            ref: "main"
          }
        }
      ]
    });

    const audit = await readJson(`${baseUrl}/admin/api/audit`);
    expect(audit).toMatchObject({
      ok: true,
      events: [
        {
          operationId: deploy.operation.id,
          action: "deploy",
          status: "succeeded"
        },
        {
          operationId: deploy.operation.id,
          action: "deploy",
          status: "started"
        }
      ]
    });
  });

  it("records refused deploy preflight checks as failed admin operations", async () => {
    const { baseUrl, deploymentCalls, sessions } = await startAdminFixture();
    await seedActiveSession(sessions);

    const response = await fetch(`${baseUrl}/admin/api/deploy`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ref: "main",
        allow_active: false
      })
    });
    const payload = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(500);
    expect(payload).toMatchObject({
      ok: false
    });
    expect(String(payload.error)).toContain("Refusing deploy");
    expect(deploymentCalls).toEqual([]);

    const operations = await readJson(`${baseUrl}/admin/api/operations`);
    expect(operations).toMatchObject({
      ok: true,
      operations: [
        {
          kind: "deploy",
          status: "failed",
          request: {
            ref: "main"
          }
        }
      ]
    });
    const operation = (operations.operations as Array<{ id: string }>)[0];
    expect(operation?.id).toBeTruthy();

    const audit = await readJson(`${baseUrl}/admin/api/audit`);
    expect(audit).toMatchObject({
      ok: true,
      events: [
        {
          operationId: operation?.id,
          action: "deploy",
          status: "failed"
        },
        {
          operationId: operation?.id,
          action: "deploy",
          status: "started"
        }
      ]
    });
  });

  async function startAdminFixture(): Promise<{
    readonly baseUrl: string;
    readonly sessions: SessionManager;
    readonly deploymentCalls: Array<Record<string, unknown>>;
  }> {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-control-plane-"));
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

    const deploymentCalls: Array<Record<string, unknown>> = [];
    const adminService = new AdminService({
      config,
      sessions,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
      authProfiles: {
        listProfilesStatus: async () => ({
          managedRoot: path.join(dataRoot, "auth-profiles"),
          profilesRoot: path.join(dataRoot, "auth-profiles", "docker", "profiles"),
          activeProfile: null,
          activeAuthPath: path.join(config.codexHome, "auth.json"),
          profiles: []
        }),
        addProfile: async () => ({ name: "profile" }),
        deleteProfile: async () => {},
        activateProfile: async (name: string) => ({ name })
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
        getStatus: async () => deploymentStatus(config),
        deploy: async ({ ref }: { readonly ref: string }) => {
          deploymentCalls.push({ kind: "deploy", ref });
          return deploymentStatus(config);
        },
        rollback: async ({ ref }: { readonly ref?: string | undefined }) => {
          deploymentCalls.push({ kind: "rollback", ref: ref ?? null });
          return deploymentStatus(config);
        },
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
      sessions,
      deploymentCalls
    };
  }
});

async function seedActiveSession(sessions: SessionManager): Promise<void> {
  const session = await sessions.ensureSession("C123", "111.222");
  await sessions.setActiveTurnId("C123", "111.222", "turn-1");
  await sessions.recordTurnSignal("C123", "111.222", {
    turnId: "turn-1",
    kind: "wait",
    reason: "waiting on CI",
    occurredAt: "2026-03-19T00:00:04.000Z"
  });
  await sessions.upsertInboundMessage(inboundMessage({
    sessionKey: session.key,
    status: "pending",
    text: "follow up",
    updatedAt: "2026-03-19T00:00:01.000Z"
  }));
  await sessions.upsertBackgroundJob(backgroundJob({
    sessionKey: session.key,
    status: "running",
    updatedAt: "2026-03-19T00:00:02.000Z",
    startedAt: "2026-03-19T00:00:02.000Z",
    heartbeatAt: "2026-03-19T00:00:03.000Z"
  }));
}

function inboundMessage(patch: Partial<PersistedInboundMessage>): PersistedInboundMessage {
  return {
    key: "C123:111.222:111.223",
    sessionKey: "C123:111.222",
    channelId: "C123",
    rootThreadTs: "111.222",
    messageTs: "111.223",
    source: "thread_reply",
    userId: "U123",
    text: "hello",
    status: "done",
    createdAt: "2026-03-19T00:00:01.000Z",
    updatedAt: "2026-03-19T00:00:01.000Z",
    ...patch
  };
}

function backgroundJob(patch: Partial<PersistedBackgroundJob>): PersistedBackgroundJob {
  return {
    id: "job-1",
    token: "job-token",
    sessionKey: "C123:111.222",
    channelId: "C123",
    rootThreadTs: "111.222",
    kind: "watch_ci",
    shell: "/bin/sh",
    cwd: "/tmp/workspace",
    scriptPath: "/tmp/job.sh",
    restartOnBoot: true,
    status: "registered",
    createdAt: "2026-03-19T00:00:02.000Z",
    updatedAt: "2026-03-19T00:00:02.000Z",
    ...patch
  };
}

function deploymentStatus(config: AppConfig): Record<string, unknown> {
  return {
    serviceRoot: config.serviceRoot ?? "",
    repoRoot: config.serviceRoot ?? "",
    repoUrl: "https://github.com/HOOLC/slack-codex-broker.git",
    currentRelease: {
      linkPath: config.currentReleasePath ?? "",
      targetPath: path.join(config.serviceRoot ?? "", "releases", "current"),
      exists: true,
      metadata: {
        revision: "abc123",
        shortRevision: "abc123",
        branch: "main",
        builtAt: "2026-03-19T00:00:00.000Z",
        builtBy: "test",
        builtFromHost: "test-host",
        stateSchemaVersion: 1
      }
    },
    previousRelease: {
      linkPath: config.previousReleasePath ?? "",
      targetPath: null,
      exists: false,
      metadata: null
    },
    failedRelease: {
      linkPath: config.failedReleasePath ?? "",
      targetPath: null,
      exists: false,
      metadata: null
    },
    recentReleases: [],
    admin: {
      launchdLoaded: true,
      healthOk: true,
      healthBody: "{\"ok\":true}"
    },
    worker: {
      launchdLoaded: true,
      healthOk: true,
      readyOk: true,
      healthBody: "{\"ok\":true}",
      readyError: null
    }
  };
}

async function readJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url);
  const payload = await response.json() as Record<string, unknown>;
  expect(response.status).toBe(200);
  return payload;
}

async function postJson(url: string, body: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json() as Record<string, any>;
  expect(response.status).toBe(200);
  return payload;
}
