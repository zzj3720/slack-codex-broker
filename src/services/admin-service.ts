import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { AppConfig } from "../config.js";
import { getBrokerLogDirectory, getJobLogDirectory, getSessionLogDirectory, logger } from "../logger.js";
import type {
  AdminOperationKind,
  JsonLike,
  PersistedAdminAuditEvent,
  PersistedAdminEvent,
  PersistedAdminOperation,
  PersistedAgentSessionTraceSummary,
  PersistedAgentSessionUsageSummary,
  PersistedAgentTraceEvent,
  PersistedBackgroundJob,
  PersistedAgentTurnUsage,
  PersistedInboundMessage,
  SlackSessionRecord,
  SlackUserIdentity
} from "../types.js";
import type { SessionManager } from "./session-manager.js";
import type { AuthProfileService } from "./auth-profile-service.js";
import type { GitHubAuthorMappingService } from "./github-author-mapping-service.js";
import type { GitHubPrBindingRecord, GitHubPrIdentityService, GitHubPrIdentityStatus } from "./github-pr-identity-service.js";
import type { RuntimeControl } from "./runtime-control.js";
import {
  authProfileReasonLabel,
  evaluateAuthProfile,
  findAuthProfile,
  selectBestAuthProfile
} from "./session-auth-profile-selector.js";
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
import { resolveMentionText } from "./slack/slack-message-format.js";

const LOG_TAIL_MAX_BYTES_PER_FILE = 256 * 1024;
const ADMIN_RUNTIME_PROBE_TIMEOUT_MS = 4_000;

interface FileInfo {
  readonly exists: boolean;
  readonly path: string;
  readonly size?: number | undefined;
  readonly mtime?: string | undefined;
}

interface SessionSnapshot {
  readonly allSessions: readonly SlackSessionRecord[];
  readonly activeSessions: readonly SlackSessionRecord[];
  readonly inbound: readonly PersistedInboundMessage[];
  readonly openInbound: readonly PersistedInboundMessage[];
  readonly backgroundJobs: readonly PersistedBackgroundJob[];
  readonly inboundBySession: ReadonlyMap<string, readonly PersistedInboundMessage[]>;
  readonly openInboundBySession: ReadonlyMap<string, readonly PersistedInboundMessage[]>;
  readonly jobsBySession: ReadonlyMap<string, readonly PersistedBackgroundJob[]>;
  readonly usageBySession: ReadonlyMap<string, SessionUsageSummary>;
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
  readonly githubPrIdentities: {
    readonly count: number;
    readonly bindings: readonly unknown[];
  };
  readonly githubAccounts: {
    readonly count: number;
    readonly defaultPrAccount: GitHubPrIdentityStatus["defaultAccount"];
    readonly accounts: readonly unknown[];
  };
}

interface SlackConversationLookup {
  getConversationInfo(channelId: string): Promise<{
    readonly channelId: string;
    readonly name?: string | undefined;
    readonly channelType?: string | undefined;
  } | null>;
  getUserIdentity?(userId: string): Promise<SlackUserIdentity | null>;
  getPermalink?(options: {
    readonly channelId: string;
    readonly messageTs: string;
  }): Promise<string | null>;
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
  readonly listAgentTurnUsage?: ((limit?: number) => PersistedAgentTurnUsage[]) | undefined;
  readonly listAgentSessionUsageSummaries?: (() => PersistedAgentSessionUsageSummary[]) | undefined;
  readonly getAgentSessionUsageSummary?: ((sessionKey: string) => PersistedAgentSessionUsageSummary | undefined) | undefined;
  readonly listAgentTraceEventsPage?: ((sessionKey: string, options?: {
    readonly limit?: number | undefined;
    readonly beforeSequence?: number | undefined;
  }) => {
    readonly events: PersistedAgentTraceEvent[];
    readonly hasMore: boolean;
    readonly nextBeforeSequence: number | null;
  }) | undefined;
  readonly getAgentSessionTraceSummary?: ((sessionKey: string) => PersistedAgentSessionTraceSummary | undefined) | undefined;
}

interface AgentUsageTotals {
  readonly totalTurns: number;
  readonly exactTurns: number;
  readonly estimatedTurns: number;
  readonly missingTurns: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
}

interface SessionUsageSummary {
  readonly sessionKey: string;
  readonly channelId: string;
  readonly rootThreadTs: string;
  readonly turnCount: number;
  readonly exactTurns: number;
  readonly estimatedTurns: number;
  readonly missingTurns: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  readonly updatedAt: string;
  readonly lastTurnAt: string | null;
  readonly model: string | null;
  readonly effort: string | null;
}
type MutableSessionUsageSummary = { -readonly [Key in keyof SessionUsageSummary]: SessionUsageSummary[Key] };

export class AdminService {
  readonly #channelLabelCache = new Map<string, string | null>();

  constructor(
    private readonly options: {
      readonly config: AppConfig;
      readonly sessions: SessionManager;
      readonly runtime: RuntimeControl;
      readonly authProfiles: AuthProfileService;
      readonly githubAuthorMappings: GitHubAuthorMappingService;
      readonly githubPrIdentity?: GitHubPrIdentityService | undefined;
      readonly startedAt: Date;
      readonly deployment?: ReleaseDeploymentService | undefined;
      readonly slackConversations?: SlackConversationLookup | undefined;
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
    const usage = this.#readUsageOverview();
    const channelLabels = await this.#buildChannelLabelLookup(snapshot.allSessions, snapshot.inboundBySession);
    const sessionSummaries = snapshot.allSessions.slice(0, 50).map((session) =>
      this.#summarizeSession(session, {
        inbound: snapshot.inboundBySession.get(session.key) ?? [],
        openInbound: snapshot.openInboundBySession.get(session.key) ?? [],
        jobs: snapshot.jobsBySession.get(session.key) ?? [],
        usage: snapshot.usageBySession.get(session.key),
        channelLabels
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
      githubAccounts: runtime.githubAccounts,
      githubAuthorMappings: runtime.githubAuthorMappings,
      githubPrIdentities: runtime.githubPrIdentities,
      account: runtime.account,
      rateLimits: runtime.rateLimits,
      deployment: runtime.deployment,
      realtime: this.#realtimeInfo(),
      usage,
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
    const runtime = await this.#readRuntimeStatus();
    return {
      ok: true,
      service: this.#serviceInfo(),
      authProfiles: runtime.authProfiles,
      githubAccounts: runtime.githubAccounts,
      githubAuthorMappings: runtime.githubAuthorMappings,
      githubPrIdentities: runtime.githubPrIdentities,
      account: runtime.account,
      rateLimits: runtime.rateLimits,
      deployment: runtime.deployment,
      realtime: this.#realtimeInfo(),
      operations: this.#listAdminOperations(10),
      auditEvents: this.#listAdminAuditEvents({ limit: 10 }),
      state: this.#summarizeCachedStateCounts()
    };
  }

  async getUsageOverview(): Promise<Record<string, unknown>> {
    return {
      ok: true,
      ...this.#readUsageOverview()
    };
  }

  async getRecentLogs(options: {
    readonly limit?: number | undefined;
  } = {}): Promise<Record<string, unknown>> {
    const limit = Math.max(0, Math.min(100, Math.floor(options.limit ?? 40)));
    return {
      ok: true,
      logs: await this.#readRecentBrokerLogs(limit)
    };
  }

  async listSessionSummaries(): Promise<Record<string, unknown>> {
    const snapshot = await this.#readSessionSnapshot();
    const channelLabels = await this.#buildChannelLabelLookup(snapshot.allSessions, snapshot.inboundBySession);
    return {
      ok: true,
      realtime: this.#realtimeInfo(),
      sessions: snapshot.allSessions.slice(0, 500).map((session) =>
        this.#summarizeSessionListItem(session, {
          inbound: snapshot.inboundBySession.get(session.key) ?? [],
          openInbound: snapshot.openInboundBySession.get(session.key) ?? [],
          jobs: snapshot.jobsBySession.get(session.key) ?? [],
          usage: snapshot.usageBySession.get(session.key),
          channelLabels
        })
      )
    };
  }

  async getSessionTimeline(sessionKey: string, options: {
    readonly limit?: number | undefined;
    readonly beforeSequence?: number | undefined;
  } = {}): Promise<Record<string, unknown>> {
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

    const pageLimit = clampPositiveInteger(options.limit ?? 100, 1, 500);
    const tracePage = this.#listVisibleTimelineTraceEventsPage(session.key, {
      limit: pageLimit,
      beforeSequence: options.beforeSequence
    });
    const timelinePage = selectTimelinePageEvents({
      agentEvents: tracePage.events.map((event) => agentTraceEventToTimelineEvent(event)),
      limit: pageLimit,
      traceHasMore: tracePage.hasMore,
      traceNextBeforeSequence: tracePage.nextBeforeSequence
    });

    return {
      ok: true,
      session: this.#summarizeSession(session, {
        inbound,
        openInbound,
        jobs,
        usage: sessionUsageSummaryFromPersisted(this.#getAgentSessionUsageSummary(session.key)),
        channelLabels: await this.#buildChannelLabelLookup([session], new Map([[session.key, inbound]]))
      }),
      trace: traceSummaryFromPersisted(this.#getAgentSessionTraceSummary(session.key), tracePage.events),
      page: {
        limit: pageLimit,
        hasMore: timelinePage.hasMore,
        nextBeforeSequence: timelinePage.nextBeforeSequence
      },
      events: timelinePage.events
    };
  }

  async getSessionTimelineEvent(sessionKey: string, eventId: string): Promise<Record<string, unknown>> {
    const session = this.options.sessions.getSessionByKey(sessionKey);
    if (!session) {
      return {
        ok: false,
        error: "session_not_found",
        sessionKey
      };
    }
    const event = this.options.sessions.getAgentTraceEvent(sessionKey, eventId);
    if (!event) {
      return {
        ok: false,
        error: "trace_event_not_found",
        sessionKey,
        eventId
      };
    }
    if (!isVisibleTimelineTraceEvent(event)) {
      return {
        ok: false,
        error: "trace_event_hidden",
        sessionKey,
        eventId
      };
    }
    return {
      ok: true,
      event: agentTraceEventToTimelineEvent(event, {
        includeDetail: true
      })
    };
  }

  async getSessionSlackThreadUrl(sessionKey: string): Promise<Record<string, unknown>> {
    const session = this.options.sessions.getSessionByKey(sessionKey);
    if (!session) {
      return {
        ok: false,
        error: "session_not_found",
        sessionKey
      };
    }

    const getPermalink = this.options.slackConversations?.getPermalink;
    if (!getPermalink) {
      return {
        ok: false,
        error: "slack_permalink_unavailable",
        sessionKey
      };
    }

    try {
      const url = await getPermalink.call(this.options.slackConversations, {
        channelId: session.channelId,
        messageTs: session.rootThreadTs
      });
      if (!url) {
        return {
          ok: false,
          error: "slack_permalink_unavailable",
          sessionKey
        };
      }
      return {
        ok: true,
        sessionKey,
        url
      };
    } catch (error) {
      logger.warn("Failed to resolve Slack thread permalink", {
        sessionKey,
        channelId: session.channelId,
        rootThreadTs: session.rootThreadTs,
        error: error instanceof Error ? error.message : String(error)
      });
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        sessionKey
      };
    }
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

  async listRealtimeEvents(options: {
    readonly afterSequence: number;
    readonly limit?: number | undefined;
  }): Promise<Record<string, unknown>> {
    const events = this.options.sessions.listAdminEvents({
      afterSequence: options.afterSequence,
      limit: options.limit ?? 100
    });
    return {
      ok: true,
      cursor: events.at(-1)?.sequence ?? this.#latestRealtimeSequence(),
      events: events.map((event) => this.#serializeRealtimeEvent(event))
    };
  }

  getRealtimeCursor(): number {
    return this.#latestRealtimeSequence();
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

  async startAuthProfileDeviceCode(): Promise<Record<string, unknown>> {
    const deviceCode = await this.options.authProfiles.requestDeviceCodeAuth();
    return {
      ok: true,
      deviceCode
    };
  }

  async completeAuthProfileDeviceCode(options: {
    readonly name?: string | undefined;
    readonly deviceAuthId: string;
    readonly userCode: string;
    readonly retryAfterSeconds?: number | undefined;
  }): Promise<Record<string, unknown>> {
    const result = await this.options.authProfiles.completeDeviceCodeAuth({
      deviceAuthId: options.deviceAuthId,
      userCode: options.userCode,
      retryAfterSeconds: options.retryAfterSeconds
    });

    if (result.status === "pending") {
      return {
        ok: true,
        deviceCode: result
      };
    }

    return await this.#runTrackedOperation(
      "auth_profile_add",
      {
        name: options.name ?? null,
        source: "device_code"
      },
      async () => {
        const profile = await this.options.authProfiles.addProfile({
          name: options.name,
          authJsonContent: result.authJsonContent
        });
        return {
          ok: true,
          deviceCode: {
            status: "complete"
          },
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

  async switchSessionAuthProfile(options: {
    readonly sessionKey: string;
    readonly name?: string | undefined;
    readonly mode?: "auto" | undefined;
  }): Promise<Record<string, unknown>> {
    const selectionMode = options.mode === "auto" ? "auto" : "manual";
    const request: JsonLike = selectionMode === "auto"
      ? {
          sessionKey: options.sessionKey,
          mode: "auto"
        }
      : {
          sessionKey: options.sessionKey,
          mode: "manual",
          name: options.name ?? ""
        };
    return await this.#runTrackedOperation(
      "session_auth_profile_switch",
      request,
      async () => {
        const session = this.options.sessions.getSessionByKey(options.sessionKey);
        if (!session) {
          throw new Error(`Session not found: ${options.sessionKey}`);
        }

        const status = await this.options.authProfiles.listProfilesStatus();
        const profile = selectionMode === "auto"
          ? selectBestAuthProfile(status)
          : (options.name ? findAuthProfile(status, options.name) : null);
        if (!profile) {
          if (selectionMode === "auto") {
            throw new Error(`No usable auth profile: ${authProfileReasonLabel("no_usable_auth_profiles")}`);
          }
          throw new Error(`Auth profile not found: ${options.name ?? ""}`);
        }

        const evaluation = evaluateAuthProfile(profile);
        if (!evaluation.usable) {
          throw new Error(`Auth profile is not usable: ${authProfileReasonLabel(evaluation.reason)}`);
        }

        await this.options.sessions.resetInflightMessages(session.channelId, session.rootThreadTs);
        const switched = await this.options.sessions.switchSessionAuthProfileAndClearBlock(session.key, profile.name);
        await this.#appendSessionAuthProfileSwitchTrace(switched, profile.name, selectionMode);
        const workerResume = await this.#resumeWorkerPendingSession(switched.key);
        return {
          ok: true,
          selectedMode: selectionMode,
          selectedProfileName: profile.name,
          session: this.#summarizeSessionByKey(switched.key),
          workerResume
        };
      }
    );
  }

  async resetSession(options: {
    readonly sessionKey: string;
  }): Promise<Record<string, unknown>> {
    return await this.#runTrackedOperation(
      "session_reset",
      {
        sessionKey: options.sessionKey
      },
      async () => {
        const session = this.options.sessions.getSessionByKey(options.sessionKey);
        if (!session) {
          throw new Error(`Session not found: ${options.sessionKey}`);
        }

        const workerReset = await this.#resetWorkerSession(session.key);
        return {
          ok: true,
          session: this.#summarizeSessionByKey(session.key),
          workerReset
        };
      }
    );
  }

  async cancelSessionJob(options: {
    readonly sessionKey: string;
    readonly jobId: string;
  }): Promise<Record<string, unknown>> {
    return await this.#runTrackedOperation(
      "session_job_cancel",
      {
        sessionKey: options.sessionKey,
        jobId: options.jobId
      },
      async () => {
        const session = this.options.sessions.getSessionByKey(options.sessionKey);
        if (!session) {
          throw new Error(`Session not found: ${options.sessionKey}`);
        }

        const job = this.options.sessions.getBackgroundJob(options.jobId);
        if (!job || job.sessionKey !== session.key) {
          throw new Error("job_session_mismatch");
        }
        if (!isAdminCancellableJob(job)) {
          throw new Error(`Background job is not cancellable: ${job.status}`);
        }

        const workerCancel = await this.#cancelWorkerBackgroundJob(session.key, job.id);
        await this.#refreshSessions();
        const cancelledJob = this.options.sessions.getBackgroundJob(job.id) ?? job;
        return {
          ok: true,
          session: this.#summarizeSessionByKey(session.key),
          job: this.#summarizeJob(cancelledJob),
          workerCancel: {
            ok: workerCancel.ok !== false
          }
        };
      }
    );
  }

  async deleteSession(options: {
    readonly sessionKey: string;
  }): Promise<Record<string, unknown>> {
    return await this.#runTrackedOperation(
      "session_delete",
      {
        sessionKey: options.sessionKey
      },
      async () => {
        await this.#refreshSessions();
        const session = this.options.sessions.getSessionByKey(options.sessionKey);
        if (!session) {
          throw new Error(`Session not found: ${options.sessionKey}`);
        }

        const jobs = this.options.sessions.listBackgroundJobs({
          channelId: session.channelId,
          rootThreadTs: session.rootThreadTs
        });
        const cancellableJobs = jobs.filter(isAdminCancellableJob);
        const cancelledJobs = [];
        for (const job of cancellableJobs) {
          try {
            const workerCancel = await this.#cancelWorkerBackgroundJob(session.key, job.id);
            cancelledJobs.push({
              id: job.id,
              kind: job.kind,
              ok: workerCancel.ok !== false,
              workerCancel: {
                ok: workerCancel.ok !== false
              }
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn("Failed to cancel background job before session delete; continuing delete", {
              sessionKey: session.key,
              jobId: job.id,
              error: message
            });
            cancelledJobs.push({
              id: job.id,
              kind: job.kind,
              ok: false,
              error: message
            });
          }
        }

        const workerDelete = await this.#deleteWorkerSession(session.key);
        const removedArtifacts = await this.#removeDeletedSessionArtifacts(session.key, jobs);
        await this.#refreshSessions();

        return {
          ok: true,
          sessionKey: session.key,
          deleted: readNestedBoolean(workerDelete, ["delete", "deleted"]),
          backgroundJobCount: jobs.length,
          cancelledJobCount: cancelledJobs.filter((job) => job.ok).length,
          failedJobCancelCount: cancelledJobs.filter((job) => !job.ok).length,
          cancelledJobs,
          removedArtifacts,
          workerDelete
        };
      }
    );
  }

  async deployRelease(options: {
    readonly target: "admin" | "worker";
    readonly version: string;
    readonly allowActive: boolean;
  }): Promise<Record<string, unknown>> {
    if (!this.options.deployment) {
      throw new Error("Release deployment is not configured for this runtime.");
    }

    return await this.#runTrackedOperation(
      "deploy",
      {
        target: options.target,
        version: options.version,
        allowActive: options.allowActive
      },
      async () => {
        await this.#assertSafeToInterrupt(options.allowActive, "deploy");
        const deployment = await this.options.deployment!.deploy({
          target: options.target,
          version: options.version
        } satisfies DeployReleaseOptions);
        return {
          ok: true,
          deployment
        };
      }
    );
  }

  async rollbackRelease(options: {
    readonly target: "admin" | "worker";
    readonly version?: string | undefined;
    readonly allowActive: boolean;
  }): Promise<Record<string, unknown>> {
    if (!this.options.deployment) {
      throw new Error("Release deployment is not configured for this runtime.");
    }

    return await this.#runTrackedOperation(
      "rollback",
      {
        target: options.target,
        version: options.version ?? null,
        allowActive: options.allowActive
      },
      async () => {
        await this.#assertSafeToInterrupt(options.allowActive, "rollback");
        const deployment = await this.options.deployment!.rollback({
          target: options.target,
          version: options.version
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

  async setDefaultGitHubPrAccount(options: {
    readonly slackUserId: string;
  }): Promise<Record<string, unknown>> {
    const githubPrIdentity = this.options.githubPrIdentity;
    if (!githubPrIdentity) {
      throw new Error("GitHub PR identity service is not configured.");
    }

    return await this.#runTrackedOperation(
      "github_pr_default_set",
      {
        slackUserId: options.slackUserId
      },
      async () => {
        const defaultPrAccount = await githubPrIdentity.setDefaultBinding(options.slackUserId);
        return {
          ok: true,
          defaultPrAccount
        };
      }
    );
  }

  async getSessionGitHubIdentity(sessionKey: string): Promise<Record<string, unknown>> {
    const githubPrIdentity = this.options.githubPrIdentity;
    if (!githubPrIdentity) {
      return {
        ok: false,
        error: "github_pr_identity_not_configured"
      };
    }
    await githubPrIdentity.load();
    const session = this.options.sessions.getSessionByKey(sessionKey);
    if (!session) {
      return {
        ok: false,
        error: "session_not_found"
      };
    }

    return {
      ok: true,
      sessionKey,
      initiatorUserId: session.initiatorUserId ?? null,
      identity: githubPrIdentity.getSessionIdentityStatus(session)
    };
  }

  async startSessionGitHubDeviceAuthorization(sessionKey: string): Promise<Record<string, unknown>> {
    const githubPrIdentity = this.options.githubPrIdentity;
    if (!githubPrIdentity) {
      return {
        ok: false,
        error: "github_pr_identity_not_configured"
      };
    }
    await githubPrIdentity.load();
    const session = this.options.sessions.getSessionByKey(sessionKey);
    if (!session) {
      return {
        ok: false,
        error: "session_not_found"
      };
    }
    if (!session.initiatorUserId) {
      return {
        ok: false,
        error: "missing_session_initiator"
      };
    }

    const device = await githubPrIdentity.startDeviceAuthorization({
      slackUserId: session.initiatorUserId
    });
    return {
      ok: true,
      device
    };
  }

  async startGitHubAccountDeviceAuthorization(slackUserId: string): Promise<Record<string, unknown>> {
    const githubPrIdentity = this.options.githubPrIdentity;
    if (!githubPrIdentity) {
      return {
        ok: false,
        error: "github_pr_identity_not_configured"
      };
    }
    const normalizedSlackUserId = typeof slackUserId === "string" && slackUserId.trim()
      ? slackUserId.trim()
      : undefined;
    if (!normalizedSlackUserId) {
      return {
        ok: false,
        error: "missing_slack_user_id"
      };
    }

    await this.options.githubAuthorMappings.load();
    await githubPrIdentity.load();
    const knownSlackUserIds = collectKnownGitHubAccountSlackUserIds({
      bindings: githubPrIdentity.listBindings(),
      sessions: this.options.sessions.listSessions()
    });
    if (!knownSlackUserIds.has(normalizedSlackUserId) && !looksLikeSlackUserId(normalizedSlackUserId)) {
      return {
        ok: false,
        error: "slack_user_not_found"
      };
    }

    const device = await githubPrIdentity.startDeviceAuthorization({
      slackUserId: normalizedSlackUserId
    });
    return {
      ok: true,
      device
    };
  }

  async pollGitHubDeviceAuthorization(deviceAuthorizationId: string): Promise<Record<string, unknown>> {
    const githubPrIdentity = this.options.githubPrIdentity;
    if (!githubPrIdentity) {
      return {
        ok: false,
        error: "github_pr_identity_not_configured"
      };
    }
    const result = await githubPrIdentity.pollDeviceAuthorization(deviceAuthorizationId);
    return {
      ok: true,
      result
    };
  }

  async #readRuntimeStatus(): Promise<RuntimeStatus> {
    await this.options.githubAuthorMappings.load();
    await this.options.githubPrIdentity?.load();
    const [account, rateLimits, deployment, authProfiles] = await Promise.all([
      this.#readAccountSummary(),
      this.#readAccountRateLimits(),
      this.#readDeploymentStatus(),
      this.#readAuthProfilesStatus()
    ]);
    const mappings = this.options.githubAuthorMappings.listMappings();
    const prBindings = this.options.githubPrIdentity?.listBindings() ?? [];
    const defaultPrAccount = this.options.githubPrIdentity?.getDefaultAccountStatus() ?? {
      available: false as const,
      reason: "not_configured" as const
    };
    const sessions = this.options.sessions.listSessions();
    const slackIdentities = await this.#readGitHubAccountSlackIdentities({
      bindings: prBindings,
      sessions
    });
    const githubAccounts = buildGitHubAccounts({
      bindings: prBindings,
      defaultPrAccount,
      sessions,
      slackIdentities
    });
    return {
      account,
      rateLimits,
      deployment,
      authProfiles,
      githubAccounts,
      githubAuthorMappings: {
        count: mappings.length,
        mappings
      },
      githubPrIdentities: {
        count: prBindings.length,
        bindings: prBindings.map((binding) => ({
          slackUserId: binding.slackUserId,
          githubLogin: binding.githubLogin,
          githubUserId: binding.githubUserId,
          githubEmail: binding.githubEmail ?? null,
          githubName: binding.githubName ?? null,
          scopes: binding.scopes,
          createdAt: binding.createdAt,
          updatedAt: binding.updatedAt,
          lastValidatedAt: binding.lastValidatedAt ?? null,
          revokedAt: binding.revokedAt ?? null
        }))
      }
    };
  }

  async #readGitHubAccountSlackIdentities(options: {
    readonly bindings: readonly GitHubPrBindingRecord[];
    readonly sessions: readonly SlackSessionRecord[];
  }): Promise<ReadonlyMap<string, SlackUserIdentity>> {
    const slackLookup = this.options.slackConversations;
    const getUserIdentity = slackLookup?.getUserIdentity;
    if (!getUserIdentity) {
      return new Map();
    }

    const userIds = [...collectKnownGitHubAccountSlackUserIds(options)]
      .filter((userId) => looksLikeSlackUserId(userId))
      .slice(0, 100);
    if (!userIds.length) {
      return new Map();
    }

    let entries: Array<readonly [string, SlackUserIdentity] | null>;
    try {
      entries = await withAdminProbeTimeout(
        Promise.all(userIds.map(async (userId): Promise<readonly [string, SlackUserIdentity] | null> => {
          const identity = await getUserIdentity.call(slackLookup, userId);
          return identity ? [userId, identity] as const : null;
        })),
        "Slack user identity lookup"
      );
    } catch (error) {
      logger.warn("Failed to resolve Slack identities for GitHub account rows", {
        error: error instanceof Error ? error.message : String(error)
      });
      return new Map();
    }

    return new Map(entries.filter((entry): entry is readonly [string, SlackUserIdentity] => Boolean(entry)));
  }

  async #readSessionSnapshot(): Promise<SessionSnapshot> {
    const sessions = this.options.sessions.listSessions();
    const inbound = this.options.sessions.listInboundMessages();
    const openInbound = this.options.sessions
      .listInboundMessages({
        status: ["pending", "inflight"]
      })
      .sort((left, right) => String(left.updatedAt ?? "").localeCompare(String(right.updatedAt ?? "")));
    const backgroundJobs = this.options.sessions
      .listBackgroundJobs()
      .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
    const inboundBySession = groupBySession(inbound);
    const openInboundBySession = groupBySession(openInbound);
    const jobsBySession = groupBySession(backgroundJobs);
    const usageBySession = summarizeUsageBySessionMapFromPersisted(this.#listAgentSessionUsageSummaries());
    const allSessions = sessions
      .sort((left, right) => compareSessions(left, right, {
        inboundBySession,
        jobsBySession,
        usageBySession
      }));
    const activeSessions = allSessions.filter((session) => Boolean(session.activeTurnId));

    return {
      allSessions,
      activeSessions,
      inbound,
      openInbound,
      backgroundJobs,
      inboundBySession,
      openInboundBySession,
      jobsBySession,
      usageBySession
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

  #summarizeCachedStateCounts(): Record<string, unknown> {
    const sessions = this.options.sessions.listSessions();
    const backgroundJobs = this.options.sessions.listBackgroundJobs();
    const runningBackgroundJobCount = backgroundJobs.filter((job) => job.status === "running").length;
    const failedBackgroundJobCount = backgroundJobs.filter((job) => job.status === "failed").length;
    return {
      sessionCount: sessions.length,
      activeCount: sessions.filter((session) => Boolean(session.activeTurnId)).length,
      openInboundCount: 0,
      openHumanInboundCount: 0,
      openSystemInboundCount: 0,
      backgroundJobCount: backgroundJobs.length,
      runningBackgroundJobCount,
      failedBackgroundJobCount
    };
  }

  #readUsageOverview(): Record<string, unknown> {
    const records = this.#listAgentTurnUsage(1000);
    const totals = summarizeUsageTotals(records);
    const windows = {
      lastHour: summarizeUsageTotals(filterUsageWindow(records, 60 * 60 * 1000)),
      lastDay: summarizeUsageTotals(filterUsageWindow(records, 24 * 60 * 60 * 1000))
    };
    return {
      totals,
      windows,
      recentTurns: records
        .slice()
        .sort(compareUsageRecordsDescending)
        .slice(0, 25)
        .map(summarizeUsageRecord),
      bySession: summarizeUsageBySession(records, 25)
    };
  }

  #realtimeInfo(): Record<string, unknown> {
    return {
      cursor: this.#latestRealtimeSequence()
    };
  }

  #latestRealtimeSequence(): number {
    const getLatest = (this.options.sessions as {
      readonly getLatestAdminEventSequence?: (() => number) | undefined;
    }).getLatestAdminEventSequence;
    return typeof getLatest === "function" ? getLatest.call(this.options.sessions) : 0;
  }

  #serializeRealtimeEvent(event: PersistedAdminEvent): Record<string, unknown> {
    const serialized: Record<string, unknown> = {
      sequence: event.sequence,
      kind: event.kind,
      scope: event.scope,
      sessionKey: event.sessionKey ?? null,
      entityId: event.entityId ?? null,
      payload: event.payload,
      createdAt: event.createdAt
    };

    if (event.sessionKey && event.kind !== "trace.append") {
      serialized.session = this.#summarizeSessionByKey(event.sessionKey) ?? null;
    }

    if (event.kind === "trace.append") {
      const traceEvent = event.payload as unknown as PersistedAgentTraceEvent;
      if (isVisibleTimelineTraceEvent(traceEvent)) {
        serialized.timelineEvent = agentTraceEventToTimelineEvent(traceEvent);
      }
    }

    if (event.kind === "operation.upsert") {
      serialized.operation = event.payload;
    }
    if (event.kind === "audit.append") {
      serialized.auditEvent = event.payload;
    }

    return serialized;
  }

  #summarizeSessionByKey(sessionKey: string): Record<string, unknown> | null {
    const session = this.options.sessions.getSessionByKey(sessionKey);
    if (!session) {
      return null;
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

    const channelLabels = this.#knownChannelLabelLookup([session], new Map([[session.key, inbound]]));
    return this.#summarizeSession(session, {
      inbound,
      openInbound,
      jobs,
      usage: summarizeUsageBySessionMap(this.#listAgentTurnUsage(1000)).get(session.key),
      channelLabels
    });
  }

  async #buildChannelLabelLookup(
    sessions: readonly SlackSessionRecord[],
    inboundBySession: ReadonlyMap<string, readonly PersistedInboundMessage[]>
  ): Promise<ReadonlyMap<string, string>> {
    const labels = this.#knownChannelLabelLookup(sessions, inboundBySession);
    const missingChannelIds = uniqueChannelIds(sessions)
      .filter((channelId) => !labels.has(channelId) && looksLikeSlackConversationId(channelId));

    if (!missingChannelIds.length || !this.options.slackConversations) {
      return labels;
    }

    await Promise.all(missingChannelIds.map(async (channelId) => {
      const label = await this.#resolveSlackChannelLabel(channelId);
      if (label) {
        labels.set(channelId, label);
      }
    }));
    return labels;
  }

  #knownChannelLabelLookup(
    sessions: readonly SlackSessionRecord[],
    inboundBySession: ReadonlyMap<string, readonly PersistedInboundMessage[]>
  ): Map<string, string> {
    const labels = buildChannelLabelLookup(sessions, inboundBySession);
    for (const session of sessions) {
      const cached = this.#channelLabelCache.get(session.channelId);
      if (cached) {
        labels.set(session.channelId, cached);
      }
    }
    return labels;
  }

  async #resolveSlackChannelLabel(channelId: string): Promise<string | undefined> {
    if (this.#channelLabelCache.has(channelId)) {
      return this.#channelLabelCache.get(channelId) ?? undefined;
    }

    const lookup = this.options.slackConversations;
    if (!lookup) {
      return undefined;
    }

    try {
      const info = await lookup.getConversationInfo(channelId);
      const label = channelLabelForConversationInfo(info);
      this.#channelLabelCache.set(channelId, label ?? null);
      return label;
    } catch (error) {
      logger.warn("Failed to resolve Slack channel label for admin", {
        channelId,
        error: error instanceof Error ? error.message : String(error)
      });
      this.#channelLabelCache.set(channelId, null);
      return undefined;
    }
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
      status: await this.getOverview()
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

  #listAgentTurnUsage(limit: number): readonly PersistedAgentTurnUsage[] {
    const store = this.#operationStore();
    return store.listAgentTurnUsage?.call(this.options.sessions, limit) ?? [];
  }

  #listAgentSessionUsageSummaries(): readonly PersistedAgentSessionUsageSummary[] {
    const store = this.#operationStore();
    return store.listAgentSessionUsageSummaries?.call(this.options.sessions) ?? [];
  }

  #getAgentSessionUsageSummary(sessionKey: string): PersistedAgentSessionUsageSummary | undefined {
    const store = this.#operationStore();
    return store.getAgentSessionUsageSummary?.call(this.options.sessions, sessionKey);
  }

  #listAgentTraceEventsPage(sessionKey: string, options: {
    readonly limit?: number | undefined;
    readonly beforeSequence?: number | undefined;
  }): {
    readonly events: PersistedAgentTraceEvent[];
    readonly hasMore: boolean;
    readonly nextBeforeSequence: number | null;
  } {
    const store = this.#operationStore();
    const page = store.listAgentTraceEventsPage?.call(this.options.sessions, sessionKey, options);
    if (page) {
      return page;
    }
    const limit = clampPositiveInteger(options.limit ?? 100, 1, 500);
    const events = this.options.sessions.listAgentTraceEvents(sessionKey, limit);
    return {
      events,
      hasMore: false,
      nextBeforeSequence: events.length ? Math.min(...events.map((event) => event.sequence)) : null
    };
  }

  #listVisibleTimelineTraceEventsPage(sessionKey: string, options: {
    readonly limit: number;
    readonly beforeSequence?: number | undefined;
  }): {
    readonly events: PersistedAgentTraceEvent[];
    readonly hasMore: boolean;
    readonly nextBeforeSequence: number | null;
  } {
    const visibleLimit = clampPositiveInteger(options.limit, 1, 500);
    const rawBatchLimit = clampPositiveInteger(Math.max(visibleLimit * 4, 100), visibleLimit, 500);
    const maxRawScan = Math.max(rawBatchLimit, 5_000);
    const rawEvents: PersistedAgentTraceEvent[] = [];
    let beforeSequence = options.beforeSequence;
    let rawHasMore = false;
    let rawCursor: number | null = null;
    let scanned = 0;

    while (scanned < maxRawScan) {
      const page = this.#listAgentTraceEventsPage(sessionKey, {
        limit: Math.min(rawBatchLimit, maxRawScan - scanned),
        beforeSequence
      });
      rawEvents.push(...page.events);
      scanned += page.events.length;
      rawHasMore = page.hasMore;
      rawCursor = page.nextBeforeSequence;

      const visible = visibleTimelineTraceEvents(rawEvents);
      if (visible.length > visibleLimit || !page.hasMore || !page.nextBeforeSequence || page.events.length === 0) {
        break;
      }
      beforeSequence = page.nextBeforeSequence;
    }

    const visible = visibleTimelineTraceEvents(rawEvents);
    const newest = [...visible].sort(comparePersistedTraceEventsNewestFirst);
    const selected = newest.slice(0, visibleLimit);
    const returnedTraceSequences = selected
      .map((event) => event.sequence)
      .filter((sequence): sequence is number => typeof sequence === "number");
    const nextBeforeSequence = returnedTraceSequences.length
      ? Math.min(...returnedTraceSequences)
      : rawCursor;
    return {
      events: selected.slice().sort(comparePersistedTraceEvents),
      hasMore: Boolean(nextBeforeSequence && (newest.length > visibleLimit || (rawHasMore && scanned >= maxRawScan))),
      nextBeforeSequence
    };
  }

  #getAgentSessionTraceSummary(sessionKey: string): PersistedAgentSessionTraceSummary | undefined {
    const store = this.#operationStore();
    return store.getAgentSessionTraceSummary?.call(this.options.sessions, sessionKey);
  }

  #operationStore(): AdminOperationStore {
    return this.options.sessions as unknown as AdminOperationStore;
  }

  async #readAccountSummary(): Promise<SerializedAccountStatus> {
    try {
      return serializeAccountSummary(await withAdminProbeTimeout(
        this.options.runtime.readAccountSummary(false),
        "account summary"
      ));
    } catch (error) {
      return serializeAccountError(error);
    }
  }

  async #readAccountRateLimits(): Promise<SerializedRateLimitsStatus> {
    try {
      return serializeRateLimits(await withAdminProbeTimeout(
        this.options.runtime.readAccountRateLimits(),
        "account rate limits"
      ));
    } catch (error) {
      return serializeRateLimitsError(error);
    }
  }

  async #readDeploymentStatus(): Promise<unknown> {
    if (!this.options.deployment) {
      return null;
    }
    try {
      return await withAdminProbeTimeout(this.options.deployment.getStatus(), "deployment status");
    } catch (error) {
      return serializeProbeError(error);
    }
  }

  async #readAuthProfilesStatus(): Promise<unknown> {
    try {
      return await withAdminProbeTimeout(this.options.authProfiles.listProfilesStatus(), "auth profiles");
    } catch (error) {
      return {
        ...serializeProbeError(error),
        profiles: []
      };
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
    const text = resolveMentionText(message.text, message.mentionedUsers);
    const slackIdentity = inboundMessageSlackIdentity(message);
    return {
      sessionKey: message.sessionKey,
      messageTs: message.messageTs,
      source: message.source,
      status: message.status,
      userId: message.userId,
      senderUsername: message.senderUsername ?? null,
      slackIdentity,
      textPreview: text.slice(0, 160),
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
      readonly openInbound: readonly PersistedInboundMessage[];
      readonly jobs: readonly PersistedBackgroundJob[];
      readonly usage?: SessionUsageSummary | undefined;
      readonly channelLabels?: ReadonlyMap<string, string> | undefined;
    }
  ): Record<string, unknown> {
    const runningBackgroundJobCount = related.jobs.filter((job) => job.status === "running").length;
    const failedBackgroundJobs = related.jobs.filter((job) => job.status === "failed");
    const failedBackgroundJobCount = failedBackgroundJobs.length;
    const openHumanInboundCount = related.openInbound.filter(isHumanInboundMessage).length;
    const openSystemInboundCount = related.openInbound.length - openHumanInboundCount;
    const userMessages = related.inbound.filter(isUserInboundMessage);
    const firstUserMessage = userMessages.at(0);
    const lastUserMessage = userMessages.at(-1);
    const lastActivityAt = sessionLastActivityAt(session, {
      inbound: related.inbound,
      jobs: related.jobs,
      usage: related.usage
    });
    return {
      key: session.key,
      channelId: session.channelId,
      channelLabel: channelLabelForSession(session, related.inbound, related.channelLabels),
      channelName: session.channelName ?? null,
      channelType: session.channelType ?? related.inbound.find((message) => message.channelType)?.channelType ?? null,
      rootThreadTs: session.rootThreadTs,
      initiatorUserId: session.initiatorUserId ?? null,
      threadUrl: buildSlackThreadUrl(session.channelId, session.rootThreadTs),
      workspacePath: session.workspacePath,
      agentSessionId: session.agentSessionId ?? null,
      updatedAt: session.updatedAt,
      lastActivityAt,
      createdAt: session.createdAt,
      firstUserMessage: firstUserMessage ? this.#summarizeInbound(firstUserMessage) : null,
      lastUserMessage: lastUserMessage ? this.#summarizeInbound(lastUserMessage) : null,
      activeTurnId: session.activeTurnId ?? null,
      activeTurnStartedAt: session.activeTurnStartedAt ?? null,
      lastTurnSignalKind: session.lastTurnSignalKind ?? null,
      lastTurnSignalReason: session.lastTurnSignalReason ?? null,
      lastTurnSignalAt: session.lastTurnSignalAt ?? null,
      lastSlackReplyAt: session.lastSlackReplyAt ?? null,
      sessionPageLinkPostedAt: session.sessionPageLinkPostedAt ?? null,
      authProfileName: session.authProfileName ?? null,
      authProfileBoundAt: session.authProfileBoundAt ?? null,
      authBlockedAt: session.authBlockedAt ?? null,
      authBlockReason: session.authBlockReason ?? null,
      authBlockReasonLabel: authProfileReasonLabel(session.authBlockReason),
      authBlockedNoticePostedAt: session.authBlockedNoticePostedAt ?? null,
      lastObservedMessageTs: session.lastObservedMessageTs ?? null,
      lastDeliveredMessageTs: session.lastDeliveredMessageTs ?? null,
      openInboundCount: related.openInbound.length,
      openHumanInboundCount,
      openSystemInboundCount,
      openInbound: related.openInbound.slice(0, 5).map((message) => this.#summarizeInbound(message)),
      backgroundJobCount: related.jobs.length,
      runningBackgroundJobCount,
      failedBackgroundJobCount,
      failedBackgroundJobs: failedBackgroundJobs.slice(0, 3).map((job) => this.#summarizeJob(job)),
      backgroundJobs: sortBackgroundJobsForAdminSummary(related.jobs).slice(0, 5).map((job) => this.#summarizeJob(job)),
      usage: related.usage ?? emptySessionUsageSummary(session)
    };
  }

  #summarizeSessionListItem(
    session: SlackSessionRecord,
    related: {
      readonly inbound: readonly PersistedInboundMessage[];
      readonly openInbound: readonly PersistedInboundMessage[];
      readonly jobs: readonly PersistedBackgroundJob[];
      readonly usage?: SessionUsageSummary | undefined;
      readonly channelLabels?: ReadonlyMap<string, string> | undefined;
    }
  ): Record<string, unknown> {
    const runningBackgroundJobCount = related.jobs.filter((job) => job.status === "running").length;
    const failedBackgroundJobCount = related.jobs.filter((job) => job.status === "failed").length;
    const openHumanInboundCount = related.openInbound.filter(isHumanInboundMessage).length;
    const openSystemInboundCount = related.openInbound.length - openHumanInboundCount;
    const userMessages = related.inbound.filter(isUserInboundMessage);
    const firstUserMessage = userMessages.at(0);
    const lastUserMessage = userMessages.at(-1);
    const usage = related.usage ?? emptySessionUsageSummary(session);
    const lastActivityAt = sessionLastActivityAt(session, {
      inbound: related.inbound,
      jobs: related.jobs,
      usage
    });
    return {
      key: session.key,
      channelId: session.channelId,
      channelLabel: channelLabelForSession(session, related.inbound, related.channelLabels),
      channelName: session.channelName ?? null,
      channelType: session.channelType ?? related.inbound.find((message) => message.channelType)?.channelType ?? null,
      rootThreadTs: session.rootThreadTs,
      initiatorUserId: session.initiatorUserId ?? null,
      threadUrl: buildSlackThreadUrl(session.channelId, session.rootThreadTs),
      updatedAt: session.updatedAt,
      lastActivityAt,
      createdAt: session.createdAt,
      firstUserMessage: firstUserMessage ? this.#summarizeInboundListMessage(firstUserMessage) : null,
      lastUserMessage: lastUserMessage ? this.#summarizeInboundListMessage(lastUserMessage) : null,
      activeTurnId: session.activeTurnId ?? null,
      activeTurnStartedAt: session.activeTurnStartedAt ?? null,
      lastTurnSignalKind: session.lastTurnSignalKind ?? null,
      lastTurnSignalReason: session.lastTurnSignalReason ?? null,
      lastTurnSignalAt: session.lastTurnSignalAt ?? null,
      lastSlackReplyAt: session.lastSlackReplyAt ?? null,
      authProfileName: session.authProfileName ?? null,
      authBlockedAt: session.authBlockedAt ?? null,
      authBlockReason: session.authBlockReason ?? null,
      authBlockReasonLabel: authProfileReasonLabel(session.authBlockReason),
      openInboundCount: related.openInbound.length,
      openHumanInboundCount,
      openSystemInboundCount,
      backgroundJobCount: related.jobs.length,
      runningBackgroundJobCount,
      failedBackgroundJobCount,
      usage: summarizeListUsage(usage)
    };
  }

  #summarizeInboundListMessage(message: PersistedInboundMessage): Record<string, unknown> {
    const text = resolveMentionText(message.text, message.mentionedUsers);
    return {
      userId: message.userId,
      slackIdentity: inboundMessageSlackIdentity(message),
      textPreview: text.slice(0, 140),
      updatedAt: message.updatedAt
    };
  }

  async #appendSessionAuthProfileSwitchTrace(
    session: SlackSessionRecord,
    profileName: string,
    selectionMode: "manual" | "auto"
  ): Promise<void> {
    const now = new Date().toISOString();
    const sequence = this.options.sessions.listAgentTraceEvents(session.key, 10_000).length + 1;
    const actionLabel = selectionMode === "auto" ? "自动分配到" : "人工切换到";
    await this.options.sessions.upsertAgentTraceEvent({
      id: randomUUID(),
      sessionKey: session.key,
      source: "broker",
      type: "agent_runtime_instruction",
      at: now,
      sequence,
      title: "Auth Profile 已切换",
      summary: `${actionLabel} ${profileName}，继续处理待处理消息`,
      detail: JSON.stringify({ profileName, selectionMode }, null, 2),
      status: "completed",
      metadata: {
        profileName,
        selectionMode
      },
      createdAt: now,
      updatedAt: now
    });
  }

  async #resumeWorkerPendingSession(sessionKey: string): Promise<Record<string, unknown>> {
    const url = new URL(
      `/slack/sessions/${encodeURIComponent(sessionKey)}/resume-pending`,
      this.options.config.workerBaseUrl
    );
    const response = await fetch(url, {
      method: "POST"
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || payload.ok === false) {
      throw new Error(String(payload.error || response.statusText || "worker_resume_failed"));
    }
    return payload;
  }

  async #deleteWorkerSession(sessionKey: string): Promise<Record<string, unknown>> {
    const url = new URL(
      `/slack/sessions/${encodeURIComponent(sessionKey)}`,
      this.options.config.workerBaseUrl
    );
    const response = await fetch(url, {
      method: "DELETE"
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || payload.ok === false) {
      throw new Error(String(payload.error || response.statusText || "worker_session_delete_failed"));
    }
    return payload;
  }

  async #resetWorkerSession(sessionKey: string): Promise<Record<string, unknown>> {
    const url = new URL(
      `/slack/sessions/${encodeURIComponent(sessionKey)}/reset`,
      this.options.config.workerBaseUrl
    );
    const response = await fetch(url, {
      method: "POST"
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || payload.ok === false) {
      throw new Error(String(payload.error || response.statusText || "worker_reset_failed"));
    }
    return payload;
  }

  async #cancelWorkerBackgroundJob(sessionKey: string, jobId: string): Promise<Record<string, unknown>> {
    const url = new URL(
      `/jobs/${encodeURIComponent(jobId)}/admin-cancel`,
      this.options.config.workerBaseUrl
    );
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        session_key: sessionKey
      })
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || payload.ok === false) {
      throw new Error(String(payload.error || response.statusText || "worker_job_cancel_failed"));
    }
    return payload;
  }

  async #removeDeletedSessionArtifacts(
    sessionKey: string,
    jobs: readonly PersistedBackgroundJob[]
  ): Promise<Record<string, unknown>> {
    const pathSpecs = [
      {
        root: this.options.config.logDir,
        path: getSessionLogDirectory(this.options.config.logDir, sessionKey)
      },
      ...jobs.map((job) => ({
        root: this.options.config.jobsRoot,
        path: path.join(this.options.config.jobsRoot, job.id)
      })),
      ...jobs.map((job) => ({
        root: this.options.config.logDir,
        path: getJobLogDirectory(this.options.config.logDir, job.id)
      }))
    ];

    for (const spec of pathSpecs) {
      assertSubpathOf(spec.root, spec.path);
    }

    await Promise.all(pathSpecs.map((spec) =>
      fs.rm(spec.path, {
        recursive: true,
        force: true
      })
    ));

    return {
      pathCount: pathSpecs.length
    };
  }
}

function summarizeUsageTotals(records: readonly PersistedAgentTurnUsage[]): AgentUsageTotals {
  let totalTurns = 0;
  let exactTurns = 0;
  let estimatedTurns = 0;
  let missingTurns = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let totalTokens = 0;

  for (const record of records) {
    totalTurns += 1;
    if (record.source === "exact") {
      exactTurns += 1;
    } else if (record.source === "estimated") {
      estimatedTurns += 1;
    } else {
      missingTurns += 1;
    }

    inputTokens += record.inputTokens;
    cachedInputTokens += record.cachedInputTokens;
    outputTokens += record.outputTokens;
    reasoningTokens += record.reasoningTokens;
    totalTokens += record.totalTokens;
  }

  return {
    totalTurns,
    exactTurns,
    estimatedTurns,
    missingTurns,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens
  };
}

function filterUsageWindow(records: readonly PersistedAgentTurnUsage[], windowMs: number): PersistedAgentTurnUsage[] {
  const cutoff = Date.now() - windowMs;
  return records.filter((record) => usageTimestampMs(record) >= cutoff);
}

function summarizeUsageRecord(record: PersistedAgentTurnUsage): Record<string, unknown> {
  return {
    turnId: record.turnId,
    sessionKey: record.sessionKey,
    channelId: record.channelId,
    rootThreadTs: record.rootThreadTs,
    agentSessionId: record.agentSessionId ?? null,
    status: record.status,
    source: record.source,
    model: record.model ?? null,
    effort: record.effort ?? null,
    inputTokens: record.inputTokens,
    cachedInputTokens: record.cachedInputTokens,
    outputTokens: record.outputTokens,
    reasoningTokens: record.reasoningTokens,
    totalTokens: record.totalTokens,
    startedAt: record.startedAt ?? null,
    completedAt: record.completedAt ?? null,
    updatedAt: record.updatedAt
  };
}

function summarizeUsageBySessionMap(records: readonly PersistedAgentTurnUsage[]): ReadonlyMap<string, SessionUsageSummary> {
  return new Map(summarizeUsageBySession(records).map((entry) => [entry.sessionKey, entry]));
}

function summarizeUsageBySessionMapFromPersisted(records: readonly PersistedAgentSessionUsageSummary[]): ReadonlyMap<string, SessionUsageSummary> {
  return new Map(records.map((record) => [record.sessionKey, sessionUsageSummaryFromPersisted(record)!]));
}

function sessionUsageSummaryFromPersisted(record: PersistedAgentSessionUsageSummary | undefined): SessionUsageSummary | undefined {
  if (!record) {
    return undefined;
  }
  return {
    sessionKey: record.sessionKey,
    channelId: record.channelId,
    rootThreadTs: record.rootThreadTs,
    turnCount: record.turnCount,
    exactTurns: record.exactTurns,
    estimatedTurns: record.estimatedTurns,
    missingTurns: record.missingTurns,
    inputTokens: record.inputTokens,
    cachedInputTokens: record.cachedInputTokens,
    outputTokens: record.outputTokens,
    reasoningTokens: record.reasoningTokens,
    totalTokens: record.totalTokens,
    updatedAt: record.updatedAt,
    lastTurnAt: record.lastTurnAt ?? null,
    model: record.model ?? null,
    effort: record.effort ?? null
  };
}

function summarizeListUsage(usage: SessionUsageSummary): Record<string, unknown> {
  return {
    turnCount: usage.turnCount,
    totalTokens: usage.totalTokens,
    lastTurnAt: usage.lastTurnAt,
    updatedAt: usage.updatedAt
  };
}

function summarizeUsageBySession(
  records: readonly PersistedAgentTurnUsage[],
  limit?: number
): readonly SessionUsageSummary[] {
  const groups = new Map<string, MutableSessionUsageSummary>();

  for (const record of records) {
    const existing = groups.get(record.sessionKey) ?? {
      sessionKey: record.sessionKey,
      channelId: record.channelId,
      rootThreadTs: record.rootThreadTs,
      turnCount: 0,
      exactTurns: 0,
      estimatedTurns: 0,
      missingTurns: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      updatedAt: record.updatedAt,
      lastTurnAt: record.completedAt ?? record.updatedAt,
      model: record.model ?? null,
      effort: record.effort ?? null
    };
    existing.turnCount += 1;
    existing.exactTurns += record.source === "exact" ? 1 : 0;
    existing.estimatedTurns += record.source === "estimated" ? 1 : 0;
    existing.missingTurns += record.source === "missing" ? 1 : 0;
    existing.inputTokens += record.inputTokens;
    existing.cachedInputTokens += record.cachedInputTokens;
    existing.outputTokens += record.outputTokens;
    existing.reasoningTokens += record.reasoningTokens;
    existing.totalTokens += record.totalTokens;
    if (usageTimestampMs(record) >= Date.parse(existing.lastTurnAt ?? "")) {
      existing.updatedAt = record.updatedAt;
      existing.lastTurnAt = record.completedAt ?? record.updatedAt;
      existing.model = record.model ?? existing.model;
      existing.effort = record.effort ?? existing.effort;
    }
    groups.set(record.sessionKey, existing);
  }

  const sorted = [...groups.values()]
    .sort((left, right) => right.totalTokens - left.totalTokens || right.turnCount - left.turnCount);
  return limit === undefined ? sorted : sorted.slice(0, limit);
}

function emptySessionUsageSummary(session: SlackSessionRecord): SessionUsageSummary {
  return {
    sessionKey: session.key,
    channelId: session.channelId,
    rootThreadTs: session.rootThreadTs,
    turnCount: 0,
    exactTurns: 0,
    estimatedTurns: 0,
    missingTurns: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    updatedAt: session.updatedAt,
    lastTurnAt: null,
    model: null,
    effort: null
  };
}

function compareUsageRecordsDescending(left: PersistedAgentTurnUsage, right: PersistedAgentTurnUsage): number {
  return usageTimestampMs(right) - usageTimestampMs(left) || right.updatedAt.localeCompare(left.updatedAt);
}

function usageTimestampMs(record: PersistedAgentTurnUsage): number {
  const parsed = Date.parse(record.completedAt ?? record.updatedAt ?? record.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareSessions(
  left: SlackSessionRecord,
  right: SlackSessionRecord,
  related: {
    readonly inboundBySession: ReadonlyMap<string, readonly PersistedInboundMessage[]>;
    readonly jobsBySession: ReadonlyMap<string, readonly PersistedBackgroundJob[]>;
    readonly usageBySession: ReadonlyMap<string, SessionUsageSummary>;
  }
): number {
  const leftActive = left.activeTurnId ? 1 : 0;
  const rightActive = right.activeTurnId ? 1 : 0;
  if (leftActive !== rightActive) {
    return rightActive - leftActive;
  }
  return sessionLastActivityMs(right, {
    inbound: related.inboundBySession.get(right.key) ?? [],
    jobs: related.jobsBySession.get(right.key) ?? [],
    usage: related.usageBySession.get(right.key)
  }) - sessionLastActivityMs(left, {
    inbound: related.inboundBySession.get(left.key) ?? [],
    jobs: related.jobsBySession.get(left.key) ?? [],
    usage: related.usageBySession.get(left.key)
  }) || String(left.key).localeCompare(String(right.key));
}

function sessionLastActivityAt(
  session: SlackSessionRecord,
  related: {
    readonly inbound: readonly PersistedInboundMessage[];
    readonly jobs: readonly PersistedBackgroundJob[];
    readonly usage?: SessionUsageSummary | undefined;
  }
): string {
  const candidates = [
    session.lastTurnSignalAt,
    session.lastSlackReplyAt,
    session.activeTurnStartedAt,
    related.usage?.lastTurnAt,
    ...related.inbound.flatMap((message) => [message.updatedAt, message.createdAt]),
    ...related.jobs.flatMap(jobActivityTimestamps)
  ];
  const latestMs = newestTimestamp(candidates);
  return candidates.find((value) => timestampMs(value) === latestMs) ?? session.createdAt ?? session.updatedAt;
}

function sessionLastActivityMs(
  session: SlackSessionRecord,
  related: {
    readonly inbound: readonly PersistedInboundMessage[];
    readonly jobs: readonly PersistedBackgroundJob[];
    readonly usage?: SessionUsageSummary | undefined;
  }
): number {
  return timestampMs(sessionLastActivityAt(session, related));
}

function jobActivityTimestamps(job: PersistedBackgroundJob): Array<string | null | undefined> {
  return [
    job.lastEventAt,
    job.status === "running" ? null : job.updatedAt,
    job.createdAt
  ];
}

function sortBackgroundJobsForAdminSummary(jobs: readonly PersistedBackgroundJob[]): PersistedBackgroundJob[] {
  return [...jobs].sort((left, right) => {
    const rankDelta = backgroundJobDisplayRank(left) - backgroundJobDisplayRank(right);
    if (rankDelta) return rankDelta;
    return timestampMs(right.lastEventAt ?? right.updatedAt ?? right.createdAt) - timestampMs(left.lastEventAt ?? left.updatedAt ?? left.createdAt);
  });
}

function backgroundJobDisplayRank(job: PersistedBackgroundJob): number {
  if (isAdminCancellableJob(job)) return 0;
  if (job.status === "failed") return 2;
  return 1;
}

function timestampMs(value: unknown): number {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function newestTimestamp(values: readonly unknown[]): number {
  return values.reduce<number>((latest, value) => Math.max(latest, timestampMs(value)), 0);
}

function compareTimelineEvents(left: Record<string, JsonLike>, right: Record<string, JsonLike>): number {
  if (left.type === "session_created" && right.type !== "session_created") {
    return -1;
  }
  if (right.type === "session_created" && left.type !== "session_created") {
    return 1;
  }
  const atComparison = String(left.at ?? "").localeCompare(String(right.at ?? ""));
  if (atComparison !== 0) {
    return atComparison;
  }
  const leftSequence = typeof left.sequence === "number" ? left.sequence : 0;
  const rightSequence = typeof right.sequence === "number" ? right.sequence : 0;
  return leftSequence - rightSequence;
}

function selectTimelinePageEvents(options: {
  readonly agentEvents: readonly Record<string, JsonLike>[];
  readonly limit: number;
  readonly traceHasMore: boolean;
  readonly traceNextBeforeSequence: number | null;
}): {
  readonly events: readonly Record<string, JsonLike>[];
  readonly hasMore: boolean;
  readonly nextBeforeSequence: number | null;
} {
  const newest = [...options.agentEvents]
    .sort(compareTimelineEventsNewestFirst)
    .slice(0, options.limit);
  const returnedTraceSequences = newest
    .map((event) => typeof event.sequence === "number" ? event.sequence : null)
    .filter((sequence): sequence is number => typeof sequence === "number");
  const nextBeforeSequence = returnedTraceSequences.length
    ? Math.min(...returnedTraceSequences)
    : options.traceNextBeforeSequence;
  return {
    events: newest.slice().sort(compareTimelineEvents),
    hasMore: Boolean(nextBeforeSequence && options.traceHasMore),
    nextBeforeSequence
  };
}

function compareTimelineEventsNewestFirst(left: Record<string, JsonLike>, right: Record<string, JsonLike>): number {
  const atComparison = timestampMs(right.at) - timestampMs(left.at);
  if (atComparison !== 0) {
    return atComparison;
  }
  const leftSequence = typeof left.sequence === "number" ? left.sequence : 0;
  const rightSequence = typeof right.sequence === "number" ? right.sequence : 0;
  if (rightSequence !== leftSequence) {
    return rightSequence - leftSequence;
  }
  return String(right.id ?? "").localeCompare(String(left.id ?? ""));
}

function comparePersistedTraceEvents(left: PersistedAgentTraceEvent, right: PersistedAgentTraceEvent): number {
  const atComparison = left.at.localeCompare(right.at);
  if (atComparison !== 0) {
    return atComparison;
  }
  return left.sequence - right.sequence || left.id.localeCompare(right.id);
}

function comparePersistedTraceEventsNewestFirst(left: PersistedAgentTraceEvent, right: PersistedAgentTraceEvent): number {
  const atComparison = timestampMs(right.at) - timestampMs(left.at);
  if (atComparison !== 0) {
    return atComparison;
  }
  return right.sequence - left.sequence || right.id.localeCompare(left.id);
}

function summarizeAgentTrace(
  events: readonly PersistedAgentTraceEvent[],
  allEvents: readonly PersistedAgentTraceEvent[] = events
): Record<string, JsonLike> {
  const categories: Record<string, number> = {};
  const sources: Record<string, number> = {};
  for (const event of events) {
    categories[event.type] = (categories[event.type] ?? 0) + 1;
    sources[event.source] = (sources[event.source] ?? 0) + 1;
  }
  const modelRequestCount = allEvents.filter((event) => event.type === "agent_token_count").length;
  return {
    source: "broker_db",
    eventCount: events.length,
    modelRequestCount,
    categories,
    sources
  };
}

function traceSummaryFromPersisted(
  summary: PersistedAgentSessionTraceSummary | undefined,
  fallbackEvents: readonly PersistedAgentTraceEvent[]
): Record<string, JsonLike> {
  if (!summary) {
    return summarizeAgentTrace(fallbackEvents);
  }
  return {
    source: "broker_db",
    eventCount: summary.eventCount,
    modelRequestCount: summary.modelRequestCount,
    categories: summary.categories,
    sources: summary.sources
  };
}

function isVisibleTimelineTraceEvent(event: PersistedAgentTraceEvent): boolean {
  if (event.type === "agent_token_count") {
    return false;
  }
  if (event.type === "agent_input_delivered" || event.type === "agent_turn_started") {
    return false;
  }
  if (event.type === "agent_turn_completed" && event.status === "completed") {
    return false;
  }
  return true;
}

function visibleTimelineTraceEvents(events: readonly PersistedAgentTraceEvent[]): PersistedAgentTraceEvent[] {
  const completedToolCallKeys = new Set(
    events
      .filter((event) => event.type === "agent_tool_result")
      .map(toolTraceKey)
      .filter(Boolean)
  );
  return events.filter((event) => {
    if (!isVisibleTimelineTraceEvent(event)) {
      return false;
    }
    return !(event.type === "agent_tool_call" && completedToolCallKeys.has(toolTraceKey(event)));
  });
}

function toolTraceKey(event: Pick<PersistedAgentTraceEvent, "turnId" | "callId" | "toolName">): string {
  if (event.callId) {
    return [event.turnId ?? "", event.callId].join("\u001f");
  }
  if (!event.turnId && !event.toolName) {
    return "";
  }
  return [event.turnId ?? "", event.toolName ?? ""].join("\u001f");
}

function agentTraceEventToTimelineEvent(event: PersistedAgentTraceEvent, options: {
  readonly includeDetail?: boolean | undefined;
} = {}): Record<string, JsonLike> {
  return withoutUndefined({
    id: event.id,
    sessionKey: event.sessionKey,
    type: event.type,
    at: event.at,
    sequence: event.sequence,
    title: event.title,
    summary: event.summary,
    detail: options.includeDetail ? event.detail : undefined,
    detailAvailable: Boolean(event.detail),
    status: event.status,
    role: event.role,
    toolName: event.toolName,
    callId: event.callId,
    turnId: event.turnId,
    source: event.source,
    detailTruncated: event.detailTruncated,
    detailOriginalChars: event.detailOriginalChars,
    metadata: event.metadata
  });
}

function withoutUndefined(values: Record<string, JsonLike | undefined>): Record<string, JsonLike> {
  const result: Record<string, JsonLike> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
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

function isUserInboundMessage(message: PersistedInboundMessage): boolean {
  return (
    isHumanInboundMessage(message) &&
    message.senderKind !== "bot" &&
    message.senderKind !== "app" &&
    message.text.trim().length > 0
  );
}

function channelLabelForSession(
  session: SlackSessionRecord,
  inbound: readonly PersistedInboundMessage[],
  channelLabels?: ReadonlyMap<string, string> | undefined
): string {
  return channelHumanLabelForSession(session, inbound)
    ?? channelLabels?.get(session.channelId)
    ?? session.channelId;
}

function channelLabelForConversationInfo(
  info: Awaited<ReturnType<SlackConversationLookup["getConversationInfo"]>>
): string | undefined {
  if (!info) {
    return undefined;
  }
  if (info.name) {
    return formatSlackChannelName(info.name);
  }
  if (info.channelType === "im") {
    return "私信";
  }
  if (info.channelType === "mpim") {
    return "群聊";
  }
  return undefined;
}

function uniqueChannelIds(sessions: readonly SlackSessionRecord[]): string[] {
  return [...new Set(sessions.map((session) => session.channelId).filter((channelId) => channelId))];
}

function looksLikeSlackConversationId(channelId: string): boolean {
  return /^[CDG][A-Z0-9]+$/.test(channelId);
}

function looksLikeSlackUserId(userId: string): boolean {
  return /^U[A-Z0-9]+$/.test(userId);
}

function buildChannelLabelLookup(
  sessions: readonly SlackSessionRecord[],
  inboundBySession: ReadonlyMap<string, readonly PersistedInboundMessage[]>
): Map<string, string> {
  const labels = new Map<string, string>();
  for (const session of sessions) {
    const label = channelHumanLabelForSession(session, inboundBySession.get(session.key) ?? []);
    if (label) {
      labels.set(session.channelId, label);
    }
  }
  return labels;
}

function buildGitHubAccounts(options: {
  readonly bindings: readonly GitHubPrBindingRecord[];
  readonly defaultPrAccount: GitHubPrIdentityStatus["defaultAccount"];
  readonly sessions?: readonly SlackSessionRecord[] | undefined;
  readonly inbound?: readonly PersistedInboundMessage[] | undefined;
  readonly slackIdentities?: ReadonlyMap<string, SlackUserIdentity> | undefined;
}): RuntimeStatus["githubAccounts"] {
  const rows = new Map<string, {
    slackUserId: string;
    slackIdentity?: SlackUserIdentity | undefined;
    binding?: GitHubPrBindingRecord | undefined;
  }>();
  const slackIdentities = collectSlackIdentities(options.sessions ?? [], options.inbound ?? []);
  for (const [userId, identity] of options.slackIdentities ?? []) {
    slackIdentities.set(userId, identity);
  }

  for (const session of options.sessions ?? []) {
    const slackUserId = normalizeNonEmptyString(session.initiatorUserId);
    if (!slackUserId) {
      continue;
    }
    rows.set(slackUserId, {
      ...(rows.get(slackUserId) ?? { slackUserId }),
      slackUserId,
      slackIdentity: slackIdentities.get(slackUserId) ?? fallbackSlackIdentity(slackUserId)
    });
  }

  for (const message of options.inbound ?? []) {
    if (!isUserInboundMessage(message) || isSyntheticSlackUserId(message.userId)) {
      continue;
    }
    const slackUserId = message.userId;
    rows.set(slackUserId, {
      ...(rows.get(slackUserId) ?? { slackUserId }),
      slackUserId,
      slackIdentity: rows.get(slackUserId)?.slackIdentity ?? slackIdentities.get(slackUserId) ?? fallbackSlackIdentity(slackUserId)
    });
  }

  for (const binding of options.bindings) {
    rows.set(binding.slackUserId, {
      ...(rows.get(binding.slackUserId) ?? { slackUserId: binding.slackUserId }),
      slackUserId: binding.slackUserId,
      slackIdentity: rows.get(binding.slackUserId)?.slackIdentity ?? slackIdentities.get(binding.slackUserId) ?? fallbackSlackIdentity(binding.slackUserId),
      binding
    });
  }

  const defaultSlackUserId = options.defaultPrAccount.available && options.defaultPrAccount.source === "bound"
    ? options.defaultPrAccount.slackUserId
    : undefined;
  const accounts = [...rows.values()]
    .map((row) => ({
      slackUserId: row.slackUserId,
      slackIdentity: row.slackIdentity ?? {
        userId: row.slackUserId,
        mention: `<@${row.slackUserId}>`
      },
      isDefaultPrAccount: row.slackUserId === defaultSlackUserId,
      prBinding: row.binding
        ? {
            state: row.binding.revokedAt ? "revoked" : "bound",
            githubLogin: row.binding.githubLogin,
            githubUserId: row.binding.githubUserId,
            githubEmail: row.binding.githubEmail ?? null,
            githubName: row.binding.githubName ?? null,
            scopes: row.binding.scopes,
            createdAt: row.binding.createdAt,
            updatedAt: row.binding.updatedAt,
            lastValidatedAt: row.binding.lastValidatedAt ?? null,
            revokedAt: row.binding.revokedAt ?? null
          }
        : {
            state: "unbound"
          }
    }))
    .sort((left, right) => {
      if (left.isDefaultPrAccount !== right.isDefaultPrAccount) {
        return left.isDefaultPrAccount ? -1 : 1;
      }
      const leftBound = left.prBinding.state === "bound";
      const rightBound = right.prBinding.state === "bound";
      if (leftBound !== rightBound) {
        return leftBound ? -1 : 1;
      }
      return left.slackUserId.localeCompare(right.slackUserId);
    });

  return {
    count: accounts.length,
    defaultPrAccount: options.defaultPrAccount,
    accounts
  };
}

function collectKnownGitHubAccountSlackUserIds(options: {
  readonly bindings: readonly GitHubPrBindingRecord[];
  readonly sessions: readonly SlackSessionRecord[];
  readonly inbound?: readonly PersistedInboundMessage[] | undefined;
}): Set<string> {
  const ids = new Set<string>();
  for (const binding of options.bindings) ids.add(binding.slackUserId);
  for (const session of options.sessions) {
    const initiatorUserId = normalizeNonEmptyString(session.initiatorUserId);
    if (initiatorUserId) ids.add(initiatorUserId);
  }
  for (const message of options.inbound ?? []) {
    if (isUserInboundMessage(message) && !isSyntheticSlackUserId(message.userId)) {
      ids.add(message.userId);
    }
  }
  return ids;
}

function collectSlackIdentities(
  sessions: readonly SlackSessionRecord[],
  inbound: readonly PersistedInboundMessage[]
): Map<string, SlackUserIdentity> {
  const identities = new Map<string, SlackUserIdentity>();
  for (const message of inbound) {
    for (const user of message.mentionedUsers ?? []) {
      if (user.userId) identities.set(user.userId, user);
    }
    const userId = normalizeNonEmptyString(message.userId);
    if (userId && !userId.startsWith("username:")) {
      identities.set(userId, {
        ...fallbackSlackIdentity(userId),
        ...(normalizeNonEmptyString(message.senderUsername) ? { username: normalizeNonEmptyString(message.senderUsername) } : {}),
        ...slackIdentityFromMessagePayload(userId, message.slackMessage)
      });
    }
  }
  for (const session of sessions) {
    const initiatorUserId = normalizeNonEmptyString(session.initiatorUserId);
    if (initiatorUserId && !identities.has(initiatorUserId)) {
      identities.set(initiatorUserId, fallbackSlackIdentity(initiatorUserId));
    }
  }
  return identities;
}

function slackIdentityFromMessagePayload(userId: string, payload: JsonLike | undefined): Partial<SlackUserIdentity> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  const profile = "user_profile" in payload && payload.user_profile && typeof payload.user_profile === "object" && !Array.isArray(payload.user_profile)
    ? payload.user_profile as Record<string, unknown>
    : undefined;
  return {
    userId,
    mention: `<@${userId}>`,
    ...(normalizeNonEmptyString(profile?.display_name) ? { displayName: normalizeNonEmptyString(profile?.display_name) } : {}),
    ...(normalizeNonEmptyString(profile?.real_name) ? { realName: normalizeNonEmptyString(profile?.real_name) } : {}),
    ...(normalizeNonEmptyString(profile?.email) ? { email: normalizeNonEmptyString(profile?.email) } : {})
  };
}

function inboundMessageSlackIdentity(message: PersistedInboundMessage): SlackUserIdentity {
  return {
    ...fallbackSlackIdentity(message.userId),
    ...(normalizeNonEmptyString(message.senderUsername) ? { username: normalizeNonEmptyString(message.senderUsername) } : {}),
    ...slackIdentityFromMessagePayload(message.userId, message.slackMessage)
  };
}

function fallbackSlackIdentity(userId: string): SlackUserIdentity {
  return {
    userId,
    mention: `<@${userId}>`
  };
}

function isSyntheticSlackUserId(userId: string): boolean {
  return userId.startsWith("username:");
}

function channelHumanLabelForSession(
  session: SlackSessionRecord,
  inbound: readonly PersistedInboundMessage[]
): string | undefined {
  if (session.channelName) {
    return formatSlackChannelName(session.channelName);
  }

  const channelName = inbound
    .map((message) => readStringField(message.slackMessage, "channel_name"))
    .find((value) => value);
  if (channelName) {
    return formatSlackChannelName(channelName);
  }

  const channelType = session.channelType ?? inbound.find((message) => message.channelType)?.channelType;
  if (channelType === "im") {
    return "私信";
  }
  if (channelType === "mpim") {
    return "群聊";
  }
  return undefined;
}

function formatSlackChannelName(channelName: string): string {
  return channelName.startsWith("#") ? channelName : `#${channelName}`;
}

function buildSlackThreadUrl(channelId: string, rootThreadTs: string): string {
  const params = new URLSearchParams({
    channel: channelId,
    message_ts: rootThreadTs
  });
  return `https://slack.com/app_redirect?${params.toString()}`;
}

function readStringField(value: JsonLike | undefined, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

function readNestedBoolean(value: unknown, path: readonly string[]): boolean {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return false;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current === true;
}

function assertSubpathOf(rootPath: string, targetPath: string): void {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error(`Refusing to delete artifact outside managed root: ${resolvedTarget}`);
}

function isAdminCancellableJob(job: PersistedBackgroundJob): boolean {
  return job.status === "registered" || job.status === "running";
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function clampPositiveInteger(value: unknown, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function withAdminProbeTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ADMIN_RUNTIME_PROBE_TIMEOUT_MS}ms`));
    }, ADMIN_RUNTIME_PROBE_TIMEOUT_MS);
    promise.then(resolve, reject).finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    });
  });
}

function serializeProbeError(error: unknown): Record<string, unknown> {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  };
}
