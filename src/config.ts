import path from "node:path";

export interface AppConfig {
  readonly slackAppToken: string;
  readonly slackBotToken: string;
  readonly slackApiBaseUrl: string;
  readonly slackSocketOpenUrl: string;
  readonly slackInitialThreadHistoryCount: number;
  readonly slackHistoryApiMaxLimit: number;
  readonly slackActiveTurnReconcileIntervalMs: number;
  readonly slackProgressReminderAfterMs: number;
  readonly slackProgressReminderRepeatMs: number;
  readonly stateDir: string;
  readonly jobsRoot: string;
  readonly sessionsRoot: string;
  readonly reposRoot: string;
  readonly codexHome: string;
  readonly codexHostHomePath?: string | undefined;
  readonly codexAuthJsonPath?: string | undefined;
  readonly codexDisabledMcpServers: string[];
  readonly codexAppServerUrl?: string | undefined;
  readonly codexAppServerPort: number;
  readonly codexOpenAiApiKey?: string | undefined;
  readonly port: number;
  readonly brokerHttpBaseUrl: string;
  readonly serviceName: string;
  readonly brokerAdminToken?: string | undefined;
  readonly logDir: string;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly logRawSlackEvents: boolean;
  readonly logRawCodexRpc: boolean;
  readonly logRawHttpRequests: boolean;
}

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
  const dataRoot = env.DATA_ROOT ? path.resolve(env.DATA_ROOT) : path.resolve(".data");
  const stateDir = env.STATE_DIR ? path.resolve(env.STATE_DIR) : path.join(dataRoot, "state");
  const jobsRoot = env.JOBS_ROOT ? path.resolve(env.JOBS_ROOT) : path.join(dataRoot, "jobs");
  const sessionsRoot = env.SESSIONS_ROOT ? path.resolve(env.SESSIONS_ROOT) : path.join(dataRoot, "sessions");
  const reposRoot = env.REPOS_ROOT ? path.resolve(env.REPOS_ROOT) : path.join(dataRoot, "repos");
  const codexHome = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(dataRoot, "codex-home");
  const logDir = env.LOG_DIR ? path.resolve(env.LOG_DIR) : path.join(dataRoot, "logs");
  const port = getNumber(env, "PORT", 3000);

  return {
    slackAppToken: getRequired(env, "SLACK_APP_TOKEN"),
    slackBotToken: getRequired(env, "SLACK_BOT_TOKEN"),
    slackApiBaseUrl: env.SLACK_API_BASE_URL ?? "https://slack.com/api",
    slackSocketOpenUrl: env.SLACK_SOCKET_OPEN_URL ?? "apps.connections.open",
    slackInitialThreadHistoryCount: getNumber(env, "SLACK_INITIAL_THREAD_HISTORY_COUNT", 8),
    slackHistoryApiMaxLimit: getNumber(env, "SLACK_HISTORY_API_MAX_LIMIT", 50),
    slackActiveTurnReconcileIntervalMs: getNumber(env, "SLACK_ACTIVE_TURN_RECONCILE_INTERVAL_MS", 15_000),
    slackProgressReminderAfterMs: getNumber(env, "SLACK_PROGRESS_REMINDER_AFTER_MS", 120_000),
    slackProgressReminderRepeatMs: getNumber(env, "SLACK_PROGRESS_REMINDER_REPEAT_MS", 120_000),
    stateDir,
    jobsRoot,
    sessionsRoot,
    reposRoot,
    codexHome,
    codexHostHomePath: getOptional(env, "CODEX_HOST_HOME_PATH"),
    codexAuthJsonPath: getOptional(env, "CODEX_AUTH_JSON_PATH"),
    codexDisabledMcpServers: getCsvList(env, "CODEX_DISABLED_MCP_SERVERS"),
    codexAppServerUrl: getOptional(env, "CODEX_APP_SERVER_URL"),
    codexAppServerPort: getNumber(env, "CODEX_APP_SERVER_PORT", 4590),
    codexOpenAiApiKey: getOptional(env, "OPENAI_API_KEY"),
    port,
    brokerHttpBaseUrl: env.BROKER_HTTP_BASE_URL ?? `http://127.0.0.1:${port}`,
    serviceName: env.SERVICE_NAME ?? "slack-codex-broker",
    brokerAdminToken: getOptional(env, "BROKER_ADMIN_TOKEN"),
    logDir,
    logLevel: getLogLevel(env, "LOG_LEVEL", "info"),
    logRawSlackEvents: getBoolean(env, "LOG_RAW_SLACK_EVENTS", true),
    logRawCodexRpc: getBoolean(env, "LOG_RAW_CODEX_RPC", true),
    logRawHttpRequests: getBoolean(env, "LOG_RAW_HTTP_REQUESTS", true)
  };
}
