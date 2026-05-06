import fs from "node:fs/promises";
import path from "node:path";

import type { AppConfig } from "../config.js";
import { ensureDir, fileExists } from "../utils/fs.js";

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

interface RefreshResponsePayload {
  readonly id_token?: string | undefined;
  readonly access_token?: string | undefined;
  readonly refresh_token?: string | undefined;
}

interface AuthPoolState {
  readonly version: 1;
  readonly assignments?: Record<string, string> | undefined;
  readonly profiles?: Record<string, AuthPoolProfileState> | undefined;
}

interface AuthPoolProfileState {
  readonly weight?: number | undefined;
  readonly cooldownUntil?: string | undefined;
  readonly lastError?: string | undefined;
  readonly updatedAt?: string | undefined;
}

interface ProfileFile {
  readonly name: string;
  readonly path: string;
}

export interface AuthPoolTokenSet {
  readonly profileName: string;
  readonly accessToken: string;
  readonly chatgptAccountId: string;
  readonly chatgptPlanType: string | null;
}

export interface AuthPoolLease {
  readonly tokens: AuthPoolTokenSet;
  readonly release: () => void;
}

type FetchLike = typeof fetch;

const TOKEN_REFRESH_URL = "https://auth.openai.com/oauth/token";
const TOKEN_REFRESH_URL_OVERRIDE_ENV = "CODEX_REFRESH_TOKEN_URL_OVERRIDE";
const CODEX_CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_LEEWAY_MS = 5 * 60 * 1000;

export class AuthPoolService {
  readonly #dataRoot: string;
  readonly #profilesRoot: string;
  readonly #statePath: string;
  readonly #refreshInflight = new Map<string, Promise<AuthPoolTokenSet>>();
  readonly #runtimeInflight = new Map<string, number>();
  #stateWriteQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      readonly config: AppConfig;
      readonly fetch?: FetchLike | undefined;
    }
  ) {
    this.#dataRoot = path.dirname(options.config.stateDir);
    this.#profilesRoot = path.join(this.#dataRoot, "auth-profiles", "docker", "profiles");
    this.#statePath = path.join(options.config.stateDir, "auth-pool.json");
  }

  get enabled(): boolean {
    return this.options.config.authPoolLbMode === "on" || this.options.config.authPoolLbMode === "shadow";
  }

  get mode(): AppConfig["authPoolLbMode"] {
    return this.options.config.authPoolLbMode;
  }

  async leaseForSession(sessionKey: string): Promise<AuthPoolLease | null> {
    if (this.mode === "off") {
      return null;
    }

    const profile = await this.#selectProfile(sessionKey);
    if (!profile) {
      return null;
    }

    const tokens = await this.#refreshProfile(profile.name, {
      force: false
    });
    this.#incrementInflight(profile.name);
    let released = false;
    return {
      tokens,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.#decrementInflight(profile.name);
      }
    };
  }

  async refreshForPreviousAccount(previousAccountId: string | null | undefined): Promise<AuthPoolTokenSet> {
    const profiles = await this.#listProfiles();
    if (profiles.length === 0) {
      throw new Error("auth_pool_has_no_profiles");
    }

    if (previousAccountId) {
      for (const profile of profiles) {
        const auth = await this.#readAuth(profile.path).catch(() => null);
        const accountId = auth?.tokens?.account_id?.trim();
        if (accountId === previousAccountId) {
          return await this.#refreshProfile(profile.name, {
            force: true
          });
        }
      }
    }

    const profile = await this.#selectProfile(previousAccountId ?? "external-refresh");
    if (!profile) {
      throw new Error("auth_pool_has_no_usable_profile");
    }

    return await this.#refreshProfile(profile.name, {
      force: true
    });
  }

  async markProfileFailure(profileName: string, error: string): Promise<void> {
    const cooldownUntil = new Date(Date.now() + 60_000).toISOString();
    await this.#updateState((state) => ({
      ...state,
      profiles: {
        ...state.profiles,
        [profileName]: {
          ...state.profiles?.[profileName],
          cooldownUntil,
          lastError: error,
          updatedAt: new Date().toISOString()
        }
      }
    }));
  }

  async #selectProfile(sessionKey: string): Promise<ProfileFile | null> {
    const profiles = await this.#listProfiles();
    if (profiles.length === 0) {
      return null;
    }

    const state = await this.#readState();
    const profileByName = new Map(profiles.map((profile) => [profile.name, profile]));
    const assignedName = state.assignments?.[sessionKey];
    if (assignedName) {
      const assigned = profileByName.get(assignedName);
      if (assigned && this.#isProfileAvailable(assigned.name, state)) {
        return assigned;
      }
    }

    const available = profiles.filter((profile) => this.#isProfileAvailable(profile.name, state));
    const candidates = available.length > 0 ? available : profiles;
    const selected = candidates
      .map((profile) => ({
        profile,
        score: this.#scoreProfile(profile.name, state, sessionKey)
      }))
      .sort((left, right) =>
        right.score - left.score ||
        stableHash(`${sessionKey}:${left.profile.name}`) - stableHash(`${sessionKey}:${right.profile.name}`)
      )[0]?.profile ?? null;

    if (selected) {
      await this.#updateState((current) => ({
        ...current,
        assignments: {
          ...current.assignments,
          [sessionKey]: selected.name
        }
      }));
    }

    return selected;
  }

  #isProfileAvailable(profileName: string, state: AuthPoolState): boolean {
    const cooldownUntil = state.profiles?.[profileName]?.cooldownUntil;
    if (!cooldownUntil) {
      return true;
    }

    return Date.parse(cooldownUntil) <= Date.now();
  }

  #scoreProfile(profileName: string, state: AuthPoolState, sessionKey: string): number {
    const profileState = state.profiles?.[profileName];
    const weight = profileState?.weight && profileState.weight > 0 ? profileState.weight : 1;
    const inflight = this.#runtimeInflight.get(profileName) ?? 0;
    const jitter = (stableHash(`${sessionKey}:${profileName}`) % 1_000) / 1_000_000;
    return weight - inflight * 2 + jitter;
  }

  async #refreshProfile(
    profileName: string,
    options: {
      readonly force: boolean;
    }
  ): Promise<AuthPoolTokenSet> {
    const inflight = this.#refreshInflight.get(profileName);
    if (inflight) {
      return await inflight;
    }

    const promise = this.#refreshProfileImpl(profileName, options);
    this.#refreshInflight.set(profileName, promise);
    try {
      return await promise;
    } finally {
      this.#refreshInflight.delete(profileName);
    }
  }

  async #refreshProfileImpl(
    profileName: string,
    options: {
      readonly force: boolean;
    }
  ): Promise<AuthPoolTokenSet> {
    const profilePath = path.join(this.#profilesRoot, `${profileName}.json`);
    let auth = await this.#readAuth(profilePath);
    if (!options.force && auth.tokens?.access_token && !isAccessTokenNearExpiry(auth.tokens.access_token)) {
      return tokensFromAuth(profileName, auth);
    }

    const refreshToken = auth.tokens?.refresh_token?.trim();
    if (!refreshToken) {
      throw new Error(`Auth profile ${profileName} is missing refresh_token`);
    }

    try {
      const refreshResponse = await this.#requestTokenRefresh(refreshToken);
      auth = {
        ...auth,
        tokens: {
          ...auth.tokens,
          ...(refreshResponse.id_token ? { id_token: refreshResponse.id_token } : {}),
          ...(refreshResponse.access_token ? { access_token: refreshResponse.access_token } : {}),
          ...(refreshResponse.refresh_token ? { refresh_token: refreshResponse.refresh_token } : {})
        },
        last_refresh: new Date().toISOString()
      };
      await writeAuth(profilePath, auth);
      await this.#clearProfileFailure(profileName);
      return tokensFromAuth(profileName, auth);
    } catch (error) {
      await this.markProfileFailure(profileName, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async #requestTokenRefresh(refreshToken: string): Promise<RefreshResponsePayload> {
    const fetchImpl = this.options.fetch ?? fetch;
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

  async #clearProfileFailure(profileName: string): Promise<void> {
    await this.#updateState((state) => ({
      ...state,
      profiles: {
        ...state.profiles,
        [profileName]: {
          ...state.profiles?.[profileName],
          cooldownUntil: undefined,
          lastError: undefined,
          updatedAt: new Date().toISOString()
        }
      }
    }));
  }

  async #listProfiles(): Promise<ProfileFile[]> {
    if (!(await fileExists(this.#profilesRoot))) {
      return [];
    }

    const entries = await fs.readdir(this.#profilesRoot, { withFileTypes: true });
    const profiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => ({
        name: path.basename(entry.name, ".json"),
        path: path.join(this.#profilesRoot, entry.name)
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    return profiles;
  }

  async #readAuth(authJsonPath: string): Promise<StoredAuthJson> {
    const raw = await fs.readFile(authJsonPath, "utf8");
    return JSON.parse(raw) as StoredAuthJson;
  }

  async #readState(): Promise<AuthPoolState> {
    try {
      const raw = await fs.readFile(this.#statePath, "utf8");
      return normalizeState(JSON.parse(raw) as Partial<AuthPoolState>);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return {
          version: 1,
          assignments: {},
          profiles: {}
        };
      }

      throw error;
    }
  }

  async #updateState(update: (state: AuthPoolState) => AuthPoolState): Promise<void> {
    const run = this.#stateWriteQueue
      .catch(() => {})
      .then(async () => {
        const state = await this.#readState();
        const next = normalizeState(update(state));
        await ensureDir(path.dirname(this.#statePath));
        await fs.writeFile(this.#statePath, `${JSON.stringify(next, null, 2)}\n`, {
          mode: 0o600
        });
      });
    this.#stateWriteQueue = run;
    await run;
  }

  #incrementInflight(profileName: string): void {
    this.#runtimeInflight.set(profileName, (this.#runtimeInflight.get(profileName) ?? 0) + 1);
  }

  #decrementInflight(profileName: string): void {
    const next = Math.max(0, (this.#runtimeInflight.get(profileName) ?? 0) - 1);
    if (next === 0) {
      this.#runtimeInflight.delete(profileName);
      return;
    }
    this.#runtimeInflight.set(profileName, next);
  }
}

function normalizeState(state: Partial<AuthPoolState>): AuthPoolState {
  return {
    version: 1,
    assignments: state.assignments ?? {},
    profiles: state.profiles ?? {}
  };
}

function tokensFromAuth(profileName: string, auth: StoredAuthJson): AuthPoolTokenSet {
  const accessToken = auth.tokens?.access_token?.trim();
  if (!accessToken) {
    throw new Error(`Auth profile ${profileName} is missing access_token`);
  }

  const chatgptAccountId = auth.tokens?.account_id?.trim();
  if (!chatgptAccountId) {
    throw new Error(`Auth profile ${profileName} is missing account_id`);
  }

  return {
    profileName,
    accessToken,
    chatgptAccountId,
    chatgptPlanType: parseChatGptPlanType(auth.tokens?.id_token) ?? parseChatGptPlanType(accessToken)
  };
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

function parseChatGptPlanType(jwt: string | undefined): string | null {
  const payload = jwt?.split(".")[1];
  if (!payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      readonly "https://api.openai.com/auth"?: {
        readonly chatgpt_plan_type?: unknown;
      };
      readonly chatgpt_plan_type?: unknown;
    };
    const planType =
      parsed["https://api.openai.com/auth"]?.chatgpt_plan_type ??
      parsed.chatgpt_plan_type;
    return typeof planType === "string" && planType.trim() ? planType.trim() : null;
  } catch {
    return null;
  }
}

function stableHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

async function writeAuth(authJsonPath: string, auth: StoredAuthJson): Promise<void> {
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
