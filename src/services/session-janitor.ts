import fs from "node:fs/promises";
import path from "node:path";

import { logger } from "../logger.js";
import type {
  PersistedBackgroundJob,
  PersistedInboundMessage,
  SlackSessionRecord,
  SlackTurnSignalKind
} from "../types.js";
import { SessionManager } from "./session-manager.js";

interface SessionJanitorCandidate {
  readonly session: SlackSessionRecord;
  readonly inboundMessages: readonly PersistedInboundMessage[];
  readonly backgroundJobs: readonly PersistedBackgroundJob[];
  readonly lastActivityAt: string;
  readonly lastActivityAtMs: number;
}

export interface SessionJanitorSweepResult {
  readonly reason: string;
  readonly checkedCount: number;
  readonly cleanedCount: number;
  readonly cleanedSessionKeys: readonly string[];
}

export class SessionJanitor {
  readonly #sessions: SessionManager;
  readonly #sessionsRoot: string;
  readonly #jobsRoot: string;
  readonly #logDir: string;
  readonly #inactivityTtlMs: number;
  readonly #cleanupIntervalMs: number;
  readonly #cleanupMaxPerSweep: number;
  readonly #now: () => number;

  #timer: NodeJS.Timeout | undefined;

  constructor(options: {
    readonly sessions: SessionManager;
    readonly sessionsRoot: string;
    readonly jobsRoot: string;
    readonly logDir: string;
    readonly inactivityTtlMs: number;
    readonly cleanupIntervalMs: number;
    readonly cleanupMaxPerSweep: number;
    readonly now?: (() => number) | undefined;
  }) {
    this.#sessions = options.sessions;
    this.#sessionsRoot = options.sessionsRoot;
    this.#jobsRoot = options.jobsRoot;
    this.#logDir = options.logDir;
    this.#inactivityTtlMs = options.inactivityTtlMs;
    this.#cleanupIntervalMs = options.cleanupIntervalMs;
    this.#cleanupMaxPerSweep = options.cleanupMaxPerSweep;
    this.#now = options.now ?? (() => Date.now());
  }

  async start(): Promise<void> {
    if (!this.#isSweepEnabled()) {
      logger.info("Session janitor disabled", {
        inactivityTtlMs: this.#inactivityTtlMs,
        cleanupIntervalMs: this.#cleanupIntervalMs,
        cleanupMaxPerSweep: this.#cleanupMaxPerSweep
      });
      return;
    }

    await this.runSweep("startup");

    if (!this.#isPeriodicSweepEnabled()) {
      logger.info("Session janitor ran startup sweep only", {
        inactivityTtlMs: this.#inactivityTtlMs,
        cleanupIntervalMs: this.#cleanupIntervalMs,
        cleanupMaxPerSweep: this.#cleanupMaxPerSweep
      });
      return;
    }

    this.#timer = setInterval(() => {
      void this.runSweep("periodic").catch((error) => {
        logger.error("Session janitor periodic sweep failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }, this.#cleanupIntervalMs);

    logger.info("Session janitor started", {
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

  async runSweep(reason: string): Promise<SessionJanitorSweepResult> {
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
      .filter((candidate): candidate is SessionJanitorCandidate => candidate !== null)
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
        logger.error("Failed to clean inactive Slack session", {
          cleanedSessionKey: candidate.session.key,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (cleanedSessionKeys.length > 0 || reason === "startup") {
      logger.info("Session janitor sweep finished", {
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

  #getCandidate(session: SlackSessionRecord, nowMs: number): SessionJanitorCandidate | null {
    if (session.activeTurnId) {
      return null;
    }

    if (!isCleanupEligibleTurnSignal(session.lastTurnSignalKind)) {
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
      inboundMessages,
      backgroundJobs,
      lastActivityAt: lastActivity.at,
      lastActivityAtMs: lastActivity.atMs
    };
  }

  async #cleanupCandidate(candidate: SessionJanitorCandidate, nowMs: number): Promise<boolean> {
    const session = this.#sessions.getSessionByKey(candidate.session.key);
    if (!session) {
      return false;
    }

    const freshCandidate = this.#getCandidate(session, nowMs);
    if (!freshCandidate) {
      return false;
    }

    for (const job of freshCandidate.backgroundJobs) {
      await this.#sessions.deleteBackgroundJob(job.id);
    }
    await this.#sessions.deleteInboundSession(session.channelId, session.rootThreadTs);
    await this.#sessions.deleteSession(session.channelId, session.rootThreadTs);

    await Promise.all([
      this.#deletePath(resolveSessionArtifactPath(this.#sessionsRoot, session.workspacePath)),
      ...freshCandidate.backgroundJobs.map((job) => this.#deletePath(path.join(this.#jobsRoot, job.id))),
      this.#deletePath(path.join(this.#logDir, "sessions", `${encodeKey(session.key)}.jsonl`)),
      ...freshCandidate.backgroundJobs.map((job) =>
        this.#deletePath(path.join(this.#logDir, "jobs", `${encodeKey(job.id)}.jsonl`))
      )
    ]);

    logger.info("Cleaned inactive Slack session", {
      cleanedSessionKey: session.key,
      lastActivityAt: freshCandidate.lastActivityAt,
      cleanedInboundCount: freshCandidate.inboundMessages.length,
      cleanedBackgroundJobCount: freshCandidate.backgroundJobs.length
    });

    return true;
  }

  async #deletePath(targetPath: string | undefined): Promise<void> {
    if (!targetPath) {
      return;
    }

    await fs.rm(targetPath, { recursive: true, force: true });
  }
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

function resolveSessionArtifactPath(sessionsRoot: string, workspacePath: string): string | undefined {
  const resolvedSessionsRoot = path.resolve(sessionsRoot);
  const resolvedWorkspacePath = path.resolve(workspacePath);
  const sessionDir = path.dirname(resolvedWorkspacePath);

  if (path.basename(resolvedWorkspacePath) === "workspace" && isSubpathOf(resolvedSessionsRoot, sessionDir)) {
    return sessionDir;
  }

  if (isSubpathOf(resolvedSessionsRoot, resolvedWorkspacePath)) {
    return resolvedWorkspacePath;
  }

  return undefined;
}

function isSubpathOf(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function encodeKey(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function isCleanupEligibleTurnSignal(kind: SlackTurnSignalKind | undefined): boolean {
  return kind === "final" || kind === "block";
}
