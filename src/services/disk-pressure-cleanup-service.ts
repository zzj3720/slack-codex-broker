import fs from "node:fs/promises";
import path from "node:path";

import type { AppConfig } from "../config.js";
import { getJobLogDirectory, getSessionLogDirectory, logger } from "../logger.js";
import type { PersistedBackgroundJob, PersistedInboundMessage, SlackSessionRecord } from "../types.js";
import { ensureDir } from "../utils/fs.js";
import type { SessionManager } from "./session-manager.js";

interface DiskUsage {
  readonly freeBytes: number;
  readonly totalBytes: number;
}

export interface DiskPressureCleanupResult {
  readonly ok: boolean;
  readonly skipped?: string | undefined;
  readonly dryRun: boolean;
  readonly before?: DiskUsage | undefined;
  readonly after?: DiskUsage | undefined;
  readonly cacheCandidateCount: number;
  readonly deletedCacheEntryCount: number;
  readonly cacheReclaimedBytes: number;
  readonly deletedLogCount: number;
  readonly deletedSessionCount: number;
}

interface BackgroundJobTerminator {
  cancelJob(
    id: string,
    token?: string | undefined,
    options?: {
      readonly skipTokenCheck?: boolean | undefined;
      readonly skipEvent?: boolean | undefined;
    }
  ): Promise<unknown>;
}

type StatFsProvider = (targetPath: string) => Promise<DiskUsage>;

const PROTECTED_JOB_STATUSES = new Set(["registered", "running"]);
const DARWIN_SESSION_CACHE_RELATIVE_PATHS = [
  "frontend/macos/.build/DerivedData",
  "frontend/macos/default.profraw",
  "frontend/macos/xcodebuild.log",
  "default.profraw"
] as const;
const CROSS_PLATFORM_SESSION_CACHE_RELATIVE_PATHS = [
  "web/node_modules",
  "workers/node_modules"
] as const;

export class DiskPressureCleanupService {
  readonly #config: AppConfig;
  readonly #sessions: SessionManager;
  readonly #jobTerminator: BackgroundJobTerminator | undefined;
  readonly #now: () => Date;
  readonly #statFs: StatFsProvider;
  readonly #isDarwin: boolean;
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(options: {
    readonly config: AppConfig;
    readonly sessions: SessionManager;
    readonly jobTerminator?: BackgroundJobTerminator | undefined;
    readonly now?: (() => Date) | undefined;
    readonly statFs?: StatFsProvider | undefined;
    readonly isDarwin?: boolean | undefined;
  }) {
    this.#config = options.config;
    this.#sessions = options.sessions;
    this.#jobTerminator = options.jobTerminator;
    this.#now = options.now ?? (() => new Date());
    this.#statFs = options.statFs ?? readDiskUsage;
    this.#isDarwin = options.isDarwin ?? process.platform === "darwin";
  }

  start(): void {
    if (!this.#config.diskCleanupEnabled || this.#config.diskCleanupCheckIntervalMs <= 0 || this.#timer) {
      return;
    }

    this.#timer = setInterval(() => {
      void this.runOnce("interval");
    }, this.#config.diskCleanupCheckIntervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (!this.#timer) {
      return;
    }
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async runOnce(reason = "manual"): Promise<DiskPressureCleanupResult> {
    if (!this.#config.diskCleanupEnabled) {
      return emptyResult({ skipped: "disabled", dryRun: this.#config.diskCleanupDryRun });
    }
    if (this.#running) {
      return emptyResult({ skipped: "already_running", dryRun: this.#config.diskCleanupDryRun });
    }

    this.#running = true;
    try {
      await Promise.all([
        ensureDir(this.#config.logDir),
        ensureDir(this.#config.sessionsRoot),
        ensureDir(this.#config.jobsRoot)
      ]);

      const before = await this.#readUsage();
      const cacheResult = await this.#cleanExpiredSessionCaches();
      let deletedLogCount = 0;
      let deletedSessionCount = 0;

      if (before.freeBytes < this.#config.diskCleanupMinFreeBytes) {
        logger.warn("Disk free space below cleanup threshold", {
          reason,
          dryRun: this.#config.diskCleanupDryRun,
          freeBytes: before.freeBytes,
          minFreeBytes: this.#config.diskCleanupMinFreeBytes,
          targetFreeBytes: this.#config.diskCleanupTargetFreeBytes
        });

        deletedLogCount = await this.#deleteOldLogs(this.#config.diskCleanupOldLogMs);
        deletedSessionCount =
          (await this.#readUsage()).freeBytes < this.#config.diskCleanupTargetFreeBytes
            ? await this.#deleteInactiveSessions()
            : 0;
      }

      const after = await this.#readUsage();
      const skipped =
        before.freeBytes >= this.#config.diskCleanupMinFreeBytes && cacheResult.candidateCount === 0
          ? "enough_free_space"
          : undefined;
      logger.info("Disk pressure cleanup finished", {
        reason,
        skipped,
        dryRun: this.#config.diskCleanupDryRun,
        beforeFreeBytes: before.freeBytes,
        afterFreeBytes: after.freeBytes,
        cacheCandidateCount: cacheResult.candidateCount,
        deletedCacheEntryCount: cacheResult.deletedCount,
        cacheReclaimedBytes: cacheResult.reclaimedBytes,
        deletedLogCount,
        deletedSessionCount
      });

      return {
        ok: true,
        skipped,
        dryRun: this.#config.diskCleanupDryRun,
        before,
        after,
        cacheCandidateCount: cacheResult.candidateCount,
        deletedCacheEntryCount: cacheResult.deletedCount,
        cacheReclaimedBytes: cacheResult.reclaimedBytes,
        deletedLogCount,
        deletedSessionCount
      };
    } catch (error) {
      logger.error("Disk pressure cleanup failed", {
        reason,
        error: error instanceof Error ? error.message : String(error)
      });
      return emptyResult({ dryRun: this.#config.diskCleanupDryRun });
    } finally {
      this.#running = false;
    }
  }

  async #deleteOldLogs(maxAgeMs: number): Promise<number> {
    const nowMs = this.#now().getTime();
    const files = await listFiles(this.#config.logDir);
    let deletedCount = 0;

    for (const file of files
      .filter((entry) => nowMs - entry.mtimeMs >= maxAgeMs)
      .sort((left, right) => left.mtimeMs - right.mtimeMs)) {
      try {
        const bytes = await getPathSizeBytes(file.path);
        logger.info("Disk cleanup old log candidate", {
          path: file.path,
          bytes,
          dryRun: this.#config.diskCleanupDryRun
        });
        if (!this.#config.diskCleanupDryRun) {
          await fs.rm(file.path, { force: true });
          await removeEmptyParents(path.dirname(file.path), this.#config.logDir);
          deletedCount += 1;
          logger.info("Disk cleanup old log deleted", {
            path: file.path,
            bytes,
            dryRun: false
          });
        }
      } catch (error) {
        logger.warn("Failed to delete log during disk cleanup", {
          path: file.path,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return deletedCount;
  }

  async #deleteInactiveSessions(): Promise<number> {
    const nowMs = this.#now().getTime();
    const candidates = await Promise.all(this.#sessions.listSessions().map(async (session) => {
      const inbound = this.#sessions.listInboundMessages({
        channelId: session.channelId,
        rootThreadTs: session.rootThreadTs
      });
      const jobs = this.#sessions.listBackgroundJobs({
        channelId: session.channelId,
        rootThreadTs: session.rootThreadTs
      });
      const lastActivityMs = getLastUserVisibleActivityMs(session, inbound);
      if (!lastActivityMs || nowMs - lastActivityMs < this.#config.diskCleanupInactiveSessionMs) {
        return null;
      }
      if (!canDeleteSession(session, inbound, jobs, {
        inactiveMs: nowMs - lastActivityMs,
        hardProtectionMs: this.#config.diskCleanupJobProtectionMs
      })) {
        return null;
      }

      return {
        session,
        jobs,
        lastActivityMs
      };
    }));

    let deletedCount = 0;
    for (const candidate of candidates
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((left, right) => left.lastActivityMs - right.lastActivityMs)) {
      try {
        const sessionRoot = path.dirname(candidate.session.workspacePath);
        const bytes = await getPathSizeBytes(sessionRoot);
        logger.info("Disk cleanup inactive session candidate", {
          sessionKey: candidate.session.key,
          channelId: candidate.session.channelId,
          rootThreadTs: candidate.session.rootThreadTs,
          path: sessionRoot,
          bytes,
          dryRun: this.#config.diskCleanupDryRun
        });
        if (!this.#config.diskCleanupDryRun) {
          await this.#cancelJobs(candidate.jobs);
          await Promise.all([
            fs.rm(getSessionLogDirectory(this.#config.logDir, candidate.session.key), { recursive: true, force: true }),
            ...candidate.jobs.map((job) => fs.rm(path.join(this.#config.jobsRoot, job.id), { recursive: true, force: true })),
            ...candidate.jobs.map((job) =>
              fs.rm(getJobLogDirectory(this.#config.logDir, job.id), { recursive: true, force: true })
            )
          ]);
          await this.#sessions.deleteSessionByKey(candidate.session.key);
          deletedCount += 1;
          logger.info("Disk cleanup inactive session deleted", {
            sessionKey: candidate.session.key,
            channelId: candidate.session.channelId,
            rootThreadTs: candidate.session.rootThreadTs,
            path: sessionRoot,
            bytes,
            dryRun: false
          });
        }
      } catch (error) {
        logger.warn("Failed to delete inactive session during disk cleanup", {
          sessionKey: candidate.session.key,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      if ((await this.#readUsage()).freeBytes >= this.#config.diskCleanupTargetFreeBytes) {
        break;
      }
    }

    return deletedCount;
  }

  async #cancelJobs(jobs: readonly PersistedBackgroundJob[]): Promise<void> {
    if (!this.#jobTerminator) {
      return;
    }
    await Promise.all(jobs
      .filter((job) => PROTECTED_JOB_STATUSES.has(job.status))
      .map((job) =>
        this.#jobTerminator!.cancelJob(job.id, undefined, {
          skipTokenCheck: true,
          skipEvent: true
        }).catch((error) => {
          logger.warn("Failed to cancel background job during disk cleanup", {
            jobId: job.id,
            error: error instanceof Error ? error.message : String(error)
          });
        })
      ));
  }

  async #readUsage(): Promise<DiskUsage> {
    const usages = await Promise.all(uniqueResolvedPaths([
      this.#config.logDir,
      this.#config.sessionsRoot,
      this.#config.jobsRoot
    ]).map((targetPath) => this.#statFs(targetPath)));

    return usages.reduce((lowest, usage) => usage.freeBytes < lowest.freeBytes ? usage : lowest);
  }

  async #cleanExpiredSessionCaches(): Promise<{
    readonly candidateCount: number;
    readonly deletedCount: number;
    readonly reclaimedBytes: number;
  }> {
    const nowMs = this.#now().getTime();
    let candidateCount = 0;
    let deletedCount = 0;
    let reclaimedBytes = 0;

    const candidates = await Promise.all(this.#sessions.listSessions().map(async (session) => {
      const inbound = this.#sessions.listInboundMessages({
        channelId: session.channelId,
        rootThreadTs: session.rootThreadTs
      });
      const jobs = this.#sessions.listBackgroundJobs({
        channelId: session.channelId,
        rootThreadTs: session.rootThreadTs
      });
      const lastActivityMs = getLastUserVisibleActivityMs(session, inbound);
      if (!lastActivityMs || nowMs - lastActivityMs < this.#config.diskCleanupSessionCacheTtlMs) {
        return null;
      }
      if (!canCleanSessionCaches(session, inbound, jobs)) {
        return null;
      }

      return {
        session,
        lastActivityMs
      };
    }));

    for (const candidate of candidates
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((left, right) => left.lastActivityMs - right.lastActivityMs)) {
      for (const relativePath of getSessionCacheRelativePaths(this.#isDarwin)) {
        const targetPath = path.join(candidate.session.workspacePath, relativePath);
        if (!isSubpathOf(candidate.session.workspacePath, targetPath)) {
          continue;
        }
        try {
          const bytes = await getPathSizeBytes(targetPath);
          if (bytes <= 0) {
            continue;
          }

          candidateCount += 1;
          logger.info("Disk cleanup session cache candidate", {
            sessionKey: candidate.session.key,
            channelId: candidate.session.channelId,
            rootThreadTs: candidate.session.rootThreadTs,
            path: targetPath,
            relativePath,
            bytes,
            dryRun: this.#config.diskCleanupDryRun
          });

          if (this.#config.diskCleanupDryRun) {
            continue;
          }

          await fs.rm(targetPath, { recursive: true, force: true });
          deletedCount += 1;
          reclaimedBytes += bytes;
          logger.info("Disk cleanup session cache deleted", {
            sessionKey: candidate.session.key,
            channelId: candidate.session.channelId,
            rootThreadTs: candidate.session.rootThreadTs,
            path: targetPath,
            relativePath,
            bytes,
            dryRun: false
          });
        } catch (error) {
          logger.warn("Failed to delete session cache during disk cleanup", {
            sessionKey: candidate.session.key,
            path: targetPath,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    return {
      candidateCount,
      deletedCount,
      reclaimedBytes
    };
  }
}

function emptyResult(options: {
  readonly skipped?: string | undefined;
  readonly dryRun: boolean;
  readonly before?: DiskUsage | undefined;
  readonly after?: DiskUsage | undefined;
}): DiskPressureCleanupResult {
  return {
    ok: true,
    skipped: options.skipped,
    dryRun: options.dryRun,
    before: options.before,
    after: options.after,
    cacheCandidateCount: 0,
    deletedCacheEntryCount: 0,
    cacheReclaimedBytes: 0,
    deletedLogCount: 0,
    deletedSessionCount: 0
  };
}

async function readDiskUsage(targetPath: string): Promise<DiskUsage> {
  const stat = await fs.statfs(targetPath);
  return {
    freeBytes: stat.bavail * stat.bsize,
    totalBytes: stat.blocks * stat.bsize
  };
}

function getLastUserVisibleActivityMs(
  session: SlackSessionRecord,
  inbound: readonly PersistedInboundMessage[]
): number | undefined {
  const values = [
    session.createdAt,
    session.activeTurnStartedAt,
    session.lastSlackReplyAt,
    session.lastTurnSignalAt,
    ...inbound.flatMap((message) => [message.createdAt, message.updatedAt])
  ]
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((value) => Number.isFinite(value));

  return values.length > 0 ? Math.max(...values) : undefined;
}

function canDeleteSession(
  session: SlackSessionRecord,
  inbound: readonly PersistedInboundMessage[],
  jobs: readonly PersistedBackgroundJob[],
  options: {
    readonly inactiveMs: number;
    readonly hardProtectionMs: number;
  }
): boolean {
  if (options.inactiveMs >= options.hardProtectionMs) {
    return true;
  }
  if (session.activeTurnId) {
    return false;
  }
  if (inbound.some((message) => message.status === "pending" || message.status === "inflight")) {
    return false;
  }
  return !jobs.some((job) => PROTECTED_JOB_STATUSES.has(job.status));
}

function canCleanSessionCaches(
  session: SlackSessionRecord,
  inbound: readonly PersistedInboundMessage[],
  jobs: readonly PersistedBackgroundJob[]
): boolean {
  if (session.activeTurnId) {
    return false;
  }
  if (inbound.some((message) => message.status === "pending" || message.status === "inflight")) {
    return false;
  }
  return !jobs.some((job) => PROTECTED_JOB_STATUSES.has(job.status));
}

function getSessionCacheRelativePaths(isDarwin: boolean): readonly string[] {
  return isDarwin
    ? [...DARWIN_SESSION_CACHE_RELATIVE_PATHS, ...CROSS_PLATFORM_SESSION_CACHE_RELATIVE_PATHS]
    : CROSS_PLATFORM_SESSION_CACHE_RELATIVE_PATHS;
}

async function getPathSizeBytes(targetPath: string): Promise<number> {
  let stat;
  try {
    stat = await fs.lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }

  if (!stat.isDirectory()) {
    return stat.size;
  }

  let total = stat.size;
  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    total += await getPathSizeBytes(path.join(targetPath, entry.name));
  }
  return total;
}

async function listFiles(directoryPath: string): Promise<Array<{
  readonly path: string;
  readonly mtimeMs: number;
}>> {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(entryPath));
    } else if (entry.isFile()) {
      const stat = await fs.stat(entryPath);
      files.push({
        path: entryPath,
        mtimeMs: stat.mtimeMs
      });
    }
  }
  return files;
}

async function removeEmptyParents(startPath: string, stopPath: string): Promise<void> {
  const stop = path.resolve(stopPath);
  let current = path.resolve(startPath);

  while (current !== stop && isSubpathOf(stop, current)) {
    try {
      await fs.rmdir(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        current = path.dirname(current);
        continue;
      }
      if (code === "ENOTEMPTY" || code === "EEXIST") {
        return;
      }
      throw error;
    }
    current = path.dirname(current);
  }
}

function isSubpathOf(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function uniqueResolvedPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((entry) => path.resolve(entry)))];
}
