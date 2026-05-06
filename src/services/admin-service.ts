import fs from "node:fs/promises";
import path from "node:path";

import type { AppConfig } from "../config.js";
import { getBrokerLogDirectory } from "../logger.js";
import type { PersistedBackgroundJob, PersistedInboundMessage, SlackSessionRecord } from "../types.js";
import type { SessionManager } from "./session-manager.js";
import type { AuthProfileService } from "./auth-profile-service.js";
import type { GitHubAuthorMappingService } from "./github-author-mapping-service.js";
import type { RuntimeControl } from "./runtime-control.js";
import type {
  DeployWorkerOptions,
  RollbackWorkerOptions,
  WorkerDeploymentService
} from "./deploy/worker-deployment-service.js";
import {
  serializeAccountError,
  serializeAccountSummary,
  serializeRateLimits,
  serializeRateLimitsError,
  type SerializedAccountStatus,
  type SerializedRateLimitsStatus
} from "./codex/account-status.js";

interface FileInfo {
  readonly exists: boolean;
  readonly path: string;
  readonly size?: number | undefined;
  readonly mtime?: string | undefined;
}

export class AdminService {
  constructor(
    private readonly options: {
      readonly config: AppConfig;
      readonly sessions: SessionManager;
      readonly runtime: RuntimeControl;
      readonly authProfiles: AuthProfileService;
      readonly githubAuthorMappings: GitHubAuthorMappingService;
      readonly startedAt: Date;
      readonly deployment?: WorkerDeploymentService | undefined;
    }
  ) {}

  getAdminUiBootstrap(): {
    readonly tokenConfigured: boolean;
    readonly serviceName: string;
  } {
    return {
      tokenConfigured: Boolean(this.options.config.brokerAdminToken),
      serviceName: this.options.config.serviceName
    };
  }

  async getStatus(): Promise<Record<string, unknown>> {
    await this.#refreshSessions();
    await this.options.githubAuthorMappings.load();
    const allSessions = this.options.sessions
      .listSessions()
      .sort((left, right) => compareSessions(left, right));
    const activeSessions = allSessions.filter((session) => Boolean(session.activeTurnId));
    const openInbound = this.options.sessions
      .listInboundMessages({
        status: ["pending", "inflight"]
      })
      .sort((left, right) => String(left.updatedAt ?? "").localeCompare(String(right.updatedAt ?? "")));
    const backgroundJobs = this.options.sessions
      .listBackgroundJobs()
      .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
    const openInboundBySession = groupBySession(openInbound);
    const jobsBySession = groupBySession(backgroundJobs);
    const sessionSummaries = allSessions.slice(0, 50).map((session) =>
      this.#summarizeSession(session, {
        inbound: openInboundBySession.get(session.key) ?? [],
        jobs: jobsBySession.get(session.key) ?? []
      })
    );
    const [account, rateLimits, deployment] = await Promise.all([
      this.#readAccountSummary(),
      this.#readAccountRateLimits(),
      this.options.deployment?.getStatus() ?? Promise.resolve(null)
    ]);
    const authProfiles = await this.options.authProfiles.listProfilesStatus({
      activeSnapshot:
        account.ok && rateLimits.ok
          ? {
              source: "runtime",
              checkedAt: new Date().toISOString(),
              account,
              rateLimits
            }
          : undefined
    });
    const backgroundJobCount = backgroundJobs.length;
    const runningBackgroundJobCount = backgroundJobs.filter((job) => job.status === "running").length;
    const failedBackgroundJobCount = backgroundJobs.filter((job) => job.status === "failed").length;
    const openHumanInboundCount = openInbound.filter(isHumanInboundMessage).length;
    const openSystemInboundCount = openInbound.length - openHumanInboundCount;

    return {
      service: {
        name: this.options.config.serviceName,
        mode: this.options.deployment ? "admin" : "combined",
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
        startedAt: this.options.startedAt.toISOString(),
        port: this.options.config.port,
        brokerHttpBaseUrl: this.options.config.brokerHttpBaseUrl,
        workerBaseUrl: this.options.config.workerBaseUrl,
        sessionsRoot: this.options.config.sessionsRoot,
        reposRoot: this.options.config.reposRoot,
        codexHome: this.options.config.codexHome,
        adminTokenConfigured: Boolean(this.options.config.brokerAdminToken)
      },
      authFiles: {
        authJson: await this.#fileInfo(path.join(this.options.config.codexHome, "auth.json")),
        credentialsJson: await this.#fileInfo(path.join(this.options.config.codexHome, ".credentials.json")),
        configToml: await this.#fileInfo(path.join(this.options.config.codexHome, "config.toml"))
      },
      authProfiles,
      githubAuthorMappings: {
        count: this.options.githubAuthorMappings.listMappings().length,
        mappings: this.options.githubAuthorMappings.listMappings()
      },
      account,
      rateLimits,
      deployment,
      state: {
        sessionCount: allSessions.length,
        activeCount: activeSessions.length,
        activeSessions,
        openInboundCount: openInbound.length,
        openHumanInboundCount,
        openSystemInboundCount,
        openInbound: openInbound.slice(0, 25).map((message) => this.#summarizeInbound(message)),
        backgroundJobCount,
        runningBackgroundJobCount,
        failedBackgroundJobCount,
        sessions: sessionSummaries,
        recentBrokerLogs: await this.#readRecentBrokerLogs(40)
      }
    };
  }

  async addAuthProfile(options: {
    readonly name?: string | undefined;
    readonly authJsonContent: string;
  }): Promise<Record<string, unknown>> {
    const profile = await this.options.authProfiles.addProfile(options);
    return {
      ok: true,
      profile,
      status: await this.getStatus()
    };
  }

  async deleteAuthProfile(options: {
    readonly name: string;
  }): Promise<Record<string, unknown>> {
    await this.options.authProfiles.deleteProfile(options.name);
    return {
      ok: true,
      deletedProfile: options.name,
      status: await this.getStatus()
    };
  }

  async activateAuthProfile(options: {
    readonly name: string;
    readonly allowActive: boolean;
  }): Promise<Record<string, unknown>> {
    await this.#assertSafeToInterrupt(options.allowActive, "auth profile switch");
    const activated = await this.options.authProfiles.activateProfile(options.name);
    await this.options.runtime.restartRuntime(`admin auth profile switch: ${activated.name}`);
    return {
      ok: true,
      activatedProfile: activated.name,
      status: await this.getStatus()
    };
  }

  async deployWorker(options: {
    readonly ref: string;
    readonly allowActive: boolean;
  }): Promise<Record<string, unknown>> {
    if (!this.options.deployment) {
      throw new Error("Worker deployment is not configured for this runtime.");
    }

    await this.#assertSafeToInterrupt(options.allowActive, "deploy");
    const deployment = await this.options.deployment.deploy({
      ref: options.ref
    } satisfies DeployWorkerOptions);
    return {
      ok: true,
      deployment,
      status: await this.getStatus()
    };
  }

  async rollbackWorker(options: {
    readonly ref?: string | undefined;
    readonly allowActive: boolean;
  }): Promise<Record<string, unknown>> {
    if (!this.options.deployment) {
      throw new Error("Worker deployment is not configured for this runtime.");
    }

    await this.#assertSafeToInterrupt(options.allowActive, "rollback");
    const deployment = await this.options.deployment.rollback({
      ref: options.ref
    } satisfies RollbackWorkerOptions);
    return {
      ok: true,
      deployment,
      status: await this.getStatus()
    };
  }

  async upsertGitHubAuthorMapping(options: {
    readonly slackUserId: string;
    readonly githubAuthor: string;
  }): Promise<Record<string, unknown>> {
    await this.options.githubAuthorMappings.load();
    const mapping = await this.options.githubAuthorMappings.upsertManualMapping({
      slackUserId: options.slackUserId,
      githubAuthor: options.githubAuthor
    });
    return {
      ok: true,
      mapping,
      status: await this.getStatus()
    };
  }

  async deleteGitHubAuthorMapping(options: {
    readonly slackUserId: string;
  }): Promise<Record<string, unknown>> {
    await this.options.githubAuthorMappings.load();
    await this.options.githubAuthorMappings.deleteMapping(options.slackUserId);
    return {
      ok: true,
      slackUserId: options.slackUserId,
      status: await this.getStatus()
    };
  }

  async #readAccountSummary(): Promise<SerializedAccountStatus> {
    try {
      return serializeAccountSummary(await this.options.runtime.readAccountSummary(false));
    } catch (error) {
      return serializeAccountError(error);
    }
  }

  async #readAccountRateLimits(): Promise<SerializedRateLimitsStatus> {
    try {
      return serializeRateLimits(await this.options.runtime.readAccountRateLimits());
    } catch (error) {
      return serializeRateLimitsError(error);
    }
  }

  async #assertSafeToInterrupt(allowActive: boolean, action: string): Promise<void> {
    if (allowActive) {
      return;
    }

    await this.#refreshSessions();
    const activeCount = this.options.sessions.listSessions().filter((session) => Boolean(session.activeTurnId)).length;
    if (activeCount > 0) {
      throw new Error(
        `Refusing ${action} while active sessions exist (activeCount=${activeCount}). Retry with allow_active=true if you really want to interrupt them.`
      );
    }
  }

  async #refreshSessions(): Promise<void> {
    const load = (this.options.sessions as { readonly load?: (() => Promise<void>) | undefined }).load;
    if (typeof load === "function") {
      await load.call(this.options.sessions);
    }
  }

  async #fileInfo(filePath: string): Promise<FileInfo> {
    try {
      const stat = await fs.stat(filePath);
      return {
        exists: true,
        path: filePath,
        size: stat.size,
        mtime: stat.mtime.toISOString()
      };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return {
          exists: false,
          path: filePath
        };
      }

      throw error;
    }
  }

  async #readRecentBrokerLogs(limit: number): Promise<readonly unknown[]> {
    if (limit <= 0) {
      return [];
    }

    const files = await listJsonlFiles(getBrokerLogDirectory(this.options.config.logDir));
    const chunks: unknown[][] = [];
    let recordCount = 0;

    for (const file of files.sort((left, right) =>
      right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path)
    )) {
      const records = await readJsonlFile(file.path);
      chunks.push(records);
      recordCount += records.length;
      if (recordCount >= limit) {
        break;
      }
    }

    return chunks.reverse().flat().slice(-limit);
  }

  #summarizeInbound(message: PersistedInboundMessage): Record<string, unknown> {
    return {
      sessionKey: message.sessionKey,
      messageTs: message.messageTs,
      source: message.source,
      status: message.status,
      userId: message.userId,
      textPreview: message.text.slice(0, 160),
      updatedAt: message.updatedAt,
      batchId: message.batchId ?? null
    };
  }

  #summarizeJob(job: PersistedBackgroundJob): Record<string, unknown> {
    return {
      id: job.id,
      sessionKey: job.sessionKey,
      kind: job.kind,
      status: job.status,
      cwd: job.cwd,
      updatedAt: job.updatedAt,
      heartbeatAt: job.heartbeatAt ?? null,
      lastEventAt: job.lastEventAt ?? null,
      error: job.error ?? null
    };
  }

  #summarizeSession(
    session: SlackSessionRecord,
    related: {
      readonly inbound: readonly PersistedInboundMessage[];
      readonly jobs: readonly PersistedBackgroundJob[];
    }
  ): Record<string, unknown> {
    const runningBackgroundJobCount = related.jobs.filter((job) => job.status === "running").length;
    const failedBackgroundJobCount = related.jobs.filter((job) => job.status === "failed").length;
    const openHumanInboundCount = related.inbound.filter(isHumanInboundMessage).length;
    const openSystemInboundCount = related.inbound.length - openHumanInboundCount;
    return {
      key: session.key,
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs,
      workspacePath: session.workspacePath,
      updatedAt: session.updatedAt,
      createdAt: session.createdAt,
      activeTurnId: session.activeTurnId ?? null,
      lastSlackReplyAt: session.lastSlackReplyAt ?? null,
      lastObservedMessageTs: session.lastObservedMessageTs ?? null,
      lastDeliveredMessageTs: session.lastDeliveredMessageTs ?? null,
      openInboundCount: related.inbound.length,
      openHumanInboundCount,
      openSystemInboundCount,
      openInbound: related.inbound.slice(0, 5).map((message) => this.#summarizeInbound(message)),
      backgroundJobCount: related.jobs.length,
      runningBackgroundJobCount,
      failedBackgroundJobCount,
      backgroundJobs: related.jobs.slice(0, 5).map((job) => this.#summarizeJob(job))
    };
  }
}

function compareSessions(left: SlackSessionRecord, right: SlackSessionRecord): number {
  const leftActive = left.activeTurnId ? 1 : 0;
  const rightActive = right.activeTurnId ? 1 : 0;
  if (leftActive !== rightActive) {
    return rightActive - leftActive;
  }
  return String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""));
}

async function listJsonlFiles(directoryPath: string): Promise<Array<{
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
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }
    const filePath = path.join(directoryPath, entry.name);
    const stat = await fs.stat(filePath);
    files.push({
      path: filePath,
      mtimeMs: stat.mtimeMs
    });
  }
  return files;
}

async function readJsonlFile(filePath: string): Promise<unknown[]> {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });
}

function groupBySession<T extends { readonly sessionKey: string }>(items: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const existing = groups.get(item.sessionKey);
    if (existing) {
      existing.push(item);
      continue;
    }
    groups.set(item.sessionKey, [item]);
  }
  return groups;
}

function isHumanInboundMessage(message: PersistedInboundMessage): boolean {
  return (
    message.source === "app_mention" ||
    message.source === "direct_message" ||
    message.source === "thread_reply"
  );
}
