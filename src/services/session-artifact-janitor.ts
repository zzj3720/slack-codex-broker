import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import { logger } from "../logger.js";
import type {
  PersistedBackgroundJob,
  PersistedInboundMessage,
  SlackSessionRecord
} from "../types.js";
import { SessionManager } from "./session-manager.js";

interface SessionArtifactJanitorCandidate {
  readonly session: SlackSessionRecord;
  readonly lastActivityAt: string;
  readonly lastActivityAtMs: number;
}

export interface SessionArtifactJanitorSweepResult {
  readonly reason: string;
  readonly checkedCount: number;
  readonly cleanedCount: number;
  readonly cleanedSessionKeys: readonly string[];
}

export class SessionArtifactJanitor {
  readonly #sessions: SessionManager;
  readonly #inactivityTtlMs: number;
  readonly #cleanupIntervalMs: number;
  readonly #cleanupMaxPerSweep: number;
  readonly #now: () => number;

  #timer: NodeJS.Timeout | undefined;

  constructor(options: {
    readonly sessions: SessionManager;
    readonly inactivityTtlMs: number;
    readonly cleanupIntervalMs: number;
    readonly cleanupMaxPerSweep: number;
    readonly now?: (() => number) | undefined;
  }) {
    this.#sessions = options.sessions;
    this.#inactivityTtlMs = options.inactivityTtlMs;
    this.#cleanupIntervalMs = options.cleanupIntervalMs;
    this.#cleanupMaxPerSweep = options.cleanupMaxPerSweep;
    this.#now = options.now ?? (() => Date.now());
  }

  async start(): Promise<void> {
    if (!this.#isSweepEnabled()) {
      logger.info("Session artifact janitor disabled", {
        inactivityTtlMs: this.#inactivityTtlMs,
        cleanupIntervalMs: this.#cleanupIntervalMs,
        cleanupMaxPerSweep: this.#cleanupMaxPerSweep
      });
      return;
    }

    await this.runSweep("startup");

    if (!this.#isPeriodicSweepEnabled()) {
      return;
    }

    this.#timer = setInterval(() => {
      void this.runSweep("periodic").catch((error) => {
        logger.error("Session artifact janitor periodic sweep failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }, this.#cleanupIntervalMs);

    logger.info("Session artifact janitor started", {
      inactivityTtlMs: this.#inactivityTtlMs,
      cleanupIntervalMs: this.#cleanupIntervalMs,
      cleanupMaxPerSweep: this.#cleanupMaxPerSweep
    });
  }

  async stop(): Promise<void> {
    if (!this.#timer) {
      return;
    }

    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async runSweep(reason: string): Promise<SessionArtifactJanitorSweepResult> {
    if (!this.#isSweepEnabled()) {
      return {
        reason,
        checkedCount: 0,
        cleanedCount: 0,
        cleanedSessionKeys: []
      };
    }

    const nowMs = this.#now();
    const sessions = this.#sessions.listSessions();
    const candidates = sessions
      .map((session) => this.#getCandidate(session, nowMs))
      .filter((candidate): candidate is SessionArtifactJanitorCandidate => candidate !== null)
      .sort((left, right) => left.lastActivityAtMs - right.lastActivityAtMs)
      .slice(0, this.#cleanupMaxPerSweep);

    const cleanedSessionKeys: string[] = [];

    for (const candidate of candidates) {
      try {
        const cleaned = await this.#cleanupCandidate(candidate, nowMs);
        if (cleaned) {
          cleanedSessionKeys.push(candidate.session.key);
        }
      } catch (error) {
        logger.error("Failed to clean inactive session artifacts", {
          sessionKey: candidate.session.key,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (cleanedSessionKeys.length > 0 || reason === "startup") {
      logger.info("Session artifact janitor sweep finished", {
        reason,
        checkedCount: sessions.length,
        candidateCount: candidates.length,
        cleanedCount: cleanedSessionKeys.length,
        cleanupMaxPerSweep: this.#cleanupMaxPerSweep,
        inactivityTtlMs: this.#inactivityTtlMs
      });
    }

    return {
      reason,
      checkedCount: sessions.length,
      cleanedCount: cleanedSessionKeys.length,
      cleanedSessionKeys
    };
  }

  #isSweepEnabled(): boolean {
    return this.#inactivityTtlMs > 0 && this.#cleanupMaxPerSweep > 0;
  }

  #isPeriodicSweepEnabled(): boolean {
    return this.#isSweepEnabled() && this.#cleanupIntervalMs > 0;
  }

  #getCandidate(session: SlackSessionRecord, nowMs: number): SessionArtifactJanitorCandidate | null {
    if (session.activeTurnId) {
      return null;
    }

    const openInboundMessages = this.#sessions.listInboundMessages({
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs,
      status: ["pending", "inflight"]
    });
    if (openInboundMessages.length > 0) {
      return null;
    }

    const backgroundJobs = this.#sessions.listBackgroundJobs({
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs
    });
    if (backgroundJobs.some((job) => job.status === "registered" || job.status === "running")) {
      return null;
    }

    const inboundMessages = this.#sessions.listInboundMessages({
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs
    });
    const lastActivity = computeLastActivity(session, inboundMessages, backgroundJobs);
    if (nowMs - lastActivity.atMs < this.#inactivityTtlMs) {
      return null;
    }

    return {
      session,
      lastActivityAt: lastActivity.at,
      lastActivityAtMs: lastActivity.atMs
    };
  }

  async #cleanupCandidate(candidate: SessionArtifactJanitorCandidate, nowMs: number): Promise<boolean> {
    const session = this.#sessions.getSession(candidate.session.channelId, candidate.session.rootThreadTs);
    if (!session) {
      return false;
    }

    const freshCandidate = this.#getCandidate(session, nowMs);
    if (!freshCandidate) {
      return false;
    }

    const artifactPaths = await findDisposableArtifactPaths(session.workspacePath);
    if (artifactPaths.length === 0) {
      return false;
    }

    for (const artifactPath of artifactPaths) {
      await fs.rm(artifactPath, { recursive: true, force: true });
    }

    logger.info("Cleaned inactive session artifacts", {
      sessionKey: session.key,
      lastActivityAt: freshCandidate.lastActivityAt,
      cleanedArtifactCount: artifactPaths.length,
      cleanedArtifacts: artifactPaths
    });

    return true;
  }
}

async function findDisposableArtifactPaths(workspacePath: string): Promise<string[]> {
  const artifactPaths = new Set<string>();
  const roots = [workspacePath, ...(await listImmediateChildDirectories(workspacePath))];

  for (const root of roots) {
    const macosRoot = path.join(root, "frontend", "macos");
    const buildRoot = path.join(macosRoot, ".build");
    if (await isDirectory(buildRoot)) {
      artifactPaths.add(buildRoot);
    }

    const defaultProfraw = path.join(macosRoot, "default.profraw");
    if (await isFile(defaultProfraw)) {
      artifactPaths.add(defaultProfraw);
    }

    const macosEntries = await safeReadDir(macosRoot);
    for (const entry of macosEntries) {
      if (!entry.isFile()) {
        continue;
      }

      if (entry.name.startsWith("xcodebuild") && entry.name.endsWith(".log")) {
        artifactPaths.add(path.join(macosRoot, entry.name));
      }
    }
  }

  return [...artifactPaths].sort();
}

async function listImmediateChildDirectories(directoryPath: string): Promise<string[]> {
  const entries = await safeReadDir(directoryPath);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directoryPath, entry.name));
}

async function safeReadDir(directoryPath: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }

    throw error;
  }
}

async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    return (await fs.stat(targetPath)).isDirectory();
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }

    throw error;
  }
}

async function isFile(targetPath: string): Promise<boolean> {
  try {
    return (await fs.stat(targetPath)).isFile();
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }

    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function computeLastActivity(
  session: SlackSessionRecord,
  inboundMessages: readonly PersistedInboundMessage[],
  backgroundJobs: readonly PersistedBackgroundJob[]
): {
  readonly at: string;
  readonly atMs: number;
} {
  const candidates = [
    session.updatedAt,
    session.lastSlackReplyAt,
    session.lastTurnSignalAt,
    ...inboundMessages.flatMap((message) => [message.createdAt, message.updatedAt]),
    ...backgroundJobs.flatMap((job) => [
      job.createdAt,
      job.startedAt,
      job.heartbeatAt,
      job.lastEventAt,
      job.completedAt,
      job.cancelledAt,
      job.updatedAt
    ])
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  let latestAt = session.updatedAt;
  let latestAtMs = Date.parse(latestAt);

  for (const candidate of candidates) {
    const parsed = Date.parse(candidate);
    if (!Number.isFinite(parsed)) {
      continue;
    }

    if (!Number.isFinite(latestAtMs) || parsed > latestAtMs) {
      latestAt = candidate;
      latestAtMs = parsed;
    }
  }

  if (!Number.isFinite(latestAtMs)) {
    latestAt = new Date(0).toISOString();
    latestAtMs = 0;
  }

  return { at: latestAt, atMs: latestAtMs };
}
