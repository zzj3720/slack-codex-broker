import fs from "node:fs/promises";
import path from "node:path";

import type { AppServerRateLimitsResponse, AppServerRateLimitSnapshot } from "./app-server-client.js";

interface StoredAuthTokens {
  readonly id_token?: string | undefined;
  readonly access_token?: string | undefined;
  readonly refresh_token?: string | undefined;
  readonly account_id?: string | undefined;
}

interface StoredAuthJson {
  readonly auth_mode?: string | undefined;
  readonly OPENAI_API_KEY?: string | null | undefined;
  readonly tokens?: StoredAuthTokens | undefined;
  readonly last_refresh?: string | null | undefined;
}

interface UsageWindowPayload {
  readonly used_percent?: number | null;
  readonly limit_window_seconds?: number | null;
  readonly reset_at?: number | null;
}

interface UsageLimitPayload {
  readonly primary_window?: UsageWindowPayload | null;
  readonly secondary_window?: UsageWindowPayload | null;
}

interface UsageAdditionalLimitPayload {
  readonly limit_name?: string | null;
  readonly metered_feature?: string | null;
  readonly rate_limit?: UsageLimitPayload | null;
}

interface UsagePayload {
  readonly account_id?: string | null;
  readonly email?: string | null;
  readonly plan_type?: string | null;
  readonly rate_limit?: UsageLimitPayload | null;
  readonly code_review_rate_limit?: UsageLimitPayload | null;
  readonly additional_rate_limits?: UsageAdditionalLimitPayload[] | null;
}

export interface ChatGptUsageSnapshot {
  readonly account: {
    readonly email: string | null;
    readonly type: "chatgpt";
    readonly planType: string | null;
  };
  readonly rateLimits: AppServerRateLimitsResponse;
}

interface RefreshResponsePayload {
  readonly id_token?: string | undefined;
  readonly access_token?: string | undefined;
  readonly refresh_token?: string | undefined;
}

type FetchLike = typeof fetch;

const CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const TOKEN_REFRESH_URL = "https://auth.openai.com/oauth/token";
const TOKEN_REFRESH_URL_OVERRIDE_ENV = "CODEX_REFRESH_TOKEN_URL_OVERRIDE";
const CODEX_CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_LEEWAY_MS = 5 * 60 * 1000;

const refreshInflight = new Map<string, Promise<StoredAuthJson>>();

export async function readChatGptUsageSnapshot(authJsonPath: string): Promise<ChatGptUsageSnapshot> {
  let auth = await refreshAuthIfNeeded(authJsonPath, await readStoredAuthJson(authJsonPath));
  let response = await fetchUsage(auth);

  if (response.status === 401 && auth.tokens?.refresh_token) {
    auth = await refreshAuthJson(authJsonPath, auth);
    response = await fetchUsage(auth);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`ChatGPT usage API failed (${response.status}): ${body || response.statusText}`);
  }

  const payload = (await response.json()) as UsagePayload;
  const primarySnapshot = normalizeRateLimitSnapshot("codex", "Codex", payload.rate_limit, payload.plan_type ?? null);
  const byLimitId: Record<string, AppServerRateLimitSnapshot> = {
    codex: primarySnapshot
  };

  if (payload.code_review_rate_limit) {
    byLimitId.code_review = normalizeRateLimitSnapshot(
      "code_review",
      "Code Review",
      payload.code_review_rate_limit,
      payload.plan_type ?? null
    );
  }

  for (const additionalLimit of payload.additional_rate_limits ?? []) {
    if (!additionalLimit.rate_limit) {
      continue;
    }

    const limitId = additionalLimit.metered_feature ?? additionalLimit.limit_name ?? "additional_limit";
    byLimitId[limitId] = normalizeRateLimitSnapshot(
      limitId,
      additionalLimit.limit_name ?? limitId,
      additionalLimit.rate_limit,
      payload.plan_type ?? null
    );
  }

  return {
    account: {
      email: payload.email ?? null,
      type: "chatgpt",
      planType: payload.plan_type ?? null
    },
    rateLimits: {
      rateLimits: primarySnapshot,
      rateLimitsByLimitId: byLimitId
    }
  };
}

async function fetchUsage(auth: StoredAuthJson, fetchImpl: FetchLike = fetch): Promise<Response> {
  const accessToken = auth.tokens?.access_token?.trim();
  const accountId = auth.tokens?.account_id?.trim();

  if (!accessToken) {
    throw new Error("Missing access_token in auth.json");
  }

  if (!accountId) {
    throw new Error("Missing account_id in auth.json");
  }

  return await fetchImpl(CHATGPT_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "ChatGPT-Account-Id": accountId,
      "User-Agent": "codex-cli"
    },
    signal: AbortSignal.timeout(20_000)
  });
}

async function refreshAuthIfNeeded(authJsonPath: string, auth: StoredAuthJson): Promise<StoredAuthJson> {
  if (!auth.tokens?.refresh_token) {
    return auth;
  }

  const accessToken = auth.tokens.access_token;
  if (accessToken && !isAccessTokenNearExpiry(accessToken)) {
    return auth;
  }

  return await refreshAuthJson(authJsonPath, auth);
}

async function refreshAuthJson(
  authJsonPath: string,
  authBeforeRefresh: StoredAuthJson,
  fetchImpl: FetchLike = fetch
): Promise<StoredAuthJson> {
  const writePath = await resolveWritableAuthPath(authJsonPath);
  const inflight = refreshInflight.get(writePath);
  if (inflight) {
    return await inflight;
  }

  const refreshPromise = (async () => {
    const latest = await readStoredAuthJson(writePath);
    if (
      latest.tokens?.access_token &&
      latest.tokens.access_token !== authBeforeRefresh.tokens?.access_token &&
      !isAccessTokenNearExpiry(latest.tokens.access_token)
    ) {
      return latest;
    }

    const refreshToken = latest.tokens?.refresh_token?.trim();
    if (!refreshToken) {
      throw new Error("Missing refresh_token in auth.json");
    }

    const refreshResponse = await requestTokenRefresh(refreshToken, fetchImpl);
    const nextAuth: StoredAuthJson = {
      ...latest,
      tokens: {
        ...latest.tokens,
        ...(refreshResponse.id_token ? { id_token: refreshResponse.id_token } : {}),
        ...(refreshResponse.access_token ? { access_token: refreshResponse.access_token } : {}),
        ...(refreshResponse.refresh_token ? { refresh_token: refreshResponse.refresh_token } : {})
      },
      last_refresh: new Date().toISOString()
    };
    await writeStoredAuthJson(writePath, nextAuth);
    return nextAuth;
  })();
  refreshInflight.set(writePath, refreshPromise);

  try {
    return await refreshPromise;
  } finally {
    refreshInflight.delete(writePath);
  }
}

async function requestTokenRefresh(refreshToken: string, fetchImpl: FetchLike): Promise<RefreshResponsePayload> {
  const response = await fetchImpl(process.env[TOKEN_REFRESH_URL_OVERRIDE_ENV] ?? TOKEN_REFRESH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      client_id: CODEX_CHATGPT_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken
    }),
    signal: AbortSignal.timeout(20_000)
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`ChatGPT token refresh failed (${response.status}): ${body || response.statusText}`);
  }

  return (await response.json()) as RefreshResponsePayload;
}

function isAccessTokenNearExpiry(accessToken: string): boolean {
  const expiresAt = parseJwtExpiration(accessToken);
  return typeof expiresAt === "number" && expiresAt <= Date.now() + REFRESH_LEEWAY_MS;
}

function parseJwtExpiration(jwt: string): number | null {
  const payload = jwt.split(".")[1];
  if (!payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      readonly exp?: unknown;
    };
    return typeof parsed.exp === "number" ? parsed.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function resolveWritableAuthPath(authJsonPath: string): Promise<string> {
  try {
    return await fs.realpath(authJsonPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return authJsonPath;
    }

    throw error;
  }
}

async function readStoredAuthJson(authJsonPath: string): Promise<StoredAuthJson> {
  const raw = await fs.readFile(authJsonPath, "utf8");
  return JSON.parse(raw) as StoredAuthJson;
}

async function writeStoredAuthJson(authJsonPath: string, auth: StoredAuthJson): Promise<void> {
  const stat = await fs.stat(authJsonPath).catch(() => null);
  const tempPath = path.join(
    path.dirname(authJsonPath),
    `.${path.basename(authJsonPath)}.${process.pid}.${Date.now()}.tmp`
  );
  await fs.writeFile(tempPath, `${JSON.stringify(auth, null, 2)}\n`, {
    mode: stat ? stat.mode & 0o777 : 0o600
  });

  await fs.rename(tempPath, authJsonPath);
}

function normalizeRateLimitSnapshot(
  limitId: string,
  limitName: string,
  rateLimit: UsageLimitPayload | null | undefined,
  planType: string | null
): AppServerRateLimitSnapshot {
  return {
    limitId,
    limitName,
    primary: normalizeWindow(rateLimit?.primary_window),
    secondary: normalizeWindow(rateLimit?.secondary_window),
    credits: null,
    planType
  };
}

function normalizeWindow(window: UsageWindowPayload | null | undefined) {
  if (!window) {
    return null;
  }

  return {
    usedPercent: Number(window.used_percent ?? 0),
    windowDurationMins:
      typeof window.limit_window_seconds === "number" ? Math.round(window.limit_window_seconds / 60) : null,
    resetsAt: typeof window.reset_at === "number" ? window.reset_at : null
  };
}
