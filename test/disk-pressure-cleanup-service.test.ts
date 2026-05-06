import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import { DiskPressureCleanupService } from "../src/services/disk-pressure-cleanup-service.js";
import { SessionManager } from "../src/services/session-manager.js";
import { StateStore } from "../src/store/state-store.js";
import { fileExists } from "../src/utils/fs.js";

describe("DiskPressureCleanupService", () => {
  it("removes old raw logs and inactive sessions when disk space is low", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-cleanup-"));
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      DATA_ROOT: dataRoot,
      DISK_CLEANUP_MIN_FREE_BYTES: "100",
      DISK_CLEANUP_TARGET_FREE_BYTES: "100",
      DISK_CLEANUP_INACTIVE_SESSION_MS: String(24 * 60 * 60 * 1000),
      DISK_CLEANUP_JOB_PROTECTION_MS: String(48 * 60 * 60 * 1000),
      DISK_CLEANUP_OLD_LOG_MS: String(24 * 60 * 60 * 1000)
    } as NodeJS.ProcessEnv);

    const stateStore = new StateStore(config.stateDir, config.sessionsRoot);
    const sessions = new SessionManager({
      stateStore,
      sessionsRoot: config.sessionsRoot
    });
    await sessions.load();

    const oldAt = "2026-01-01T00:00:00.000Z";
    const now = new Date("2026-04-25T00:00:00.000Z");
    const inactive = await sessions.ensureSession("COLD", "100.000");
    await stateStore.upsertSession({
      ...inactive,
      createdAt: oldAt,
      updatedAt: oldAt
    });
    await fs.writeFile(path.join(inactive.workspacePath, "large.txt"), "old session data");

    const active = await sessions.ensureSession("CACTIVE", "200.000");
    await stateStore.upsertSession({
      ...active,
      activeTurnId: "turn-active",
      activeTurnStartedAt: oldAt,
      createdAt: oldAt,
      updatedAt: oldAt
    });
    await fs.writeFile(path.join(active.workspacePath, "large.txt"), "active session data");

    const pending = await sessions.ensureSession("CPENDING", "300.000");
    await stateStore.upsertSession({
      ...pending,
      createdAt: oldAt,
      updatedAt: oldAt
    });
    await sessions.upsertInboundMessage({
      key: "pending-1",
      sessionKey: pending.key,
      channelId: pending.channelId,
      rootThreadTs: pending.rootThreadTs,
      messageTs: "300.100",
      source: "thread_reply",
      userId: "U1",
      text: "still needs processing",
      status: "pending",
      createdAt: oldAt,
      updatedAt: oldAt
    });
    await fs.writeFile(path.join(pending.workspacePath, "large.txt"), "pending session data");

    const protectedJobSession = await sessions.ensureSession("CJOB", "400.000");
    const protectedJobActivityAt = new Date(now.getTime() - 36 * 60 * 60 * 1000).toISOString();
    await stateStore.upsertSession({
      ...protectedJobSession,
      createdAt: protectedJobActivityAt,
      updatedAt: protectedJobActivityAt
    });
    await fs.writeFile(path.join(protectedJobSession.workspacePath, "large.txt"), "protected job session data");
    await fs.mkdir(path.join(config.jobsRoot, "job-protected"), { recursive: true });
    await fs.writeFile(path.join(config.jobsRoot, "job-protected", "run.sh"), "#!/bin/sh\nsleep 30\n");
    await sessions.upsertBackgroundJob({
      id: "job-protected",
      token: "token-protected",
      sessionKey: protectedJobSession.key,
      channelId: protectedJobSession.channelId,
      rootThreadTs: protectedJobSession.rootThreadTs,
      kind: "watch_ci",
      shell: "sh",
      cwd: protectedJobSession.workspacePath,
      scriptPath: path.join(config.jobsRoot, "job-protected", "run.sh"),
      restartOnBoot: true,
      status: "running",
      createdAt: protectedJobActivityAt,
      updatedAt: now.toISOString(),
      heartbeatAt: now.toISOString()
    });

    const staleJobSession = await sessions.ensureSession("CSTALEJOB", "500.000");
    const staleJobActivityAt = new Date(now.getTime() - 60 * 60 * 60 * 1000).toISOString();
    await stateStore.upsertSession({
      ...staleJobSession,
      createdAt: staleJobActivityAt,
      updatedAt: staleJobActivityAt
    });
    await fs.writeFile(path.join(staleJobSession.workspacePath, "large.txt"), "stale job session data");
    await fs.mkdir(path.join(config.jobsRoot, "job-stale"), { recursive: true });
    await fs.writeFile(path.join(config.jobsRoot, "job-stale", "run.sh"), "#!/bin/sh\nsleep 30\n");
    await sessions.upsertBackgroundJob({
      id: "job-stale",
      token: "token-stale",
      sessionKey: staleJobSession.key,
      channelId: staleJobSession.channelId,
      rootThreadTs: staleJobSession.rootThreadTs,
      kind: "watch_ci",
      shell: "sh",
      cwd: staleJobSession.workspacePath,
      scriptPath: path.join(config.jobsRoot, "job-stale", "run.sh"),
      restartOnBoot: true,
      status: "running",
      createdAt: staleJobActivityAt,
      updatedAt: now.toISOString(),
      heartbeatAt: now.toISOString()
    });

    const rawLogDir = path.join(config.logDir, "raw");
    await fs.mkdir(rawLogDir, { recursive: true });
    const rawLogPath = path.join(rawLogDir, "codex-rpc.jsonl");
    const compressedRawLogPath = path.join(rawLogDir, "codex-rpc.jsonl.gz");
    await fs.writeFile(rawLogPath, "{\"old\":true}\n");
    await fs.writeFile(compressedRawLogPath, "compressed");
    await fs.utimes(rawLogPath, new Date(oldAt), new Date(oldAt));
    await fs.utimes(compressedRawLogPath, new Date(oldAt), new Date(oldAt));

    const cancelJob = vi.fn(async () => undefined);
    const cleanup = new DiskPressureCleanupService({
      config,
      sessions,
      jobTerminator: {
        cancelJob
      },
      now: () => now,
      statFs: async () => ({
        freeBytes: 0,
        totalBytes: 1000
      })
    });

    const result = await cleanup.runOnce("test");

    expect(result.deletedLogs.map((entry) => path.basename(entry.path)).sort()).toEqual([
      "codex-rpc.jsonl",
      "codex-rpc.jsonl.gz"
    ]);
    expect(result.deletedSessions.map((entry) => entry.key)).toEqual(expect.arrayContaining([
      inactive.key,
      active.key,
      pending.key,
      staleJobSession.key
    ]));
    expect(cancelJob).toHaveBeenCalledWith("job-stale", undefined, {
      skipTokenCheck: true,
      skipEvent: true
    });
    expect(cancelJob).not.toHaveBeenCalledWith("job-protected", expect.anything(), expect.anything());
    expect(sessions.getSessionByKey(inactive.key)).toBeUndefined();
    expect(sessions.getSessionByKey(active.key)).toBeUndefined();
    expect(sessions.getSessionByKey(pending.key)).toBeUndefined();
    expect(sessions.getSessionByKey(staleJobSession.key)).toBeUndefined();
    expect(await fileExists(path.dirname(inactive.workspacePath))).toBe(false);
    expect(await fileExists(path.dirname(active.workspacePath))).toBe(false);
    expect(await fileExists(path.dirname(pending.workspacePath))).toBe(false);
    expect(await fileExists(path.dirname(staleJobSession.workspacePath))).toBe(false);
    expect(await fileExists(path.join(config.jobsRoot, "job-stale"))).toBe(false);
    expect(await fileExists(rawLogPath)).toBe(false);
    expect(await fileExists(compressedRawLogPath)).toBe(false);

    expect(sessions.getSessionByKey(protectedJobSession.key)).toBeDefined();
    expect(await fileExists(path.dirname(protectedJobSession.workspacePath))).toBe(true);
    expect(await fileExists(path.join(config.jobsRoot, "job-protected"))).toBe(true);
  });
});
