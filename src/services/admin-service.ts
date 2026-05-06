import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { AppConfig } from "../config.js";
import { getBrokerLogDirectory } from "../logger.js";
import type {
  AdminOperationKind,
  JsonLike,
  PersistedAdminAuditEvent,
  PersistedAdminOperation,
  PersistedBackgroundJob,
  PersistedInboundMessage,
  SlackSessionRecord
} from "../types.js";
import type { SessionManager } from "./session-manager.js";
import type { AuthProfileService } from "./auth-profile-service.js";
import type { GitHubAuthorMappingService } from "./github-author-mapping-service.js";
import type { RuntimeControl } from "./runtime-control.js";
import type {
  DeployReleaseOptions,
  RollbackReleaseOptions,
  ReleaseDeploymentService
} from "./deploy/release-deployment-service.js";
import {
  serializeAccountError,
  serializeAccountSummary,
  serializeRateLimits,
  serializeRateLimitsError,
  type SerializedAccountStatus,
  type SerializedRateLimitsStatus
} from "./codex/account-status.js";

const LOG_TAIL_MAX_BYTES_PER_FILE = 256 * 1024;

interface FileInfo {
  readonly exists: boolean;
  readonly path: string;
  readonly size?: number | undefined;
  readonly mtime?: string | undefined;
}

interface SessionSnapshot {
  readonly allSessions: readonly SlackSessionRecord[];
  readonly activeSessions: readonly SlackSessionRecord[];
  readonly openInbound: readonly PersistedInboundMessage[];
  readonly backgroundJobs: readonly PersistedBackgroundJob[];
  readonly openInboundBySession: ReadonlyMap<string, readonly PersistedInboundMessage[]>;
  readonly jobsBySession: ReadonlyMap<string, readonly PersistedBackgroundJob[]>;
}

interface RuntimeStatus {
  readonly account: SerializedAccountStatus;
  readonly rateLimits: SerializedRateLimitsStatus;
  readonly deployment: unknown;
  readonly authProfiles: unknown;
  readonly githubAuthorMappings: {
    readonly count: number;
    readonly mappings: readonly unknown[];
  };
}

interface OperationPreflight {
  readonly operation: string;
  readonly safe: boolean;
  readonly requiresAllowActive: boolean;
  readonly activeCount: number;
  readonly openInboundCount: number;
  readonly runningBackgroundJobCount: number;
  readonly impacts: readonly Record<string, JsonLike>[];
}

interface AdminOperationStore {
  readonly listAdminOperations?: ((limit?: number) => PersistedAdminOperation[]) | undefined;
  readonly upsertAdminOperation?: ((record: PersistedAdminOperation) => Promise<void>) | undefined;
  readonly listAdminAuditEvents?: ((options?: {
    readonly operationId?: string | undefined;
    readonly limit?: number | undefined;
  }) => PersistedAdminAuditEvent[]) | undefined;
  readonly appendAdminAuditEvent?: ((record: PersistedAdminAuditEvent) => Promise<void>) | undefined;
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
      readonly deployment?: ReleaseDeploymentService | undefined;
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
    const snapshot = await this.#readSessionSnapshot();
    const runtime = await this.#readRuntimeStatus();
    const sessionSummaries = snapshot.allSessions.slice(0, 50).map((session) =>
      this.#summarizeSession(session, {
        inbound: snapshot.openInboundBySession.get(session.key) ?? [],
        jobs: snapshot.jobsBySession.get(session.key) ?? []
      })
    );
    const stateCounts = this.#summarizeStateCounts(snapshot);

    return {
      service: this.#serviceInfo(),
      authFiles: {
        authJson: await this.#fileInfo(path.join(this.options.config.codexHome, "auth.json")),
        credentialsJson: await this.#fileInfo(path.join(this.options.config.codexHome, ".credentials.json")),
        configToml: await this.#fileInfo(path.join(this.options.config.codexHome, "config.toml"))
      },
      authProfiles: runtime.authProfiles,
      githubAuthorMappings: runtime.githubAuthorMappings,
      account: runtime.account,
      rateLimits: runtime.rateLimits,
      deployment: runtime.deployment,
      operations: this.#listAdminOperations(10),
      auditEvents: this.#listAdminAuditEvents({ limit: 10 }),
      state: {
        ...stateCounts,
        activeSessions: snapshot.activeSessions,
        openInbound: snapshot.openInbound.slice(0, 25).map((message) => this.#summarizeInbound(message)),
        sessions: sessionSummaries,
        recentBrokerLogs: await this.#readRecentBrokerLogs(40)
      }
    };
  }

  async getOverview(): Promise<Record<string, unknown>> {
    const snapshot = await this.#readSessionSnapshot();
    const runtime = await this.#readRuntimeStatus();
    return {
      ok: true,
      service: this.#serviceInfo(),
      authProfiles: runtime.authProfiles,
      githubAuthorMappings: runtime.githubAuthorMappings,
      account: runtime.account,
      rateLimits: runtime.rateLimits,
      deployment: runtime.deployment,
      operations: this.#listAdminOperations(10),
      auditEvents: this.#listAdminAuditEvents({ limit: 10 }),
      state: this.#summarizeStateCounts(snapshot)
    };
  }

  async listSessionSummaries(): Promise<Record<string, unknown>> {
    const snapshot = await this.#readSessionSnapshot();
    return {
      ok: true,
      sessions: snapshot.allSessions.slice(0, 100).map((session) =>
        this.#summarizeSession(session, {
          inbound: snapshot.openInboundBySession.get(session.key) ?? [],
          jobs: snapshot.jobsBySession.get(session.key) ?? []
        })
      )
    };
  }

  async getSessionTimeline(sessionKey: string): Promise<Record<string, unknown>> {
    await this.#refreshSessions();
    const session = this.options.sessions.getSessionByKey(sessionKey);
    if (!session) {
      return {
        ok: false,
        error: "session_not_found",
        sessionKey
      };
    }

    const inbound = this.options.sessions.listInboundMessages({
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs
    });
    const openInbound = this.options.sessions.listInboundMessages({
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs,
      status: ["pending", "inflight"]
    });
    const jobs = this.options.sessions.listBackgroundJobs({
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs
    });

    const events: Array<Record<string, JsonLike>> = [
      {
        type: "session_created",
        at: session.createdAt,
        status: session.activeTurnId ? "active" : "idle",
        summary: session.workspacePath
      }
    ];

    for (const message of inbound) {
      events.push({
        type: "inbound_message",
        at: message.updatedAt ?? message.createdAt,
        status: message.status,
        summary: message.text.slice(0, 160),
        sessionKey: message.sessionKey,
        messageTs: message.messageTs,
        source: message.source,
        userId: message.userId
      });
    }

    for (const job of jobs) {
      events.push({
        type: "background_job",
        at: job.updatedAt ?? job.createdAt,
        status: job.status,
        summary: job.kind,
        sessionKey: job.sessionKey,
        jobId: job.id
      });
    }

    if (session.lastTurnSignalKind) {
      events.push({
        type: "turn_signal",
        at: session.lastTurnSignalAt ?? session.updatedAt,
        status: session.lastTurnSignalKind,
        summary: session.lastTurnSignalReason ?? session.lastTurnSignalKind,
        sessionKey: session.key,
        turnId: session.lastTurnSignalTurnId ?? null
      });
    }

    return {
      ok: true,
      session: this.#summarizeSession(session, {
        inbound: openInbound,
        jobs
      }),
      events: events.sort(compareTimelineEvents)
    };
  }

  async getOperationPreflight(options: {
    readonly operation: string;
  }): Promise<Record<string, unknown>> {
    return {
      ok: true,
      ...await this.#readOperationPreflight(options.operation)
    };
  }

  async listAdminOperations(): Promise<Record<string, unknown>> {
    return {
      ok: true,
      operations: this.#listAdminOperations(50)
    };
  }

  async listAdminAuditEvents(options?: {
    readonly operationId?: string | undefined;
  }): Promise<Record<string, unknown>> {
    return {
      ok: true,
      events: this.#listAdminAuditEvents({
        operationId: options?.operationId,
        limit: 50
      })
    };
  }

  async addAuthProfile(options: {
    readonly name?: string | undefined;
    readonly authJsonContent: string;
  }): Promise<Record<string, unknown>> {
    return await this.#runTrackedOperation(
      "auth_profile_add",
      {
        name: options.name ?? null,
        authJsonBytes: Buffer.byteLength(options.authJsonContent, "utf8")
      },
      async () => {
        const profile = await this.options.authProfiles.addProfile(options);
        return {
          ok: true,
          profile
        };
      }
    );
  }

  async deleteAuthProfile(options: {
    readonly name: string;
  }): Promise<Record<string, unknown>> {
    return await this.#runTrackedOperation(
      "auth_profile_delete",
      {
        name: options.name
      },
      async () => {
        await this.options.authProfiles.deleteProfile(options.name);
        return {
          ok: true,
          deletedProfile: options.name
        };
      }
    );
  }

  async activateAuthProfile(options: {
    readonly name: string;
    readonly allowActive: boolean;
  }): Promise<Record<string, unknown>> {
    return await this.#runTrackedOperation(
      "auth_profile_activate",
      {
        name: options.name,
        allowActive: options.allowActive
      },
      async () => {
        await this.#assertSafeToInterrupt(options.allowActive, "auth profile switch");
        const activated = await this.options.authProfiles.activateProfile(options.name);
        await this.options.runtime.restartRuntime(`admin auth profile switch: ${activated.name}`);
        return {
          ok: true,
          activatedProfile: activated.name
        };
      }
    );
  }

  async deployRelease(options: {
    readonly ref: string;
    readonly allowActive: boolean;
  }): Promise<Record<string, unknown>> {
    if (!this.options.deployment) {
      throw new Error("Release deployment is not configured for this runtime.");
    }

    return await this.#runTrackedOperation(
      "deploy",
      {
        ref: options.ref,
        allowActive: options.allowActive
      },
      async () => {
        await this.#assertSafeToInterrupt(options.allowActive, "deploy");
        const deployment = await this.options.deployment!.deploy({
          ref: options.ref
        } satisfies DeployReleaseOptions);
        return {
          ok: true,
          deployment
        };
      }
    );
  }

  async rollbackRelease(options: {
    readonly ref?: string | undefined;
    readonly allowActive: boolean;
  }): Promise<Record<string, unknown>> {
    if (!this.options.deployment) {
      throw new Error("Release deployment is not configured for this runtime.");
    }

    return await this.#runTrackedOperation(
      "rollback",
      {
        ref: options.ref ?? null,
        allowActive: options.allowActive
      },
      async () => {
        await this.#assertSafeToInterrupt(options.allowActive, "rollback");
        const deployment = await this.options.deployment!.rollback({
          ref: options.ref
        } satisfies RollbackReleaseOptions);
        return {
          ok: true,
          deployment
        };
      }
    );
  }

  async upsertGitHubAuthorMapping(options: {
    readonly slackUserId: string;
    readonly githubAuthor: string;
  }): Promise<Record<string, unknown>> {
    return await this.#runTrackedOperation(
      "github_author_upsert",
      {
        slackUserId: options.slackUserId,
        githubAuthor: options.githubAuthor
      },
      async () => {
        await this.options.githubAuthorMappings.load();
        const mapping = await this.options.githubAuthorMappings.upsertManualMapping({
          slackUserId: options.slackUserId,
          githubAuthor: options.githubAuthor
        });
        return {
          ok: true,
          mapping
        };
      }
    );
  }

  async deleteGitHubAuthorMapping(options: {
    readonly slackUserId: string;
  }): Promise<Record<string, unknown>> {
    return await this.#runTrackedOperation(
      "github_author_delete",
      {
        slackUserId: options.slackUserId
      },
      async () => {
        await this.options.githubAuthorMappings.load();
        await this.options.githubAuthorMappings.deleteMapping(options.slackUserId);
        return {
          ok: true,
          slackUserId: options.slackUserId
        };
      }
    );
  }

  async #readRuntimeStatus(): Promise<RuntimeStatus> {
    await this.options.githubAuthorMappings.load();
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
    const mappings = this.options.githubAuthorMappings.listMappings();
    return {
      account,
      rateLimits,
      deployment,
      authProfiles,
      githubAuthorMappings: {
        count: mappings.length,
        mappings
      }
    };
  }

  async #readSessionSnapshot(): Promise<SessionSnapshot> {
    await this.#refreshSessions();
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

    return {
      allSessions,
      activeSessions,
      openInbound,
      backgroundJobs,
      openInboundBySession: groupBySession(openInbound),
      jobsBySession: groupBySession(backgroundJobs)
    };
  }

  #summarizeStateCounts(snapshot: SessionSnapshot): Record<string, unknown> {
    const runningBackgroundJobCount = snapshot.backgroundJobs.filter((job) => job.status === "running").length;
    const failedBackgroundJobCount = snapshot.backgroundJobs.filter((job) => job.status === "failed").length;
    const openHumanInboundCount = snapshot.openInbound.filter(isHumanInboundMessage).length;
    return {
      sessionCount: snapshot.allSessions.length,
      activeCount: snapshot.activeSessions.length,
      openInboundCount: snapshot.openInbound.length,
      openHumanInboundCount,
      openSystemInboundCount: snapshot.openInbound.length - openHumanInboundCount,
      backgroundJobCount: snapshot.backgroundJobs.length,
      runningBackgroundJobCount,
      failedBackgroundJobCount
    };
  }

  #serviceInfo(): Record<string, unknown> {
    return {
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
    };
  }

  async #readOperationPreflight(operation: string): Promise<OperationPreflight> {
    const snapshot = await this.#readSessionSnapshot();
    const runningJobs = snapshot.backgroundJobs.filter((job) => job.status === "running");
    const impacts: Array<Record<string, JsonLike>> = [];

    for (const session of snapshot.activeSessions) {
      impacts.push({
        type: "active_turn",
        sessionKey: session.key,
        channelId: session.channelId,
        rootThreadTs: session.rootThreadTs,
        turnId: session.activeTurnId ?? null,
        startedAt: session.activeTurnStartedAt ?? null
      });
    }

    for (const message of snapshot.openInbound) {
      impacts.push({
        type: "open_inbound",
        sessionKey: message.sessionKey,
        channelId: message.channelId,
        rootThreadTs: message.rootThreadTs,
        messageTs: message.messageTs,
        source: message.source,
        status: message.status,
        summary: message.text.slice(0, 160)
      });
    }

    for (const job of runningJobs) {
      impacts.push({
        type: "running_background_job",
        sessionKey: job.sessionKey,
        channelId: job.channelId,
        rootThreadTs: job.rootThreadTs,
        jobId: job.id,
        kind: job.kind,
        status: job.status,
        updatedAt: job.updatedAt
      });
    }

    return {
      operation,
      safe: impacts.length === 0,
      requiresAllowActive: impacts.length > 0,
      activeCount: snapshot.activeSessions.length,
      openInboundCount: snapshot.openInbound.length,
      runningBackgroundJobCount: runningJobs.length,
      impacts
    };
  }

  async #runTrackedOperation<T extends Record<string, unknown>>(
    kind: AdminOperationKind,
    request: JsonLike,
    operationBody: () => Promise<T>
  ): Promise<T & { readonly operation: PersistedAdminOperation }> {
    const startedAt = new Date().toISOString();
    let operation: PersistedAdminOperation = {
      id: randomUUID(),
      kind,
      status: "running",
      request,
      createdAt: startedAt,
      updatedAt: startedAt,
      startedAt
    };

    await this.#persistAdminOperation(operation);
    await this.#appendAdminAuditEvent({
      id: randomUUID(),
      operationId: operation.id,
      action: kind,
      status: "started",
      detail: {
        request
      },
      createdAt: startedAt
    });

    let payload: T;
    try {
      payload = await operationBody();
    } catch (error) {
      const completedAt = new Date().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      operation = {
        ...operation,
        status: "failed",
        error: message,
        updatedAt: completedAt,
        completedAt
      };
      await this.#persistAdminOperation(operation);
      await this.#appendAdminAuditEvent({
        id: randomUUID(),
        operationId: operation.id,
        action: kind,
        status: "failed",
        detail: {
          error: message
        },
        createdAt: completedAt
      });
      throw error;
    }

    const completedAt = new Date().toISOString();
    operation = {
      ...operation,
      status: "succeeded",
      result: {
        ok: true
      },
      updatedAt: completedAt,
      completedAt
    };
    await this.#persistAdminOperation(operation);
    await this.#appendAdminAuditEvent({
      id: randomUUID(),
      operationId: operation.id,
      action: kind,
      status: "succeeded",
      detail: {
        result: {
          ok: true
        }
      },
      createdAt: completedAt
    });
    return {
      ...payload,
      operation,
      status: await this.getStatus()
    } as T & { readonly operation: PersistedAdminOperation };
  }

  async #persistAdminOperation(operation: PersistedAdminOperation): Promise<void> {
    const store = this.#operationStore();
    if (!store.upsertAdminOperation) {
      return;
    }
    await store.upsertAdminOperation.call(this.options.sessions, operation);
  }

  async #appendAdminAuditEvent(event: PersistedAdminAuditEvent): Promise<void> {
    const store = this.#operationStore();
    if (!store.appendAdminAuditEvent) {
      return;
    }
    await store.appendAdminAuditEvent.call(this.options.sessions, event);
  }

  #listAdminOperations(limit: number): readonly PersistedAdminOperation[] {
    const store = this.#operationStore();
    return store.listAdminOperations?.call(this.options.sessions, limit) ?? [];
  }

  #listAdminAuditEvents(options: {
    readonly operationId?: string | undefined;
    readonly limit: number;
  }): readonly PersistedAdminAuditEvent[] {
    const store = this.#operationStore();
    return store.listAdminAuditEvents?.call(this.options.sessions, options) ?? [];
  }

  #operationStore(): AdminOperationStore {
    return this.options.sessions as unknown as AdminOperationStore;
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

    const preflight = await this.#readOperationPreflight(action);
    if (preflight.requiresAllowActive) {
      throw new Error(
        `Refusing ${action} while admin work is in flight (activeCount=${preflight.activeCount}, openInboundCount=${preflight.openInboundCount}, runningBackgroundJobCount=${preflight.runningBackgroundJobCount}). Retry with allow_active=true if you really want to interrupt it.`
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
      const records = await readJsonlFileTail(file.path, Math.max(0, limit - recordCount));
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
      activeTurnStartedAt: session.activeTurnStartedAt ?? null,
      lastTurnSignalKind: session.lastTurnSignalKind ?? null,
      lastTurnSignalReason: session.lastTurnSignalReason ?? null,
      lastTurnSignalAt: session.lastTurnSignalAt ?? null,
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

function compareTimelineEvents(left: Record<string, JsonLike>, right: Record<string, JsonLike>): number {
  if (left.type === "session_created" && right.type !== "session_created") {
    return -1;
  }
  if (right.type === "session_created" && left.type !== "session_created") {
    return 1;
  }
  return String(left.at ?? "").localeCompare(String(right.at ?? ""));
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

async function readJsonlFileTail(filePath: string, limit: number): Promise<unknown[]> {
  if (limit <= 0) {
    return [];
  }

  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (stat.size === 0) {
      return [];
    }

    const readLength = Math.min(stat.size, LOG_TAIL_MAX_BYTES_PER_FILE);
    const start = stat.size - readLength;
    const buffer = Buffer.alloc(readLength);
    const { bytesRead } = await handle.read(buffer, 0, readLength, start);
    let raw = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const firstNewline = raw.indexOf("\n");
      raw = firstNewline >= 0 ? raw.slice(firstNewline + 1) : "";
    }

    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      });
  } finally {
    await handle.close();
  }
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
