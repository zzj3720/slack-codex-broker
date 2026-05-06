import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { AppConfig } from "../config.js";
import type { PersistedBackgroundJob, PersistedInboundMessage, SlackSessionRecord } from "../types.js";
import type { SessionManager } from "./session-manager.js";
import type { AuthProfileService, AuthProfileSummary } from "./auth-profile-service.js";
import type { GitHubAuthorMappingService } from "./github-author-mapping-service.js";
import type { RuntimeControl } from "./runtime-control.js";
import { logger } from "../logger.js";
import { AppServerClient } from "./codex/app-server-client.js";
import { AppServerProcess } from "./codex/app-server-process.js";
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

type AuthProfileOAuthStatus =
  | "starting"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled";

interface AuthProfileOAuthAttempt {
  readonly id: string;
  readonly createdAt: string;
  readonly rootPath: string;
  readonly codexHome: string;
  readonly port: number;
  readonly profileName?: string | undefined;
  process?: AppServerProcess | undefined;
  client?: AppServerClient | undefined;
  loginId?: string | undefined;
  verificationUrl?: string | undefined;
  userCode?: string | undefined;
  status: AuthProfileOAuthStatus;
  updatedAt: string;
  error?: string | undefined;
  profile?: AuthProfileSummary | undefined;
  notificationListener?: ((method: string, params: Record<string, any> | undefined) => void) | undefined;
  timeout?: NodeJS.Timeout | undefined;
}

const AUTH_PROFILE_OAUTH_TIMEOUT_MS = 10 * 60 * 1000;
const AUTH_PROFILE_OAUTH_ATTEMPT_RETENTION_MS = 30 * 60 * 1000;

export class AdminService {
  readonly #authProfileOAuthAttempts = new Map<string, AuthProfileOAuthAttempt>();

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
      authProfileOAuthAttempts: this.#listAuthProfileOAuthAttempts(),
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

  async startAuthProfileOAuth(options: {
    readonly name?: string | undefined;
  }): Promise<Record<string, unknown>> {
    await this.#pruneAuthProfileOAuthAttempts();
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const rootPath = path.join(path.dirname(this.options.config.stateDir), "auth-profile-oauth", id);
    const codexHome = path.join(rootPath, "codex-home");
    const port = await findFreeTcpPort();
    const process = new AppServerProcess({
      brokerHttpBaseUrl: this.options.config.brokerHttpBaseUrl,
      codexHome,
      hostCodexHomePath: this.options.config.codexHostHomePath,
      hostGeminiHomePath: this.options.config.geminiHostHomePath,
      port,
      disabledMcpServers: this.options.config.codexDisabledMcpServers,
      tempadLinkServiceUrl: this.options.config.tempadLinkServiceUrl,
      geminiHttpProxy: this.options.config.geminiHttpProxy,
      geminiHttpsProxy: this.options.config.geminiHttpsProxy,
      geminiAllProxy: this.options.config.geminiAllProxy,
      bootstrapAuth: false
    });
    const client = new AppServerClient({
      url: process.url,
      serviceName: `${this.options.config.serviceName}-admin-oauth`,
      brokerHttpBaseUrl: this.options.config.brokerHttpBaseUrl,
      reposRoot: this.options.config.reposRoot,
      personalMemoryFilePath: path.join(codexHome, "AGENT.md")
    });
    const attempt: AuthProfileOAuthAttempt = {
      id,
      createdAt,
      rootPath,
      codexHome,
      port,
      profileName: options.name,
      process,
      client,
      status: "starting",
      updatedAt: createdAt
    };
    this.#authProfileOAuthAttempts.set(id, attempt);

    try {
      await process.start();
      await client.connect();
      const login = await client.loginWithChatGptDeviceCode();
      attempt.loginId = login.loginId;
      attempt.verificationUrl = login.verificationUrl;
      attempt.userCode = login.userCode;
      this.#setAuthProfileOAuthStatus(attempt, "waiting");
      this.#watchAuthProfileOAuthAttempt(attempt);
      return {
        ok: true,
        attempt: this.#serializeAuthProfileOAuthAttempt(attempt)
      };
    } catch (error) {
      this.#setAuthProfileOAuthStatus(attempt, "failed", error);
      await this.#cleanupAuthProfileOAuthRuntime(attempt, {
        removeFiles: true
      });
      throw error;
    }
  }

  async getAuthProfileOAuthAttempt(options: {
    readonly id: string;
  }): Promise<Record<string, unknown>> {
    const attempt = this.#authProfileOAuthAttempts.get(options.id);
    if (!attempt) {
      throw new Error(`Auth OAuth attempt not found: ${options.id}`);
    }

    return {
      ok: true,
      attempt: this.#serializeAuthProfileOAuthAttempt(attempt)
    };
  }

  async cancelAuthProfileOAuthAttempt(options: {
    readonly id: string;
  }): Promise<Record<string, unknown>> {
    const attempt = this.#authProfileOAuthAttempts.get(options.id);
    if (!attempt) {
      throw new Error(`Auth OAuth attempt not found: ${options.id}`);
    }

    if (attempt.status === "starting" || attempt.status === "waiting") {
      if (attempt.client && attempt.loginId) {
        await attempt.client.cancelLogin(attempt.loginId).catch((error) => {
          logger.warn("Failed to cancel admin auth profile OAuth login", {
            attemptId: attempt.id,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }
      this.#setAuthProfileOAuthStatus(attempt, "cancelled");
      await this.#cleanupAuthProfileOAuthRuntime(attempt, {
        removeFiles: true
      });
    }

    return {
      ok: true,
      attempt: this.#serializeAuthProfileOAuthAttempt(attempt)
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

  #watchAuthProfileOAuthAttempt(attempt: AuthProfileOAuthAttempt): void {
    const listener = (method: string, params: Record<string, any> | undefined) => {
      if (method !== "account/login/completed") {
        return;
      }

      const loginId = readUnknownString(params?.loginId) ?? readUnknownString(params?.login_id);
      if (attempt.loginId && loginId && loginId !== attempt.loginId) {
        return;
      }

      void this.#completeAuthProfileOAuthAttempt(attempt, params ?? {});
    };
    attempt.notificationListener = listener;
    attempt.client?.on("notification", listener);
    attempt.timeout = setTimeout(() => {
      void this.#failAuthProfileOAuthAttempt(attempt, new Error("ChatGPT device-code login timed out"));
    }, AUTH_PROFILE_OAUTH_TIMEOUT_MS);
  }

  async #completeAuthProfileOAuthAttempt(
    attempt: AuthProfileOAuthAttempt,
    params: Record<string, unknown>
  ): Promise<void> {
    if (attempt.status !== "waiting" && attempt.status !== "starting") {
      return;
    }

    const success = params.success === true;
    if (!success) {
      await this.#failAuthProfileOAuthAttempt(
        attempt,
        new Error(readUnknownString(params.error) ?? "ChatGPT device-code login failed")
      );
      return;
    }

    try {
      const authJsonPath = path.join(attempt.codexHome, "auth.json");
      const authJsonContent = await fs.readFile(authJsonPath, "utf8");
      const profile = await this.options.authProfiles.addProfile({
        name: attempt.profileName,
        authJsonContent
      });
      attempt.profile = profile;
      this.#setAuthProfileOAuthStatus(attempt, "succeeded");
      await this.#cleanupAuthProfileOAuthRuntime(attempt, {
        removeFiles: true
      });
    } catch (error) {
      await this.#failAuthProfileOAuthAttempt(attempt, error);
    }
  }

  async #failAuthProfileOAuthAttempt(
    attempt: AuthProfileOAuthAttempt,
    error: unknown
  ): Promise<void> {
    if (attempt.status !== "starting" && attempt.status !== "waiting") {
      return;
    }

    this.#setAuthProfileOAuthStatus(attempt, "failed", error);
    await this.#cleanupAuthProfileOAuthRuntime(attempt, {
      removeFiles: true
    });
  }

  #setAuthProfileOAuthStatus(
    attempt: AuthProfileOAuthAttempt,
    status: AuthProfileOAuthStatus,
    error?: unknown
  ): void {
    attempt.status = status;
    attempt.updatedAt = new Date().toISOString();
    if (error !== undefined) {
      attempt.error = error instanceof Error ? error.message : String(error);
    }
  }

  async #cleanupAuthProfileOAuthRuntime(
    attempt: AuthProfileOAuthAttempt,
    options: {
      readonly removeFiles: boolean;
    }
  ): Promise<void> {
    if (attempt.timeout) {
      clearTimeout(attempt.timeout);
      attempt.timeout = undefined;
    }

    if (attempt.client && attempt.notificationListener) {
      attempt.client.off("notification", attempt.notificationListener);
      attempt.notificationListener = undefined;
    }

    const client = attempt.client;
    const process = attempt.process;
    attempt.client = undefined;
    attempt.process = undefined;

    await client?.close().catch((error) => {
      logger.warn("Failed to close admin auth profile OAuth app-server client", {
        attemptId: attempt.id,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    await process?.stop().catch((error) => {
      logger.warn("Failed to stop admin auth profile OAuth app-server process", {
        attemptId: attempt.id,
        error: error instanceof Error ? error.message : String(error)
      });
    });

    if (options.removeFiles) {
      await fs.rm(attempt.rootPath, {
        recursive: true,
        force: true
      }).catch((error) => {
        logger.warn("Failed to remove admin auth profile OAuth temp directory", {
          attemptId: attempt.id,
          rootPath: attempt.rootPath,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
  }

  #serializeAuthProfileOAuthAttempt(attempt: AuthProfileOAuthAttempt): Record<string, unknown> {
    return {
      id: attempt.id,
      status: attempt.status,
      profileName: attempt.profileName ?? null,
      loginId: attempt.loginId ?? null,
      verificationUrl: attempt.verificationUrl ?? null,
      userCode: attempt.userCode ?? null,
      error: attempt.error ?? null,
      profile: attempt.profile ?? null,
      createdAt: attempt.createdAt,
      updatedAt: attempt.updatedAt,
      port: attempt.port
    };
  }

  #listAuthProfileOAuthAttempts(): readonly Record<string, unknown>[] {
    return [...this.#authProfileOAuthAttempts.values()]
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
      .map((attempt) => this.#serializeAuthProfileOAuthAttempt(attempt));
  }

  async #pruneAuthProfileOAuthAttempts(): Promise<void> {
    const cutoff = Date.now() - AUTH_PROFILE_OAUTH_ATTEMPT_RETENTION_MS;
    for (const attempt of this.#authProfileOAuthAttempts.values()) {
      const updatedAtMs = Date.parse(attempt.updatedAt);
      if (
        Number.isFinite(updatedAtMs) &&
        updatedAtMs < cutoff &&
        attempt.status !== "starting" &&
        attempt.status !== "waiting"
      ) {
        this.#authProfileOAuthAttempts.delete(attempt.id);
      }
    }
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
    const filePath = path.join(this.options.config.logDir, "broker.jsonl");

    try {
      const raw = await fs.readFile(filePath, "utf8");
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
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return [];
      }

      throw error;
    }
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

async function findFreeTcpPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        if (!port) {
          reject(new Error("Failed to allocate a temporary TCP port"));
          return;
        }

        resolve(port);
      });
    });
  });
}

function readUnknownString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
