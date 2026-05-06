import path from "node:path";

export interface AppConfig {
  readonly serviceRoot?: string | undefined;
  readonly slackAppToken: string;
  readonly slackBotToken: string;
  readonly slackApiBaseUrl: string;
  readonly slackSocketOpenUrl: string;
  readonly slackInitialThreadHistoryCount: number;
  readonly slackHistoryApiMaxLimit: number;
  readonly slackActiveTurnReconcileIntervalMs: number;
  readonly slackMissedThreadRecoveryIntervalMs: number;
  readonly slackStaleIdleRuntimeResetAfterMs: number;
  readonly slackProgressReminderAfterMs: number;
  readonly slackProgressReminderRepeatMs: number;
  readonly stateDir: string;
  readonly jobsRoot: string;
  readonly sessionsRoot: string;
  readonly reposRoot: string;
  readonly codexHome: string;
  readonly codexHostHomePath?: string | undefined;
  readonly codexAuthJsonPath?: string | undefined;
  readonly geminiHostHomePath?: string | undefined;
  readonly geminiHttpProxy?: string | undefined;
  readonly geminiHttpsProxy?: string | undefined;
  readonly geminiAllProxy?: string | undefined;
  readonly isolatedMcpServers: string[];
  readonly codexDisabledMcpServers: string[];
  readonly codexAppServerUrl?: string | undefined;
  readonly codexAppServerPort: number;
  readonly codexOpenAiApiKey?: string | undefined;
  readonly tempadLinkServiceUrl?: string | undefined;
  readonly port: number;
  readonly workerPort: number;
  readonly workerBindHost: string;
  readonly workerBaseUrl: string;
  readonly brokerHttpBaseUrl: string;
  readonly serviceName: string;
  readonly brokerAdminToken?: string | undefined;
  readonly adminLaunchdLabel?: string | undefined;
  readonly workerLaunchdLabel?: string | undefined;
  readonly releaseRepoUrl?: string | undefined;
  readonly releaseRepoRoot?: string | undefined;
  readonly releasesRoot?: string | undefined;
  readonly currentReleasePath?: string | undefined;
  readonly previousReleasePath?: string | undefined;
  readonly failedReleasePath?: string | undefined;
  readonly workerPlistPath?: string | undefined;
  readonly logDir: string;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly logRawSlackEvents: boolean;
  readonly logRawCodexRpc: boolean;
  readonly logRawHttpRequests: boolean;
  readonly diskCleanupEnabled: boolean;
  readonly diskCleanupCheckIntervalMs: number;
  readonly diskCleanupMinFreeBytes: number;
  readonly diskCleanupTargetFreeBytes: number;
  readonly diskCleanupInactiveSessionMs: number;
  readonly diskCleanupJobProtectionMs: number;
  readonly diskCleanupOldLogMs: number;
}

const ALL_CODEX_MCP_SERVERS = "*";
const GIB = 1024 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

function getRequired(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function getOptional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value ? value : undefined;
}

function getCsvList(env: NodeJS.ProcessEnv, name: string): string[] {
  const value = env[name];

  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function getNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name];

  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric environment variable: ${name}`);
  }

  return parsed;
}

function getBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = env[name];
  if (!value) {
    return fallback;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new Error(`Invalid boolean environment variable: ${name}`);
}

function getLogLevel(env: NodeJS.ProcessEnv, name: string, fallback: AppConfig["logLevel"]): AppConfig["logLevel"] {
  const value = env[name];
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "error") {
    return normalized;
  }

  throw new Error(`Invalid log level environment variable: ${name}`);
}

export function loadConfig(env = process.env): AppConfig {
  const serviceRoot = env.SERVICE_ROOT ? path.resolve(env.SERVICE_ROOT) : undefined;
  const dataRoot = env.DATA_ROOT ? path.resolve(env.DATA_ROOT) : path.resolve(".data");
  const stateDir = env.STATE_DIR ? path.resolve(env.STATE_DIR) : path.join(dataRoot, "state");
  const jobsRoot = env.JOBS_ROOT ? path.resolve(env.JOBS_ROOT) : path.join(dataRoot, "jobs");
  const sessionsRoot = env.SESSIONS_ROOT ? path.resolve(env.SESSIONS_ROOT) : path.join(dataRoot, "sessions");
  const reposRoot = env.REPOS_ROOT ? path.resolve(env.REPOS_ROOT) : path.join(dataRoot, "repos");
  const codexHome = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(dataRoot, "codex-home");
  const logDir = env.LOG_DIR ? path.resolve(env.LOG_DIR) : path.join(dataRoot, "logs");
  const port = getNumber(env, "PORT", 3000);
  const workerPort = getNumber(env, "WORKER_PORT", port);
  const workerBindHost = env.WORKER_BIND_HOST?.trim() || "127.0.0.1";

  const isolatedMcpServers = getCsvList(env, "ISOLATED_MCP_SERVERS");
  const effectiveIsolatedMcpServers =
    isolatedMcpServers.length > 0 ? isolatedMcpServers : ["linear", "notion"];
  const codexDisabledMcpServers = unique([
    ALL_CODEX_MCP_SERVERS,
    ...getCsvList(env, "CODEX_DISABLED_MCP_SERVERS"),
    ...effectiveIsolatedMcpServers
  ]);

  return {
    serviceRoot,
    slackAppToken: getRequired(env, "SLACK_APP_TOKEN"),
    slackBotToken: getRequired(env, "SLACK_BOT_TOKEN"),
    slackApiBaseUrl: env.SLACK_API_BASE_URL ?? "https://slack.com/api",
    slackSocketOpenUrl: env.SLACK_SOCKET_OPEN_URL ?? "apps.connections.open",
    slackInitialThreadHistoryCount: getNumber(env, "SLACK_INITIAL_THREAD_HISTORY_COUNT", 8),
    slackHistoryApiMaxLimit: getNumber(env, "SLACK_HISTORY_API_MAX_LIMIT", 50),
    slackActiveTurnReconcileIntervalMs: getNumber(env, "SLACK_ACTIVE_TURN_RECONCILE_INTERVAL_MS", 15_000),
    slackMissedThreadRecoveryIntervalMs: getNumber(
      env,
      "SLACK_MISSED_THREAD_RECOVERY_INTERVAL_MS",
      120_000
    ),
    slackStaleIdleRuntimeResetAfterMs: getNumber(
      env,
      "SLACK_STALE_IDLE_RUNTIME_RESET_AFTER_MS",
      120_000
    ),
    slackProgressReminderAfterMs: getNumber(env, "SLACK_PROGRESS_REMINDER_AFTER_MS", 120_000),
    slackProgressReminderRepeatMs: getNumber(env, "SLACK_PROGRESS_REMINDER_REPEAT_MS", 120_000),
    stateDir,
    jobsRoot,
    sessionsRoot,
    reposRoot,
    codexHome,
    codexHostHomePath: getOptional(env, "CODEX_HOST_HOME_PATH"),
    codexAuthJsonPath: getOptional(env, "CODEX_AUTH_JSON_PATH"),
    geminiHostHomePath: getOptional(env, "GEMINI_HOST_HOME_PATH"),
    geminiHttpProxy: getOptional(env, "GEMINI_HTTP_PROXY"),
    geminiHttpsProxy: getOptional(env, "GEMINI_HTTPS_PROXY"),
    geminiAllProxy: getOptional(env, "GEMINI_ALL_PROXY"),
    isolatedMcpServers: effectiveIsolatedMcpServers,
    codexDisabledMcpServers,
    codexAppServerUrl: getOptional(env, "CODEX_APP_SERVER_URL"),
    codexAppServerPort: getNumber(env, "CODEX_APP_SERVER_PORT", 4590),
    codexOpenAiApiKey: getOptional(env, "OPENAI_API_KEY"),
    tempadLinkServiceUrl: getOptional(env, "TEMPAD_LINK_SERVICE_URL"),
    port,
    workerPort,
    workerBindHost,
    workerBaseUrl: env.WORKER_BASE_URL ?? `http://${workerBindHost}:${workerPort}`,
    brokerHttpBaseUrl: env.BROKER_HTTP_BASE_URL ?? `http://127.0.0.1:${port}`,
    serviceName: env.SERVICE_NAME ?? "slack-codex-broker",
    brokerAdminToken: getOptional(env, "BROKER_ADMIN_TOKEN"),
    adminLaunchdLabel: getOptional(env, "ADMIN_LAUNCHD_LABEL"),
    workerLaunchdLabel: getOptional(env, "WORKER_LAUNCHD_LABEL"),
    releaseRepoUrl: getOptional(env, "RELEASE_REPO_URL"),
    releaseRepoRoot: env.RELEASE_REPO_ROOT ? path.resolve(env.RELEASE_REPO_ROOT) : serviceRoot,
    releasesRoot: env.RELEASES_ROOT ? path.resolve(env.RELEASES_ROOT) : serviceRoot ? path.join(serviceRoot, "releases") : undefined,
    currentReleasePath: env.CURRENT_RELEASE_PATH ? path.resolve(env.CURRENT_RELEASE_PATH) : serviceRoot ? path.join(serviceRoot, "current") : undefined,
    previousReleasePath: env.PREVIOUS_RELEASE_PATH ? path.resolve(env.PREVIOUS_RELEASE_PATH) : serviceRoot ? path.join(serviceRoot, "previous") : undefined,
    failedReleasePath: env.FAILED_RELEASE_PATH ? path.resolve(env.FAILED_RELEASE_PATH) : serviceRoot ? path.join(serviceRoot, "failed") : undefined,
    workerPlistPath: env.WORKER_PLIST_PATH ? path.resolve(env.WORKER_PLIST_PATH) : undefined,
    logDir,
    logLevel: getLogLevel(env, "LOG_LEVEL", "info"),
    logRawSlackEvents: getBoolean(env, "LOG_RAW_SLACK_EVENTS", true),
    logRawCodexRpc: getBoolean(env, "LOG_RAW_CODEX_RPC", true),
    logRawHttpRequests: getBoolean(env, "LOG_RAW_HTTP_REQUESTS", true),
    diskCleanupEnabled: getBoolean(env, "DISK_CLEANUP_ENABLED", true),
    diskCleanupCheckIntervalMs: getNumber(env, "DISK_CLEANUP_CHECK_INTERVAL_MS", 5 * 60 * 1000),
    diskCleanupMinFreeBytes: getNumber(env, "DISK_CLEANUP_MIN_FREE_BYTES", 10 * GIB),
    diskCleanupTargetFreeBytes: getNumber(env, "DISK_CLEANUP_TARGET_FREE_BYTES", 20 * GIB),
    diskCleanupInactiveSessionMs: getNumber(env, "DISK_CLEANUP_INACTIVE_SESSION_MS", DAY_MS),
    diskCleanupJobProtectionMs: getNumber(env, "DISK_CLEANUP_JOB_PROTECTION_MS", 2 * DAY_MS),
    diskCleanupOldLogMs: getNumber(env, "DISK_CLEANUP_OLD_LOG_MS", DAY_MS)
  };
}
