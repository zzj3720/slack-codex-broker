import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import type { AppConfig } from "../config.js";
import { logger } from "../logger.js";
import type { PersistedBackgroundJob, PersistedInboundMessage, SlackSessionRecord } from "../types.js";
import { ensureDir } from "../utils/fs.js";
import type { SessionManager } from "./session-manager.js";

interface DiskUsage {
  readonly freeBytes: number;
  readonly totalBytes: number;
}

interface DeletedPath {
  readonly path: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  readonly reason: string;
}

interface DeletedSession {
  readonly key: string;
  readonly workspaceRoot?: string | undefined;
  readonly sizeBytes: number;
  readonly lastActivityAt: string;
  readonly backgroundJobCount: number;
}

export interface DiskPressureCleanupResult {
  readonly ok: boolean;
  readonly skipped?: string | undefined;
  readonly error?: string | undefined;
  readonly before?: DiskUsage | undefined;
  readonly after?: DiskUsage | undefined;
  readonly deletedLogs: readonly DeletedPath[];
  readonly deletedSessions: readonly DeletedSession[];
}

type StatFsProvider = (targetPath: string) => Promise<DiskUsage>;

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

const PROTECTED_JOB_STATUSES = new Set(["registered", "running"]);

export class DiskPressureCleanupService {
  readonly #config: AppConfig;
  readonly #sessions: SessionManager;
  readonly #jobTerminator: BackgroundJobTerminator | undefined;
  readonly #now: () => Date;
  readonly #statFs: StatFsProvider;
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(options: {
    readonly config: AppConfig;
    readonly sessions: SessionManager;
    readonly jobTerminator?: BackgroundJobTerminator | undefined;
    readonly now?: (() => Date) | undefined;
    readonly statFs?: StatFsProvider | undefined;
  }) {
    this.#config = options.config;
    this.#sessions = options.sessions;
    this.#jobTerminator = options.jobTerminator;
    this.#now = options.now ?? (() => new Date());
    this.#statFs = options.statFs ?? readDiskUsage;
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
      return emptyResult({ skipped: "disabled" });
    }

    if (this.#running) {
      return emptyResult({ skipped: "already_running" });
    }

    this.#running = true;
    try {
      await Promise.all([
        ensureDir(this.#config.logDir),
        ensureDir(this.#config.sessionsRoot),
        ensureDir(this.#config.jobsRoot)
      ]);

      const before = await this.#readUsage();
      if (before.freeBytes >= this.#config.diskCleanupMinFreeBytes) {
        return emptyResult({
          skipped: "enough_free_space",
          before,
          after: before
        });
      }

      logger.warn("Disk free space below cleanup threshold", {
        reason,
        freeBytes: before.freeBytes,
        minFreeBytes: this.#config.diskCleanupMinFreeBytes,
        targetFreeBytes: this.#config.diskCleanupTargetFreeBytes
      });

      const deletedLogs: DeletedPath[] = [];
      const deletedSessions: DeletedSession[] = [];

      deletedLogs.push(...await this.#deleteRawLogs({
        maxAgeMs: this.#config.diskCleanupOldLogMs,
        reason: "old_raw_log"
      }));

      if ((await this.#readUsage()).freeBytes < this.#config.diskCleanupTargetFreeBytes) {
        deletedSessions.push(...await this.#deleteInactiveSessions());
      }

      if ((await this.#readUsage()).freeBytes < this.#config.diskCleanupTargetFreeBytes) {
        deletedLogs.push(...await this.#deleteRawLogs({
          reason: "raw_log_disk_pressure"
        }));
      }

      const after = await this.#readUsage();
      logger.info("Disk pressure cleanup finished", {
        reason,
        beforeFreeBytes: before.freeBytes,
        afterFreeBytes: after.freeBytes,
        deletedLogCount: deletedLogs.length,
        deletedSessionCount: deletedSessions.length,
        deletedBytes: sumDeletedBytes(deletedLogs, deletedSessions)
      });

      return {
        ok: true,
        before,
        after,
        deletedLogs,
        deletedSessions
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Disk pressure cleanup failed", {
        reason,
        error: message
      });
      return emptyResult({
        error: message
      });
    } finally {
      this.#running = false;
    }
  }

  async #deleteRawLogs(options: {
    readonly maxAgeMs?: number | undefined;
    readonly reason: string;
  }): Promise<DeletedPath[]> {
    const rawLogDir = path.join(this.#config.logDir, "raw");
    const nowMs = this.#now().getTime();
    const files = await listFiles(rawLogDir);
    const candidates = files
      .filter((file) => options.maxAgeMs === undefined || nowMs - file.mtimeMs >= options.maxAgeMs)
      .sort((left, right) => {
        if (left.mtimeMs !== right.mtimeMs) {
          return left.mtimeMs - right.mtimeMs;
        }
        return right.sizeBytes - left.sizeBytes;
      });

    const deleted: DeletedPath[] = [];
    for (const candidate of candidates) {
      try {
        await fs.rm(candidate.path, { force: true });
        deleted.push({
          ...candidate,
          reason: options.reason
        });
      } catch (error) {
        logger.warn("Failed to delete raw log during disk cleanup", {
          path: candidate.path,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return deleted;
  }

  async #deleteInactiveSessions(): Promise<DeletedSession[]> {
    const nowMs = this.#now().getTime();
    const candidates = await Promise.all(
      this.#sessions.listSessions().map(async (session) => {
        const inbound = this.#sessions.listInboundMessages({
          channelId: session.channelId,
          rootThreadTs: session.rootThreadTs
        });
        const jobs = this.#sessions.listBackgroundJobs({
          channelId: session.channelId,
          rootThreadTs: session.rootThreadTs
        });
        const lastActivityMs = getSessionActivityMs(session, inbound);

        if (!lastActivityMs || nowMs - lastActivityMs < this.#config.diskCleanupInactiveSessionMs) {
          return null;
        }

        if (!isSessionSafeToDelete(session, inbound, jobs, {
          inactiveMs: nowMs - lastActivityMs,
          jobProtectionMs: this.#config.diskCleanupJobProtectionMs
        })) {
          return null;
        }

        const workspaceRoot = resolveSessionWorkspaceRoot(this.#config.sessionsRoot, session.workspacePath);
        const relatedPaths = [
          workspaceRoot,
          path.join(this.#config.logDir, "sessions", `${encodeKey(session.key)}.jsonl`),
          ...jobs.map((job) => path.join(this.#config.jobsRoot, job.id)),
          ...jobs.map((job) => path.join(this.#config.logDir, "jobs", `${encodeKey(job.id)}.jsonl`))
        ].filter((entry): entry is string => Boolean(entry));

        return {
          session,
          jobs,
          workspaceRoot,
          lastActivityMs,
          sizeBytes: await sumPathSizes(relatedPaths)
        };
      })
    );

    const deleted: DeletedSession[] = [];
    for (const candidate of candidates
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((left, right) => {
        if (left.lastActivityMs !== right.lastActivityMs) {
          return left.lastActivityMs - right.lastActivityMs;
        }
        return right.sizeBytes - left.sizeBytes;
      })) {
      try {
        await this.#cancelRuntimeJobs(candidate.jobs);
        if (candidate.workspaceRoot) {
          await fs.rm(candidate.workspaceRoot, { recursive: true, force: true });
        }
        await Promise.all([
          fs.rm(path.join(this.#config.logDir, "sessions", `${encodeKey(candidate.session.key)}.jsonl`), { force: true }),
          ...candidate.jobs.map((job) => fs.rm(path.join(this.#config.jobsRoot, job.id), { recursive: true, force: true })),
          ...candidate.jobs.map((job) =>
            fs.rm(path.join(this.#config.logDir, "jobs", `${encodeKey(job.id)}.jsonl`), { force: true })
          )
        ]);
        await this.#sessions.deleteSessionByKey(candidate.session.key);

        deleted.push({
          key: candidate.session.key,
          workspaceRoot: candidate.workspaceRoot,
          sizeBytes: candidate.sizeBytes,
          lastActivityAt: new Date(candidate.lastActivityMs).toISOString(),
          backgroundJobCount: candidate.jobs.length
        });

        if ((await this.#readUsage()).freeBytes >= this.#config.diskCleanupTargetFreeBytes) {
          break;
        }
      } catch (error) {
        logger.warn("Failed to delete inactive session during disk cleanup", {
          sessionKey: candidate.session.key,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return deleted;
  }

  async #cancelRuntimeJobs(jobs: readonly PersistedBackgroundJob[]): Promise<void> {
    if (!this.#jobTerminator) {
      return;
    }

    await Promise.all(jobs
      .filter((job) => PROTECTED_JOB_STATUSES.has(job.status))
      .map(async (job) => {
        try {
          await this.#jobTerminator!.cancelJob(job.id, undefined, {
            skipTokenCheck: true,
            skipEvent: true
          });
        } catch (error) {
          logger.warn("Failed to cancel background job during disk cleanup", {
            jobId: job.id,
            sessionKey: job.sessionKey,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }));
  }

  async #readUsage(): Promise<DiskUsage> {
    return await this.#statFs(this.#config.sessionsRoot);
  }
}

async function readDiskUsage(targetPath: string): Promise<DiskUsage> {
  const stats = await fs.statfs(targetPath);
  return {
    freeBytes: stats.bavail * stats.bsize,
    totalBytes: stats.blocks * stats.bsize
  };
}

function emptyResult(options: {
  readonly skipped?: string | undefined;
  readonly error?: string | undefined;
  readonly before?: DiskUsage | undefined;
  readonly after?: DiskUsage | undefined;
}): DiskPressureCleanupResult {
  return {
    ok: !options.error,
    skipped: options.skipped,
    error: options.error,
    before: options.before,
    after: options.after,
    deletedLogs: [],
    deletedSessions: []
  };
}

async function listFiles(directoryPath: string): Promise<DeletedPath[]> {
  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }
    throw error;
  }

  const files: DeletedPath[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(entryPath));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    const stat = await fs.stat(entryPath);
    files.push({
      path: entryPath,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      reason: "candidate"
    });
  }

  return files;
}

function getSessionActivityMs(
  session: SlackSessionRecord,
  inbound: readonly PersistedInboundMessage[]
): number | undefined {
  const values = [
    session.createdAt,
    session.activeTurnStartedAt,
    session.lastSlackReplyAt,
    session.lastProgressReminderAt,
    session.lastTurnSignalAt,
    ...inbound.flatMap((message) => [message.createdAt, message.updatedAt])
  ]
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((value) => Number.isFinite(value));

  return values.length > 0 ? Math.max(...values) : undefined;
}

function isSessionSafeToDelete(
  session: SlackSessionRecord,
  inbound: readonly PersistedInboundMessage[],
  jobs: readonly PersistedBackgroundJob[],
  options: {
    readonly inactiveMs: number;
    readonly jobProtectionMs: number;
  }
): boolean {
  if (options.inactiveMs >= options.jobProtectionMs) {
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

function resolveSessionWorkspaceRoot(sessionsRoot: string, workspacePath: string): string | undefined {
  const resolvedSessionsRoot = path.resolve(sessionsRoot);
  const resolvedWorkspacePath = path.resolve(workspacePath);
  const candidate = path.basename(resolvedWorkspacePath) === "workspace"
    ? path.dirname(resolvedWorkspacePath)
    : resolvedWorkspacePath;

  if (!isSubpathOf(resolvedSessionsRoot, candidate)) {
    return undefined;
  }

  return candidate;
}

async function sumPathSizes(paths: readonly string[]): Promise<number> {
  let total = 0;
  for (const targetPath of paths) {
    total += await getPathSize(targetPath);
  }
  return total;
}

async function getPathSize(targetPath: string): Promise<number> {
  let stat;
  try {
    stat = await fs.stat(targetPath);
  } catch (error) {
    if (isNotFound(error)) {
      return 0;
    }
    throw error;
  }

  if (!stat.isDirectory()) {
    return stat.size;
  }

  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    total += await getPathSize(path.join(targetPath, entry.name));
  }
  return total;
}

function sumDeletedBytes(logs: readonly DeletedPath[], sessions: readonly DeletedSession[]): number {
  return (
    logs.reduce((sum, entry) => sum + entry.sizeBytes, 0) +
    sessions.reduce((sum, entry) => sum + entry.sizeBytes, 0)
  );
}

function isSubpathOf(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function encodeKey(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
