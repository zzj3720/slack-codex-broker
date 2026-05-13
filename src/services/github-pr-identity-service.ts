import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { SlackSessionRecord } from "../types.js";
import { ensureDir } from "../utils/fs.js";

export interface GitHubPrBindingRecord {
  readonly slackUserId: string;
  readonly githubLogin: string;
  readonly githubUserId: number;
  readonly token: string;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastValidatedAt?: string | undefined;
  readonly revokedAt?: string | undefined;
}

export type GitHubPrTokenResolution =
  | {
      readonly ok: true;
      readonly mode: "initiator";
      readonly slackUserId: string;
      readonly githubLogin: string;
      readonly token: string;
    }
  | {
      readonly ok: true;
      readonly mode: "default";
      readonly githubLogin: string;
      readonly token: string;
      readonly reason: "missing_initiator" | "initiator_unbound";
    }
  | {
      readonly ok: false;
      readonly mode: "blocked";
      readonly reason:
        | "session_not_found"
        | "missing_initiator"
        | "initiator_unbound"
        | "initiator_token_invalid"
        | "default_account_unavailable";
      readonly message: string;
      readonly slackUserId?: string | undefined;
      readonly githubLogin?: string | undefined;
    };

export interface GitHubPrIdentityStatus {
  readonly initiatorUserId?: string | undefined;
  readonly binding:
    | {
        readonly state: "bound";
        readonly githubLogin: string;
        readonly githubUserId: number;
        readonly scopes: readonly string[];
        readonly updatedAt: string;
        readonly lastValidatedAt?: string | undefined;
      }
    | {
        readonly state: "revoked";
        readonly githubLogin: string;
        readonly githubUserId: number;
        readonly revokedAt: string;
      }
    | {
        readonly state: "unbound";
      }
    | {
        readonly state: "missing_initiator";
      };
  readonly defaultAccount:
    | {
        readonly available: true;
        readonly githubLogin: string;
      }
    | {
        readonly available: false;
      };
}

interface StoredDeviceAuthorization {
  readonly id: string;
  readonly slackUserId: string;
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string | undefined;
  readonly expiresAt: number;
  intervalSeconds: number;
}

export class GitHubPrIdentityService {
  readonly #rootDir: string;
  readonly #bindingsDir: string;
  readonly #defaultGitHubLogin: string | undefined;
  readonly #defaultGitHubToken: string | undefined;
  readonly #githubOAuthClientId: string | undefined;
  readonly #githubOAuthBaseUrl: string;
  readonly #githubApiBaseUrl: string;
  readonly #githubOAuthScopes: readonly string[];
  readonly #bindings = new Map<string, GitHubPrBindingRecord>();
  readonly #deviceAuthorizations = new Map<string, StoredDeviceAuthorization>();

  constructor(options: {
    readonly stateDir: string;
    readonly defaultGitHubLogin?: string | undefined;
    readonly defaultGitHubToken?: string | undefined;
    readonly githubOAuthClientId?: string | undefined;
    readonly githubOAuthBaseUrl?: string | undefined;
    readonly githubApiBaseUrl?: string | undefined;
    readonly githubOAuthScopes?: readonly string[] | undefined;
  }) {
    this.#rootDir = path.join(options.stateDir, "github-pr-identities");
    this.#bindingsDir = path.join(this.#rootDir, "bindings");
    this.#defaultGitHubLogin = normalizeString(options.defaultGitHubLogin);
    this.#defaultGitHubToken = normalizeString(options.defaultGitHubToken);
    this.#githubOAuthClientId = normalizeString(options.githubOAuthClientId);
    this.#githubOAuthBaseUrl = normalizeString(options.githubOAuthBaseUrl) ?? "https://github.com/login/oauth";
    this.#githubApiBaseUrl = normalizeString(options.githubApiBaseUrl) ?? "https://api.github.com";
    this.#githubOAuthScopes = options.githubOAuthScopes?.length ? options.githubOAuthScopes : ["repo", "read:user"];
  }

  async load(): Promise<void> {
    await ensureDir(this.#bindingsDir);
    this.#bindings.clear();

    const entries = await fs.readdir(this.#bindingsDir, { withFileTypes: true }).catch((error: unknown) => {
      if (isNodeErrno(error, "ENOENT")) {
        return [];
      }
      throw error;
    });

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const filePath = path.join(this.#bindingsDir, entry.name);
      const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
      const record = normalizeBinding(raw);
      if (record) {
        this.#bindings.set(record.slackUserId, record);
      }
    }
  }

  async upsertBinding(options: {
    readonly slackUserId: string;
    readonly githubLogin: string;
    readonly githubUserId: number;
    readonly token: string;
    readonly scopes: readonly string[];
    readonly lastValidatedAt?: string | undefined;
    readonly revokedAt?: string | undefined;
  }): Promise<GitHubPrBindingRecord> {
    const slackUserId = requiredString(options.slackUserId, "slackUserId");
    const githubLogin = requiredString(options.githubLogin, "githubLogin");
    const token = requiredString(options.token, "token");
    if (!Number.isInteger(options.githubUserId) || options.githubUserId <= 0) {
      throw new Error("githubUserId must be a positive integer.");
    }

    const now = new Date().toISOString();
    const existing = this.#bindings.get(slackUserId);
    const record: GitHubPrBindingRecord = {
      slackUserId,
      githubLogin,
      githubUserId: options.githubUserId,
      token,
      scopes: [...new Set(options.scopes.map((scope) => scope.trim()).filter(Boolean))],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(options.lastValidatedAt ? { lastValidatedAt: options.lastValidatedAt } : {}),
      ...(options.revokedAt ? { revokedAt: options.revokedAt } : {})
    };

    await ensureDir(this.#bindingsDir);
    await fs.writeFile(this.#bindingPath(slackUserId), `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600
    });
    this.#bindings.set(slackUserId, record);
    return record;
  }

  async getBinding(slackUserId: string): Promise<GitHubPrBindingRecord | undefined> {
    await this.load();
    return this.#bindings.get(slackUserId);
  }

  listBindings(): readonly GitHubPrBindingRecord[] {
    return [...this.#bindings.values()].sort((left, right) => left.slackUserId.localeCompare(right.slackUserId));
  }

  getSessionIdentityStatus(session: SlackSessionRecord): GitHubPrIdentityStatus {
    const initiatorUserId = normalizeString(session.initiatorUserId);
    const defaultAccount = this.#defaultGitHubLogin && this.#defaultGitHubToken
      ? {
          available: true as const,
          githubLogin: this.#defaultGitHubLogin
        }
      : {
          available: false as const
        };

    if (!initiatorUserId) {
      return {
        defaultAccount,
        binding: {
          state: "missing_initiator"
        }
      };
    }

    const binding = this.#bindings.get(initiatorUserId);
    if (!binding) {
      return {
        initiatorUserId,
        defaultAccount,
        binding: {
          state: "unbound"
        }
      };
    }

    if (binding.revokedAt) {
      return {
        initiatorUserId,
        defaultAccount,
        binding: {
          state: "revoked",
          githubLogin: binding.githubLogin,
          githubUserId: binding.githubUserId,
          revokedAt: binding.revokedAt
        }
      };
    }

    return {
      initiatorUserId,
      defaultAccount,
      binding: {
        state: "bound",
        githubLogin: binding.githubLogin,
        githubUserId: binding.githubUserId,
        scopes: binding.scopes,
        updatedAt: binding.updatedAt,
        ...(binding.lastValidatedAt ? { lastValidatedAt: binding.lastValidatedAt } : {})
      }
    };
  }

  async resolveTokenForSession(options: {
    readonly session: SlackSessionRecord;
    readonly command: readonly string[];
  }): Promise<GitHubPrTokenResolution> {
    await this.load();
    const initiatorUserId = normalizeString(options.session.initiatorUserId);
    if (!initiatorUserId) {
      return this.#resolveDefault("missing_initiator");
    }

    const binding = this.#bindings.get(initiatorUserId);
    if (!binding) {
      return this.#resolveDefault("initiator_unbound", initiatorUserId);
    }

    if (binding.revokedAt) {
      return {
        ok: false,
        mode: "blocked",
        reason: "initiator_token_invalid",
        slackUserId: initiatorUserId,
        githubLogin: binding.githubLogin,
        message: `GitHub token for ${binding.githubLogin} is invalid. Open the session page and rebind GitHub before running gh ${options.command.join(" ")}.`
      };
    }

    return {
      ok: true,
      mode: "initiator",
      slackUserId: initiatorUserId,
      githubLogin: binding.githubLogin,
      token: binding.token
    };
  }

  async startDeviceAuthorization(options: {
    readonly slackUserId: string;
  }): Promise<{
    readonly id: string;
    readonly slackUserId: string;
    readonly userCode: string;
    readonly verificationUri: string;
    readonly verificationUriComplete?: string | undefined;
    readonly expiresAt: string;
    readonly intervalSeconds: number;
  }> {
    const slackUserId = requiredString(options.slackUserId, "slackUserId");
    if (!this.#githubOAuthClientId) {
      throw new Error("GitHub OAuth client id is not configured.");
    }

    const body = new URLSearchParams({
      client_id: this.#githubOAuthClientId,
      scope: this.#githubOAuthScopes.join(" ")
    });
    const response = await fetch(joinOAuthUrl(this.#githubOAuthBaseUrl, "../device/code"), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded"
      },
      body
    });
    const raw = await readJsonResponse(response);
    const parsed = parseDeviceCodeResponse(raw);
    const id = randomUUID();
    const expiresAt = Date.now() + parsed.expiresInSeconds * 1000;
    this.#deviceAuthorizations.set(id, {
      id,
      slackUserId,
      deviceCode: parsed.deviceCode,
      userCode: parsed.userCode,
      verificationUri: parsed.verificationUri,
      verificationUriComplete: parsed.verificationUriComplete,
      expiresAt,
      intervalSeconds: parsed.intervalSeconds
    });

    return {
      id,
      slackUserId,
      userCode: parsed.userCode,
      verificationUri: parsed.verificationUri,
      ...(parsed.verificationUriComplete ? { verificationUriComplete: parsed.verificationUriComplete } : {}),
      expiresAt: new Date(expiresAt).toISOString(),
      intervalSeconds: parsed.intervalSeconds
    };
  }

  async pollDeviceAuthorization(id: string): Promise<
    | {
        readonly status: "pending";
        readonly retryAfterSeconds: number;
      }
    | {
        readonly status: "expired";
      }
    | {
        readonly status: "failed";
        readonly error: string;
      }
    | {
        readonly status: "completed";
        readonly binding: GitHubPrBindingRecord;
      }
  > {
    if (!this.#githubOAuthClientId) {
      throw new Error("GitHub OAuth client id is not configured.");
    }

    const pending = this.#deviceAuthorizations.get(id);
    if (!pending) {
      return {
        status: "failed",
        error: "unknown_device_authorization"
      };
    }
    if (Date.now() >= pending.expiresAt) {
      this.#deviceAuthorizations.delete(id);
      return {
        status: "expired"
      };
    }

    const body = new URLSearchParams({
      client_id: this.#githubOAuthClientId,
      device_code: pending.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code"
    });
    const response = await fetch(joinOAuthUrl(this.#githubOAuthBaseUrl, "access_token"), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded"
      },
      body
    });
    const raw = await readJsonResponse(response);
    if (isRecord(raw) && typeof raw.error === "string") {
      if (raw.error === "authorization_pending") {
        return {
          status: "pending",
          retryAfterSeconds: pending.intervalSeconds
        };
      }
      if (raw.error === "slow_down") {
        pending.intervalSeconds += 5;
        return {
          status: "pending",
          retryAfterSeconds: pending.intervalSeconds
        };
      }
      return {
        status: "failed",
        error: raw.error
      };
    }

    const token = isRecord(raw) && typeof raw.access_token === "string" ? raw.access_token.trim() : "";
    if (!token) {
      return {
        status: "failed",
        error: "missing_access_token"
      };
    }

    const user = await this.#fetchGitHubUser(token);
    const scopes = parseScopes(isRecord(raw) && typeof raw.scope === "string" ? raw.scope : "");
    const validatedAt = new Date().toISOString();
    const binding = await this.upsertBinding({
      slackUserId: pending.slackUserId,
      githubLogin: user.login,
      githubUserId: user.id,
      token,
      scopes,
      lastValidatedAt: validatedAt
    });
    this.#deviceAuthorizations.delete(id);
    return {
      status: "completed",
      binding
    };
  }

  async #fetchGitHubUser(token: string): Promise<{
    readonly id: number;
    readonly login: string;
  }> {
    const response = await fetch(joinUrl(this.#githubApiBaseUrl, "/user"), {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "slack-codex-broker"
      }
    });
    const raw = await readJsonResponse(response);
    if (!isRecord(raw) || typeof raw.login !== "string" || typeof raw.id !== "number" || !Number.isInteger(raw.id)) {
      throw new Error("GitHub user response did not include login and id.");
    }
    return {
      login: raw.login,
      id: raw.id
    };
  }

  #resolveDefault(
    reason: "missing_initiator" | "initiator_unbound",
    slackUserId?: string | undefined
  ): GitHubPrTokenResolution {
    if (this.#defaultGitHubLogin && this.#defaultGitHubToken) {
      return {
        ok: true,
        mode: "default",
        githubLogin: this.#defaultGitHubLogin,
        token: this.#defaultGitHubToken,
        reason
      };
    }

    return {
      ok: false,
      mode: "blocked",
      reason: this.#defaultGitHubLogin || this.#defaultGitHubToken ? reason : "default_account_unavailable",
      ...(slackUserId ? { slackUserId } : {}),
      message: "No GitHub account is bound to this Slack session initiator, and no default GitHub account is configured."
    };
  }

  #bindingPath(slackUserId: string): string {
    return path.join(this.#bindingsDir, `${encodePathPart(slackUserId)}.json`);
  }
}

function parseDeviceCodeResponse(raw: unknown): {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string | undefined;
  readonly expiresInSeconds: number;
  readonly intervalSeconds: number;
} {
  if (!isRecord(raw)) {
    throw new Error("GitHub device code response must be an object.");
  }

  const deviceCode = requiredString(raw.device_code, "device_code");
  const userCode = requiredString(raw.user_code, "user_code");
  const verificationUri = requiredString(raw.verification_uri, "verification_uri");
  const expiresInSeconds = readPositiveNumber(raw.expires_in, "expires_in");
  const intervalSeconds = typeof raw.interval === "number" && raw.interval > 0 ? raw.interval : 5;
  const verificationUriComplete = normalizeString(raw.verification_uri_complete);
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(verificationUriComplete ? { verificationUriComplete } : {}),
    expiresInSeconds,
    intervalSeconds
  };
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = isRecord(parsed) && typeof parsed.error === "string" ? parsed.error : response.statusText;
    throw new Error(`GitHub request failed (${response.status}): ${error}`);
  }
  return parsed;
}

function normalizeBinding(raw: unknown): GitHubPrBindingRecord | null {
  if (!isRecord(raw)) {
    return null;
  }

  const slackUserId = normalizeString(raw.slackUserId);
  const githubLogin = normalizeString(raw.githubLogin);
  const githubUserId = typeof raw.githubUserId === "number" && Number.isInteger(raw.githubUserId)
    ? raw.githubUserId
    : 0;
  const token = normalizeString(raw.token);
  const createdAt = normalizeString(raw.createdAt);
  const updatedAt = normalizeString(raw.updatedAt);
  if (!slackUserId || !githubLogin || githubUserId <= 0 || !token || !createdAt || !updatedAt) {
    return null;
  }

  const scopes = Array.isArray(raw.scopes)
    ? raw.scopes.map((entry) => normalizeString(entry)).filter((entry): entry is string => Boolean(entry))
    : [];
  const lastValidatedAt = normalizeString(raw.lastValidatedAt);
  const revokedAt = normalizeString(raw.revokedAt);
  return {
    slackUserId,
    githubLogin,
    githubUserId,
    token,
    scopes,
    createdAt,
    updatedAt,
    ...(lastValidatedAt ? { lastValidatedAt } : {}),
    ...(revokedAt ? { revokedAt } : {})
  };
}

function joinUrl(baseUrl: string, pathName: string): string {
  return new URL(pathName.replace(/^\/+/, ""), `${baseUrl.replace(/\/+$/, "")}/`).toString();
}

function joinOAuthUrl(baseUrl: string, pathName: string): string {
  return new URL(pathName, `${baseUrl.replace(/\/+$/, "")}/`).toString();
}

function parseScopes(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function requiredString(value: unknown, name: string): string {
  const normalized = normalizeString(value);
  if (!normalized) {
    throw new Error(`${name} is required.`);
  }
  return normalized;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readPositiveNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function encodePathPart(value: string): string {
  return encodeURIComponent(value).replace(/%/g, "_");
}
