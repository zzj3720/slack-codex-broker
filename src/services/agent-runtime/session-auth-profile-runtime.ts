import { EventEmitter } from "node:events";
import path from "node:path";

import type { AppConfig } from "../../config.js";
import type { AuthProfileService, AuthProfileSummary } from "../auth-profile-service.js";
import { CodexBroker } from "../codex/codex-broker.js";
import { SessionManager } from "../session-manager.js";
import {
  authProfileReasonLabel,
  evaluateAuthProfile,
  findAuthProfile,
  isAuthProfileProbeFailure,
  isAuthProfileProbeFailureReason,
  selectBestAuthProfile,
  type AuthProfileUnavailableReason
} from "../session-auth-profile-selector.js";
import { CodexAppServerRuntime } from "./codex-app-server-runtime.js";
import type {
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentRuntimeEvent,
  AgentSession,
  AgentSessionSnapshot,
  AgentSubmitInputResult,
  AgentTurnSnapshot,
  ReadAgentTurnOptions,
  SubmitAgentInput
} from "./types.js";
import type { SlackSessionRecord, SlackUserIdentity } from "../../types.js";

interface ProfileRuntimeEntry {
  readonly runtime: AgentRuntime;
  readonly eventHandler: (event: AgentRuntimeEvent) => void;
}

export class AuthProfileUnavailableError extends Error {
  readonly code = "auth_profile_unavailable";
  readonly sessionKey: string;
  readonly profileName?: string | undefined;
  readonly reason: AuthProfileUnavailableReason;

  constructor(options: {
    readonly sessionKey: string;
    readonly profileName?: string | undefined;
    readonly reason: AuthProfileUnavailableReason;
  }) {
    super(`Auth profile unavailable for ${options.sessionKey}: ${options.profileName ?? "none"} (${options.reason})`);
    this.name = "AuthProfileUnavailableError";
    this.sessionKey = options.sessionKey;
    this.profileName = options.profileName;
    this.reason = options.reason;
  }

  get userMessage(): string {
    return authProfileReasonLabel(this.reason);
  }
}

export function isAuthProfileUnavailableError(error: unknown): error is AuthProfileUnavailableError {
  return error instanceof AuthProfileUnavailableError ||
    Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "auth_profile_unavailable");
}

export class SessionAuthProfileRuntime extends EventEmitter implements AgentRuntime {
  readonly #config: AppConfig;
  readonly #sessions: SessionManager;
  readonly #authProfiles: AuthProfileService;
  readonly #createProfileRuntime: (options: {
    readonly profile: AuthProfileSummary;
    readonly codexHome: string;
    readonly teamCodexHomePath: string;
    readonly port: number;
  }) => AgentRuntime;
  readonly #legacyRuntime?: AgentRuntime | undefined;
  readonly #profileRuntimes = new Map<string, ProfileRuntimeEntry>();
  readonly #profilePorts = new Map<string, number>();
  #nextPortOffset = 0;
  #slackBotIdentity: SlackUserIdentity | null = null;

  constructor(options: {
    readonly config: AppConfig;
    readonly sessions: SessionManager;
    readonly authProfiles: AuthProfileService;
    readonly legacyRuntime?: AgentRuntime | undefined;
    readonly createProfileRuntime?: ((options: {
      readonly profile: AuthProfileSummary;
      readonly codexHome: string;
      readonly teamCodexHomePath: string;
      readonly port: number;
    }) => AgentRuntime) | undefined;
  }) {
    super();
    this.#config = options.config;
    this.#sessions = options.sessions;
    this.#authProfiles = options.authProfiles;
    this.#legacyRuntime = options.legacyRuntime;
    this.#nextPortOffset = options.legacyRuntime ? 1 : 0;
    this.#createProfileRuntime = options.createProfileRuntime ?? ((runtimeOptions) =>
      createDefaultProfileRuntime({
        config: this.#config,
        sessions: this.#sessions,
        ...runtimeOptions
      })
    );
    if (this.#legacyRuntime) {
      this.#legacyRuntime.on("event", (event) => this.emit("event", event));
    }
  }

  getCapabilities(): AgentRuntimeCapabilities {
    return {
      submitWhileActive: true,
      interrupt: true,
      readTurn: true,
      readSession: true,
      rawEvents: true,
      tokenUsage: "exact",
      toolCalls: true,
      systemPromptEcho: true
    };
  }

  async start(): Promise<void> {
    await this.#legacyRuntime?.start();
  }

  async stop(): Promise<void> {
    const entries = [...this.#profileRuntimes.values()];
    this.#profileRuntimes.clear();
    await Promise.all(entries.map(async (entry) => {
      entry.runtime.off("event", entry.eventHandler);
      await entry.runtime.stop();
    }));
    await this.#legacyRuntime?.stop();
  }

  setSlackBotIdentity(identity: SlackUserIdentity | null): void {
    this.#slackBotIdentity = identity;
    this.#legacyRuntime?.setSlackBotIdentity(identity);
    for (const entry of this.#profileRuntimes.values()) {
      entry.runtime.setSlackBotIdentity(identity);
    }
  }

  async ensureSession(session: SlackSessionRecord): Promise<AgentSession> {
    const resolved = await this.#resolveRuntime(session);
    return await resolved.runtime.ensureSession(resolved.session);
  }

  async submitInput(input: SubmitAgentInput): Promise<AgentSubmitInputResult> {
    const resolved = await this.#resolveRuntime(input.session);
    return await resolved.runtime.submitInput({
      ...input,
      session: resolved.session
    });
  }

  async interrupt(session: SlackSessionRecord): Promise<void> {
    const resolved = await this.#resolveRuntime(session);
    await resolved.runtime.interrupt(resolved.session);
  }

  async readSession(session: SlackSessionRecord): Promise<AgentSessionSnapshot | null> {
    const resolved = await this.#resolveRuntime(session);
    return await resolved.runtime.readSession(resolved.session);
  }

  async readTurn(
    session: SlackSessionRecord,
    turnId: string,
    options?: ReadAgentTurnOptions
  ): Promise<AgentTurnSnapshot | null> {
    const resolved = await this.#resolveRuntime(session);
    return await resolved.runtime.readTurn(resolved.session, turnId, options);
  }

  async #resolveRuntime(session: SlackSessionRecord): Promise<{
    readonly session: SlackSessionRecord;
    readonly runtime: AgentRuntime;
  }> {
    const status = await this.#authProfiles.listProfilesStatus();
    if (status.profiles.length === 0 && this.#legacyRuntime) {
      return {
        session,
        runtime: this.#legacyRuntime
      };
    }

    if (session.authProfileName) {
      const profile = findAuthProfile(status, session.authProfileName);
      if (!profile) {
        throw new AuthProfileUnavailableError({
          sessionKey: session.key,
          profileName: session.authProfileName,
          reason: "profile_not_found"
        });
      }

      const evaluation = evaluateAuthProfile(profile);
      if (!evaluation.usable) {
        if (isAuthProfileProbeFailure(evaluation)) {
          const resolvedSession = session.authBlockedAt && isAuthProfileProbeFailureReason(session.authBlockReason)
            ? await this.#sessions.clearSessionAuthBlock(session.key)
            : session;
          return {
            session: resolvedSession,
            runtime: this.#runtimeForProfile(profile)
          };
        }
        throw new AuthProfileUnavailableError({
          sessionKey: session.key,
          profileName: profile.name,
          reason: evaluation.reason ?? "rate_limits_probe_failed"
        });
      }

      const resolvedSession = session.authBlockedAt
        ? await this.#sessions.clearSessionAuthBlock(session.key)
        : session;

      return {
        session: resolvedSession,
        runtime: this.#runtimeForProfile(profile)
      };
    }

    const selected = selectBestAuthProfile(status);
    if (!selected) {
      const probeFailure = status.profiles
        .map((profile) => evaluateAuthProfile(profile))
        .find((evaluation) => isAuthProfileProbeFailure(evaluation));
      throw new AuthProfileUnavailableError({
        sessionKey: session.key,
        reason: probeFailure?.reason ?? "no_usable_auth_profiles"
      });
    }

    const boundSession = await this.#sessions.setSessionAuthProfile(session.key, selected.name);
    return {
      session: boundSession,
      runtime: this.#runtimeForProfile(selected)
    };
  }

  #runtimeForProfile(profile: AuthProfileSummary): AgentRuntime {
    const existing = this.#profileRuntimes.get(profile.name);
    if (existing) {
      return existing.runtime;
    }

    const runtime = this.#createProfileRuntime({
      profile,
      codexHome: path.join(this.#profileRuntimeRoot(profile.name), "codex-home"),
      teamCodexHomePath: this.#config.codexTeamHomePath,
      port: this.#portForProfile(profile.name)
    });
    runtime.setSlackBotIdentity(this.#slackBotIdentity);
    const eventHandler = (event: AgentRuntimeEvent) => this.emit("event", event);
    runtime.on("event", eventHandler);
    this.#profileRuntimes.set(profile.name, {
      runtime,
      eventHandler
    });
    return runtime;
  }

  #profileRuntimeRoot(profileName: string): string {
    return path.join(path.dirname(this.#config.stateDir), "auth-profile-runtimes", safePathSegment(profileName));
  }

  #portForProfile(profileName: string): number {
    const existing = this.#profilePorts.get(profileName);
    if (existing) {
      return existing;
    }

    const port = this.#config.codexAppServerPort + this.#nextPortOffset;
    this.#nextPortOffset += 1;
    this.#profilePorts.set(profileName, port);
    return port;
  }
}

function createDefaultProfileRuntime(options: {
  readonly config: AppConfig;
  readonly sessions: SessionManager;
  readonly profile: AuthProfileSummary;
  readonly codexHome: string;
  readonly teamCodexHomePath: string;
  readonly port: number;
}): AgentRuntime {
  const codex = new CodexBroker({
    serviceName: `${options.config.serviceName}:${options.profile.name}`,
    brokerHttpBaseUrl: options.config.brokerHttpBaseUrl,
    codexHome: options.codexHome,
    teamCodexHomePath: options.teamCodexHomePath,
    reposRoot: options.config.reposRoot,
    hostCodexHomePath: options.config.codexHostHomePath,
    hostGeminiHomePath: options.config.geminiHostHomePath,
    codexAppServerPort: options.port,
    codexAuthJsonPath: options.profile.path,
    codexDisabledMcpServers: options.config.codexDisabledMcpServers,
    tempadLinkServiceUrl: options.config.tempadLinkServiceUrl,
    geminiHttpProxy: options.config.geminiHttpProxy,
    geminiHttpsProxy: options.config.geminiHttpsProxy,
    geminiAllProxy: options.config.geminiAllProxy,
    openAiApiKey: options.config.codexOpenAiApiKey
  });
  return new CodexAppServerRuntime({
    codex,
    sessions: options.sessions
  });
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_") || "profile";
}
