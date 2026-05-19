import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import { getJobLogDirectory, getSessionLogDirectory, logger } from "../src/logger.js";
import { DiskPressureCleanupService } from "../src/services/disk-pressure-cleanup-service.js";
import { SessionManager } from "../src/services/session-manager.js";
import { StateStore } from "../src/store/state-store.js";
import type { PersistedBackgroundJobStatus } from "../src/types.js";
import { fileExists } from "../src/utils/fs.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("DiskPressureCleanupService", () => {
  it("dry-runs expired session cache cleanup by default and logs structured candidates", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-cache-dry-run-"));
    const infoSpy = vi.spyOn(logger, "info");

    try {
      const config = loadConfig({
        SLACK_APP_TOKEN: "xapp-test",
        SLACK_BOT_TOKEN: "xoxb-test",
        DATA_ROOT: dataRoot,
        DISK_CLEANUP_MIN_FREE_BYTES: "0",
        DISK_CLEANUP_TARGET_FREE_BYTES: "0",
        DISK_CLEANUP_SESSION_CACHE_TTL_MS: String(DAY_MS)
      } as NodeJS.ProcessEnv);
      const stateStore = new StateStore(config.stateDir, config.sessionsRoot);
      const sessions = new SessionManager({
        stateStore,
        sessionsRoot: config.sessionsRoot
      });
      await sessions.load();

      const now = new Date("2026-04-25T00:00:00.000Z");
      const oldAt = new Date(now.getTime() - 8 * DAY_MS).toISOString();
      const stale = await seedSession(sessions, stateStore, "CSTALECACHE", "100.000", oldAt);
      const derivedDataPath = path.join(stale.workspacePath, "frontend/macos/.build/DerivedData/file.o");
      const nodeModulesPath = path.join(stale.workspacePath, "web/node_modules/pkg/index.js");
      await writeSizedFile(derivedDataPath, 8);
      await writeSizedFile(nodeModulesPath, 9);

      const cleanup = new DiskPressureCleanupService({
        config,
        sessions,
        now: () => now,
        isDarwin: true,
        statFs: async () => ({
          freeBytes: 1000,
          totalBytes: 1000
        })
      });

      const result = await cleanup.runOnce("test");

      expect(result.dryRun).toBe(true);
      expect(result.cacheCandidateCount).toBe(2);
      expect(result.deletedCacheEntryCount).toBe(0);
      expect(await fileExists(path.dirname(derivedDataPath))).toBe(true);
      expect(await fileExists(path.dirname(nodeModulesPath))).toBe(true);
      expect(infoSpy).toHaveBeenCalledWith("Disk cleanup session cache candidate", expect.objectContaining({
        sessionKey: stale.key,
        path: path.join(stale.workspacePath, "frontend/macos/.build/DerivedData"),
        bytes: expect.any(Number),
        dryRun: true
      }));
    } finally {
      infoSpy.mockRestore();
      await fs.rm(dataRoot, { force: true, recursive: true });
    }
  });

  it("deletes expired cache artifacts while skipping active and protected sessions", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-cache-delete-"));
    const infoSpy = vi.spyOn(logger, "info");

    try {
      const config = loadConfig({
        SLACK_APP_TOKEN: "xapp-test",
        SLACK_BOT_TOKEN: "xoxb-test",
        DATA_ROOT: dataRoot,
        DISK_CLEANUP_DRY_RUN: "false",
        DISK_CLEANUP_MIN_FREE_BYTES: "0",
        DISK_CLEANUP_TARGET_FREE_BYTES: "0",
        DISK_CLEANUP_SESSION_CACHE_TTL_MS: String(DAY_MS)
      } as NodeJS.ProcessEnv);
      const stateStore = new StateStore(config.stateDir, config.sessionsRoot);
      const sessions = new SessionManager({
        stateStore,
        sessionsRoot: config.sessionsRoot
      });
      await sessions.load();

      const now = new Date("2026-04-25T00:00:00.000Z");
      const oldAt = new Date(now.getTime() - 8 * DAY_MS).toISOString();
      const stale = await seedSession(sessions, stateStore, "CSTALECACHE", "100.000", oldAt);
      const active = await seedSession(sessions, stateStore, "CACTIVECACHE", "200.000", oldAt, {
        activeTurnId: "turn-active",
        activeTurnStartedAt: oldAt
      });
      const protectedJob = await seedSession(sessions, stateStore, "CJOBCACHE", "300.000", oldAt);
      await seedJob(config.jobsRoot, sessions, {
        id: "job-cache-protected",
        status: "running",
        sessionKey: protectedJob.key,
        channelId: protectedJob.channelId,
        rootThreadTs: protectedJob.rootThreadTs,
        workspacePath: protectedJob.workspacePath,
        at: oldAt
      });

      const staleDerivedDataPath = path.join(stale.workspacePath, "frontend/macos/.build/DerivedData/file.o");
      const staleNodeModulesPath = path.join(stale.workspacePath, "web/node_modules/pkg/index.js");
      const activeNodeModulesPath = path.join(active.workspacePath, "web/node_modules/pkg/index.js");
      const protectedNodeModulesPath = path.join(protectedJob.workspacePath, "web/node_modules/pkg/index.js");
      await writeSizedFile(staleDerivedDataPath, 11);
      await writeSizedFile(staleNodeModulesPath, 12);
      await writeSizedFile(activeNodeModulesPath, 13);
      await writeSizedFile(protectedNodeModulesPath, 14);

      const cleanup = new DiskPressureCleanupService({
        config,
        sessions,
        now: () => now,
        isDarwin: true,
        statFs: async () => ({
          freeBytes: 1000,
          totalBytes: 1000
        })
      });

      const result = await cleanup.runOnce("test");

      expect(result.dryRun).toBe(false);
      expect(result.cacheCandidateCount).toBe(2);
      expect(result.deletedCacheEntryCount).toBe(2);
      expect(result.cacheReclaimedBytes).toBeGreaterThan(0);
      expect(await fileExists(path.join(stale.workspacePath, "frontend/macos/.build/DerivedData"))).toBe(false);
      expect(await fileExists(path.join(stale.workspacePath, "web/node_modules"))).toBe(false);
      expect(await fileExists(path.join(active.workspacePath, "web/node_modules"))).toBe(true);
      expect(await fileExists(path.join(protectedJob.workspacePath, "web/node_modules"))).toBe(true);
      expect(infoSpy).toHaveBeenCalledWith("Disk cleanup session cache deleted", expect.objectContaining({
        sessionKey: stale.key,
        path: path.join(stale.workspacePath, "web/node_modules"),
        bytes: expect.any(Number),
        dryRun: false
      }));
    } finally {
      infoSpy.mockRestore();
      await fs.rm(dataRoot, { force: true, recursive: true });
    }
  });

  it("guards macOS Xcode cache cleanup on non-Darwin platforms", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-cache-platform-"));

    try {
      const config = loadConfig({
        SLACK_APP_TOKEN: "xapp-test",
        SLACK_BOT_TOKEN: "xoxb-test",
        DATA_ROOT: dataRoot,
        DISK_CLEANUP_DRY_RUN: "false",
        DISK_CLEANUP_MIN_FREE_BYTES: "0",
        DISK_CLEANUP_TARGET_FREE_BYTES: "0",
        DISK_CLEANUP_SESSION_CACHE_TTL_MS: String(DAY_MS)
      } as NodeJS.ProcessEnv);
      const stateStore = new StateStore(config.stateDir, config.sessionsRoot);
      const sessions = new SessionManager({
        stateStore,
        sessionsRoot: config.sessionsRoot
      });
      await sessions.load();

      const now = new Date("2026-04-25T00:00:00.000Z");
      const oldAt = new Date(now.getTime() - 8 * DAY_MS).toISOString();
      const stale = await seedSession(sessions, stateStore, "CPLATFORM", "100.000", oldAt);
      await writeSizedFile(path.join(stale.workspacePath, "frontend/macos/.build/DerivedData/file.o"), 15);
      await writeSizedFile(path.join(stale.workspacePath, "web/node_modules/pkg/index.js"), 16);

      const cleanup = new DiskPressureCleanupService({
        config,
        sessions,
        now: () => now,
        isDarwin: false,
        statFs: async () => ({
          freeBytes: 1000,
          totalBytes: 1000
        })
      });

      const result = await cleanup.runOnce("test");

      expect(result.cacheCandidateCount).toBe(1);
      expect(await fileExists(path.join(stale.workspacePath, "frontend/macos/.build/DerivedData"))).toBe(true);
      expect(await fileExists(path.join(stale.workspacePath, "web/node_modules"))).toBe(false);
    } finally {
      await fs.rm(dataRoot, { force: true, recursive: true });
    }
  });

  it("removes old logs and deletes inactive sessions in oldest activity order", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-cleanup-"));

    try {
      const config = loadConfig({
        SLACK_APP_TOKEN: "xapp-test",
        SLACK_BOT_TOKEN: "xoxb-test",
        DATA_ROOT: dataRoot,
        DISK_CLEANUP_DRY_RUN: "false",
        DISK_CLEANUP_MIN_FREE_BYTES: "100",
        DISK_CLEANUP_TARGET_FREE_BYTES: "100",
        DISK_CLEANUP_INACTIVE_SESSION_MS: String(DAY_MS),
        DISK_CLEANUP_JOB_PROTECTION_MS: String(2 * DAY_MS),
        DISK_CLEANUP_OLD_LOG_MS: String(DAY_MS)
      } as NodeJS.ProcessEnv);
      const stateStore = new StateStore(config.stateDir, config.sessionsRoot);
      const sessions = new SessionManager({
        stateStore,
        sessionsRoot: config.sessionsRoot
      });
      await sessions.load();

      const now = new Date("2026-04-25T00:00:00.000Z");
      const oldAt = new Date(now.getTime() - 72 * 60 * 60 * 1000).toISOString();
      const protectedAt = new Date(now.getTime() - 36 * 60 * 60 * 1000).toISOString();
      const deletedPlain = await seedSession(sessions, stateStore, "COLD", "100.000", oldAt);
      const deletedActive = await seedSession(sessions, stateStore, "CACTIVE", "200.000", oldAt, {
        activeTurnId: "turn-old",
        activeTurnStartedAt: oldAt
      });
      const deletedPending = await seedSession(sessions, stateStore, "CPENDING", "300.000", oldAt);
      await sessions.upsertInboundMessage({
        key: "pending-old",
        sessionKey: deletedPending.key,
        channelId: deletedPending.channelId,
        rootThreadTs: deletedPending.rootThreadTs,
        messageTs: "300.100",
        source: "thread_reply",
        userId: "U1",
        text: "still old enough to delete",
        status: "pending",
        createdAt: oldAt,
        updatedAt: oldAt
      });

      const protectedActive = await seedSession(sessions, stateStore, "CPROTECTED", "400.000", protectedAt, {
        activeTurnId: "turn-protected",
        activeTurnStartedAt: protectedAt
      });
      const protectedJob = await seedSession(sessions, stateStore, "CJOB", "500.000", protectedAt);
      await seedJob(config.jobsRoot, sessions, {
        id: "job-protected",
        status: "running",
        sessionKey: protectedJob.key,
        channelId: protectedJob.channelId,
        rootThreadTs: protectedJob.rootThreadTs,
        workspacePath: protectedJob.workspacePath,
        at: protectedAt
      });
      const deletedJob = await seedSession(sessions, stateStore, "CSTALEJOB", "600.000", oldAt);
      await seedJob(config.jobsRoot, sessions, {
        id: "job-stale",
        status: "running",
        sessionKey: deletedJob.key,
        channelId: deletedJob.channelId,
        rootThreadTs: deletedJob.rootThreadTs,
        workspacePath: deletedJob.workspacePath,
        at: oldAt
      });

      const deletedSessionLogPath = path.join(
        getSessionLogDirectory(config.logDir, deletedPlain.key),
        "2026-04-25-00.jsonl"
      );
      const deletedJobLogPath = path.join(
        getJobLogDirectory(config.logDir, "job-stale"),
        "2026-04-25-00.jsonl"
      );
      const protectedJobLogPath = path.join(
        getJobLogDirectory(config.logDir, "job-protected"),
        "2026-04-25-00.jsonl"
      );
      await fs.mkdir(path.dirname(deletedSessionLogPath), { recursive: true });
      await fs.mkdir(path.dirname(deletedJobLogPath), { recursive: true });
      await fs.mkdir(path.dirname(protectedJobLogPath), { recursive: true });
      await fs.writeFile(deletedSessionLogPath, "{\"session\":\"deleted\"}\n");
      await fs.writeFile(deletedJobLogPath, "{\"job\":\"deleted\"}\n");
      await fs.writeFile(protectedJobLogPath, "{\"job\":\"protected\"}\n");

      const brokerLogDir = path.join(config.logDir, "broker");
      const rawLogDir = path.join(config.logDir, "raw", "codex-rpc");
      const freshRawLogDir = path.join(config.logDir, "raw", "http-requests");
      await fs.mkdir(brokerLogDir, { recursive: true });
      await fs.mkdir(rawLogDir, { recursive: true });
      await fs.mkdir(freshRawLogDir, { recursive: true });
      const brokerLogPath = path.join(brokerLogDir, "2026-04-22-00.jsonl");
      const rawLogPath = path.join(rawLogDir, "2026-04-22-00.jsonl");
      const compressedRawLogPath = path.join(rawLogDir, "2026-04-22-00.jsonl.gz");
      const freshRawLogPath = path.join(freshRawLogDir, "2026-04-25-00.jsonl");
      await fs.writeFile(brokerLogPath, "{\"old\":true}\n");
      await fs.writeFile(rawLogPath, "{\"old\":true}\n");
      await fs.writeFile(compressedRawLogPath, "compressed");
      await fs.writeFile(freshRawLogPath, "{\"fresh\":true}\n");
      await fs.utimes(brokerLogPath, new Date(oldAt), new Date(oldAt));
      await fs.utimes(rawLogPath, new Date(oldAt), new Date(oldAt));
      await fs.utimes(compressedRawLogPath, new Date(oldAt), new Date(oldAt));

      const cancelJob = vi.fn(async () => undefined);
      const cleanup = new DiskPressureCleanupService({
        config,
        sessions,
        jobTerminator: { cancelJob },
        now: () => now,
        statFs: async () => ({
          freeBytes: sessions.listSessions().length <= 2 ? 100 : 0,
          totalBytes: 1000
        })
      });

      const result = await cleanup.runOnce("test");

      expect(result.deletedLogCount).toBe(3);
      expect(result.deletedSessionCount).toBe(4);
      expect(cancelJob).toHaveBeenCalledTimes(1);
      expect(cancelJob).toHaveBeenCalledWith("job-stale", undefined, {
        skipTokenCheck: true,
        skipEvent: true
      });
      expect(sessions.getSessionByKey(deletedPlain.key)).toBeUndefined();
      expect(sessions.getSessionByKey(deletedActive.key)).toBeUndefined();
      expect(sessions.getSessionByKey(deletedPending.key)).toBeUndefined();
      expect(sessions.getSessionByKey(deletedJob.key)).toBeUndefined();
      expect(sessions.getSessionByKey(protectedActive.key)).toBeDefined();
      expect(sessions.getSessionByKey(protectedJob.key)).toBeDefined();
      expect(await fileExists(path.dirname(deletedPlain.workspacePath))).toBe(false);
      expect(await fileExists(path.dirname(deletedJob.workspacePath))).toBe(false);
      expect(await fileExists(path.join(config.jobsRoot, "job-stale"))).toBe(false);
      expect(await fileExists(path.join(config.jobsRoot, "job-protected"))).toBe(true);
      expect(await fileExists(deletedSessionLogPath)).toBe(false);
      expect(await fileExists(deletedJobLogPath)).toBe(false);
      expect(await fileExists(protectedJobLogPath)).toBe(true);
      expect(await fileExists(brokerLogPath)).toBe(false);
      expect(await fileExists(rawLogPath)).toBe(false);
      expect(await fileExists(compressedRawLogPath)).toBe(false);
      expect(await fileExists(freshRawLogPath)).toBe(true);
    } finally {
      await fs.rm(dataRoot, { force: true, recursive: true });
    }
  });

  it("treats the lowest free space across owned data roots as disk pressure", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-cleanup-roots-"));

    try {
      const config = loadConfig({
        SLACK_APP_TOKEN: "xapp-test",
        SLACK_BOT_TOKEN: "xoxb-test",
        DATA_ROOT: dataRoot,
        DISK_CLEANUP_DRY_RUN: "false",
        DISK_CLEANUP_MIN_FREE_BYTES: "100",
        DISK_CLEANUP_TARGET_FREE_BYTES: "100",
        DISK_CLEANUP_INACTIVE_SESSION_MS: String(DAY_MS),
        DISK_CLEANUP_JOB_PROTECTION_MS: String(2 * DAY_MS),
        DISK_CLEANUP_OLD_LOG_MS: String(DAY_MS)
      } as NodeJS.ProcessEnv);
      const stateStore = new StateStore(config.stateDir, config.sessionsRoot);
      const sessions = new SessionManager({
        stateStore,
        sessionsRoot: config.sessionsRoot
      });
      await sessions.load();

      const now = new Date("2026-04-25T00:00:00.000Z");
      const oldAt = new Date(now.getTime() - 72 * 60 * 60 * 1000).toISOString();
      const oldLogPath = path.join(config.logDir, "broker", "2026-04-22-00.jsonl");
      await fs.mkdir(path.dirname(oldLogPath), { recursive: true });
      await fs.writeFile(oldLogPath, "{\"old\":true}\n");
      await fs.utimes(oldLogPath, new Date(oldAt), new Date(oldAt));

      const cleanup = new DiskPressureCleanupService({
        config,
        sessions,
        now: () => now,
        statFs: async (targetPath) => {
          const isLogRoot = path.resolve(targetPath) === path.resolve(config.logDir);
          return {
            freeBytes: isLogRoot && await fileExists(oldLogPath) ? 0 : 100,
            totalBytes: 1000
          };
        }
      });

      const result = await cleanup.runOnce("test");

      expect(result.skipped).toBeUndefined();
      expect(result.deletedLogCount).toBe(1);
      expect(result.before?.freeBytes).toBe(0);
      expect(result.after?.freeBytes).toBe(100);
      expect(await fileExists(oldLogPath)).toBe(false);
    } finally {
      await fs.rm(dataRoot, { force: true, recursive: true });
    }
  });
});

async function seedSession(
  sessions: SessionManager,
  stateStore: StateStore,
  channelId: string,
  rootThreadTs: string,
  at: string,
  patch: {
    readonly activeTurnId?: string | undefined;
    readonly activeTurnStartedAt?: string | undefined;
  } = {}
) {
  const session = await sessions.ensureSession(channelId, rootThreadTs);
  const record = {
    ...session,
    ...patch,
    createdAt: at,
    updatedAt: at
  };
  await stateStore.upsertSession(record);
  await fs.writeFile(path.join(session.workspacePath, "marker.txt"), `${channelId}:${rootThreadTs}`);
  return record;
}

async function writeSizedFile(filePath: string, bytes: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "x".repeat(bytes));
}

async function seedJob(
  jobsRoot: string,
  sessions: SessionManager,
  options: {
    readonly id: string;
    readonly status: PersistedBackgroundJobStatus;
    readonly sessionKey: string;
    readonly channelId: string;
    readonly rootThreadTs: string;
    readonly workspacePath: string;
    readonly at: string;
  }
): Promise<void> {
  const jobDir = path.join(jobsRoot, options.id);
  await fs.mkdir(jobDir, { recursive: true });
  const scriptPath = path.join(jobDir, "run.sh");
  await fs.writeFile(scriptPath, "#!/bin/sh\nsleep 300\n");
  await fs.chmod(scriptPath, 0o755);
  await sessions.upsertBackgroundJob({
    id: options.id,
    token: `token-${options.id}`,
    sessionKey: options.sessionKey,
    channelId: options.channelId,
    rootThreadTs: options.rootThreadTs,
    kind: "watch_ci",
    shell: "sh",
    cwd: options.workspacePath,
    scriptPath,
    restartOnBoot: true,
    status: options.status,
    createdAt: options.at,
    updatedAt: options.at,
    startedAt: options.at,
    heartbeatAt: options.at
  });
}
