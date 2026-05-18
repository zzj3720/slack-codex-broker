import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createHttpHandler } from "../src/http/router.js";
import { getJobLogDirectory, getSessionLogDirectory } from "../src/logger.js";
import { AdminService } from "../src/services/admin-service.js";
import { SessionManager } from "../src/services/session-manager.js";
import { StateStore } from "../src/store/state-store.js";

describe("admin session delete API e2e", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("cancels jobs through the worker, stops the worker session, and removes persisted artifacts", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-session-delete-e2e-"));
    cleanups.push(async () => {
      await fs.rm(dataRoot, {
        recursive: true,
        force: true
      });
    });

    const baseEnv = {
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      DATA_ROOT: dataRoot
    } as NodeJS.ProcessEnv;
    const workerConfig = loadConfig(baseEnv);
    const stateStore = new StateStore(workerConfig.stateDir, workerConfig.sessionsRoot);
    const sessions = new SessionManager({
      stateStore,
      sessionsRoot: workerConfig.sessionsRoot
    });
    await sessions.load();

    const session = await sessions.ensureSession("C123", "111.222");
    await sessions.setAgentSessionId(session.channelId, session.rootThreadTs, "agent-session-1");
    await sessions.setActiveTurnId(session.channelId, session.rootThreadTs, "turn-1");
    await fs.writeFile(path.join(session.workspacePath, "marker.txt"), "owned workspace", "utf8");
    await sessions.upsertInboundMessage({
      key: `${session.key}:111.223`,
      sessionKey: session.key,
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs,
      messageTs: "111.223",
      source: "thread_reply",
      userId: "U123",
      text: "pending work",
      status: "pending",
      createdAt: "2026-05-18T00:00:01.000Z",
      updatedAt: "2026-05-18T00:00:01.000Z"
    });

    const jobDir = path.join(workerConfig.jobsRoot, "job-1");
    await fs.mkdir(jobDir, { recursive: true });
    await fs.writeFile(path.join(jobDir, "run.sh"), "#!/bin/sh\nsleep 60\n", "utf8");
    await sessions.upsertBackgroundJob({
      id: "job-1",
      token: "token-1",
      sessionKey: session.key,
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs,
      kind: "watch_ci",
      shell: "sh",
      cwd: session.workspacePath,
      scriptPath: path.join(jobDir, "run.sh"),
      restartOnBoot: true,
      status: "running",
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z"
    });
    const failedCancelJobDir = path.join(workerConfig.jobsRoot, "job-cancel-fails");
    await fs.mkdir(failedCancelJobDir, { recursive: true });
    await fs.writeFile(path.join(failedCancelJobDir, "run.sh"), "#!/bin/sh\nsleep 60\n", "utf8");
    await sessions.upsertBackgroundJob({
      id: "job-cancel-fails",
      token: "token-2",
      sessionKey: session.key,
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs,
      kind: "watch_review",
      shell: "sh",
      cwd: session.workspacePath,
      scriptPath: path.join(failedCancelJobDir, "run.sh"),
      restartOnBoot: true,
      status: "running",
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z"
    });

    const sessionLogDir = getSessionLogDirectory(workerConfig.logDir, session.key);
    const jobLogDir = getJobLogDirectory(workerConfig.logDir, "job-1");
    const failedCancelJobLogDir = getJobLogDirectory(workerConfig.logDir, "job-cancel-fails");
    await fs.mkdir(sessionLogDir, { recursive: true });
    await fs.mkdir(jobLogDir, { recursive: true });
    await fs.mkdir(failedCancelJobLogDir, { recursive: true });
    await fs.writeFile(path.join(sessionLogDir, "2026-05-18-00.jsonl"), "{}\n", "utf8");
    await fs.writeFile(path.join(jobLogDir, "2026-05-18-00.jsonl"), "{}\n", "utf8");
    await fs.writeFile(path.join(failedCancelJobLogDir, "2026-05-18-00.jsonl"), "{}\n", "utf8");

    const workerCalls: Array<Record<string, unknown>> = [];
    const workerBaseUrl = await startServer(createHttpHandler({
      bridge: {
        deleteSession: async (sessionKey: string) => {
          workerCalls.push({
            type: "deleteSession",
            sessionKey
          });
          const existing = sessions.getSessionByKey(sessionKey);
          const deleted = await sessions.deleteSessionByKey(sessionKey);
          return {
            deleted,
            interruptedActiveTurn: Boolean(existing?.activeTurnId),
            previousAgentSessionId: existing?.agentSessionId ?? null,
            previousActiveTurnId: existing?.activeTurnId ?? null,
            clearedInboundCount: 1
          };
        }
      } as never,
      jobManager: {
        cancelJobFromAdmin: async (jobId: string, options: { sessionKey: string }) => {
          workerCalls.push({
            type: "cancelJob",
            jobId,
            sessionKey: options.sessionKey
          });
          if (jobId === "job-cancel-fails") {
            throw new Error("simulated_cancel_failure");
          }
          const job = sessions.getBackgroundJob(jobId);
          if (!job || job.sessionKey !== options.sessionKey) {
            throw new Error("job_session_mismatch");
          }
          const updated = {
            ...job,
            status: "cancelled" as const,
            cancelledAt: "2026-05-18T00:00:01.000Z",
            completedAt: "2026-05-18T00:00:01.000Z"
          };
          await sessions.upsertBackgroundJob(updated);
          return updated;
        }
      } as never,
      config: workerConfig
    }));
    cleanups.push(async () => {
      await stopServer(workerBaseUrl.server);
    });

    const adminConfig = loadConfig({
      ...baseEnv,
      WORKER_BASE_URL: workerBaseUrl.baseUrl
    } as NodeJS.ProcessEnv);
    const adminService = new AdminService({
      config: adminConfig,
      startedAt: new Date("2026-05-18T00:00:00.000Z"),
      sessions,
      authProfiles: {
        listProfilesStatus: async () => ({
          managedRoot: path.join(dataRoot, "auth-profiles"),
          profilesRoot: path.join(dataRoot, "auth-profiles", "profiles"),
          activeProfile: null,
          activeAuthPath: path.join(adminConfig.codexHome, "auth.json"),
          profiles: []
        })
      } as never,
      githubAuthorMappings: {
        load: async () => {},
        listMappings: () => []
      } as never,
      runtime: {
        restartRuntime: async () => {},
        readAccountSummary: async () => ({
          account: {
            email: "ops@example.com",
            type: "chatgpt",
            planType: "team"
          },
          requiresOpenaiAuth: false
        }),
        readAccountRateLimits: async () => ({
          rateLimits: null,
          rateLimitsByLimitId: {}
        })
      } as never
    });
    const adminBaseUrl = await startServer(createHttpHandler({
      adminService,
      config: adminConfig
    }));
    cleanups.push(async () => {
      await stopServer(adminBaseUrl.server);
    });

    const response = await fetch(`${adminBaseUrl.baseUrl}/admin/api/sessions/${encodeURIComponent(session.key)}`, {
      method: "DELETE"
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      sessionKey: session.key,
      cancelledJobCount: 1,
      failedJobCancelCount: 1,
      cancelledJobs: [
        {
          id: "job-1",
          ok: true
        },
        {
          id: "job-cancel-fails",
          ok: false,
          error: "simulated_cancel_failure"
        }
      ],
      workerDelete: {
        ok: true,
        delete: {
          interruptedActiveTurn: true,
          previousAgentSessionId: "agent-session-1",
          previousActiveTurnId: "turn-1"
        }
      }
    });
    expect(workerCalls).toEqual([
      {
        type: "cancelJob",
        jobId: "job-1",
        sessionKey: session.key
      },
      {
        type: "cancelJob",
        jobId: "job-cancel-fails",
        sessionKey: session.key
      },
      {
        type: "deleteSession",
        sessionKey: session.key
      }
    ]);
    expect(sessions.getSessionByKey(session.key)).toBeUndefined();
    expect(sessions.getBackgroundJob("job-1")).toBeUndefined();
    expect(sessions.getBackgroundJob("job-cancel-fails")).toBeUndefined();
    await expect(fs.access(path.dirname(session.workspacePath))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(jobDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(failedCancelJobDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(sessionLogDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(jobLogDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(failedCancelJobLogDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function startServer(handler: http.RequestListener): Promise<{
  readonly server: http.Server;
  readonly baseUrl: string;
}> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to start test server");
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

async function stopServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
