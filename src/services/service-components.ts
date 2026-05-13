import type { AppConfig } from "../config.js";
import { configureLogger } from "../logger.js";
import { StateStore } from "../store/state-store.js";
import type { AgentRuntime } from "./agent-runtime/types.js";
import { CodexAppServerRuntime } from "./agent-runtime/codex-app-server-runtime.js";
import { SessionAuthProfileRuntime } from "./agent-runtime/session-auth-profile-runtime.js";
import type { AuthProfileService } from "./auth-profile-service.js";
import { CodexBroker } from "./codex/codex-broker.js";
import { IsolatedMcpService } from "./codex/isolated-mcp-service.js";
import { DiskPressureCleanupService } from "./disk-pressure-cleanup-service.js";
import { GitHubAuthorMappingService } from "./github-author-mapping-service.js";
import { GitHubPrIdentityService } from "./github-pr-identity-service.js";
import { JobManager } from "./job-manager.js";
import { SessionManager } from "./session-manager.js";
import { SlackApi } from "./slack/slack-api.js";
import { SlackAgentBridge } from "./slack/slack-agent-bridge.js";

export function configureServiceLogger(config: AppConfig): void {
  configureLogger({
    logDir: config.logDir,
    level: config.logLevel,
    rawSlackEvents: config.logRawSlackEvents,
    rawCodexRpc: config.logRawCodexRpc,
    rawHttpRequests: config.logRawHttpRequests,
    rawMaxBytes: config.logRawMaxBytes
  });
}

export function createSessionServices(config: AppConfig): {
  readonly stateStore: StateStore;
  readonly sessions: SessionManager;
} {
  const stateStore = new StateStore(config.stateDir, config.sessionsRoot);
  const sessions = new SessionManager({
    stateStore,
    sessionsRoot: config.sessionsRoot
  });

  return {
    stateStore,
    sessions
  };
}

export function createSlackApi(config: AppConfig): SlackApi {
  return new SlackApi({
    baseUrl: config.slackApiBaseUrl,
    appToken: config.slackAppToken,
    botToken: config.slackBotToken
  });
}

export async function createGitHubAuthorMappings(config: AppConfig): Promise<GitHubAuthorMappingService> {
  const mappings = new GitHubAuthorMappingService({
    stateDir: config.stateDir
  });
  await mappings.load();
  return mappings;
}

export async function createGitHubPrIdentity(config: AppConfig): Promise<GitHubPrIdentityService> {
  const identities = new GitHubPrIdentityService({
    stateDir: config.stateDir,
    defaultGitHubLogin: config.defaultGitHubLogin,
    defaultGitHubToken: config.defaultGitHubToken,
    githubOAuthClientId: config.githubOAuthClientId,
    githubOAuthBaseUrl: config.githubOAuthBaseUrl,
    githubApiBaseUrl: config.githubApiBaseUrl,
    githubOAuthScopes: config.githubOAuthScopes
  });
  await identities.load();
  return identities;
}

export function createCodexBroker(config: AppConfig): CodexBroker {
  return new CodexBroker({
    serviceName: config.serviceName,
    brokerHttpBaseUrl: config.brokerHttpBaseUrl,
    codexHome: config.codexHome,
    reposRoot: config.reposRoot,
    hostCodexHomePath: config.codexHostHomePath,
    hostGeminiHomePath: config.geminiHostHomePath,
    codexAppServerPort: config.codexAppServerPort,
    codexAppServerUrl: config.codexAppServerUrl,
    codexAuthJsonPath: config.codexAuthJsonPath,
    codexDisabledMcpServers: config.codexDisabledMcpServers,
    tempadLinkServiceUrl: config.tempadLinkServiceUrl,
    geminiHttpProxy: config.geminiHttpProxy,
    geminiHttpsProxy: config.geminiHttpsProxy,
    geminiAllProxy: config.geminiAllProxy,
    openAiApiKey: config.codexOpenAiApiKey
  });
}

export function createAgentRuntime(options: {
  readonly config: AppConfig;
  readonly codex: CodexBroker;
  readonly sessions: SessionManager;
  readonly authProfiles: AuthProfileService;
}): AgentRuntime {
  const legacyRuntime = options.config.codexAppServerUrl
    ? new CodexAppServerRuntime({
        codex: options.codex,
        sessions: options.sessions
      })
    : undefined;
  return new SessionAuthProfileRuntime({
    config: options.config,
    sessions: options.sessions,
    authProfiles: options.authProfiles,
    legacyRuntime
  });
}

export function createSlackBridge(options: {
  readonly config: AppConfig;
  readonly sessions: SessionManager;
  readonly agentRuntime: AgentRuntime;
  readonly mappings: GitHubAuthorMappingService;
  readonly githubPrIdentity: GitHubPrIdentityService;
}): SlackAgentBridge {
  return new SlackAgentBridge({
    config: options.config,
    sessions: options.sessions,
    agentRuntime: options.agentRuntime,
    mappings: options.mappings,
    githubPrIdentity: options.githubPrIdentity
  });
}

export function createIsolatedMcpService(config: AppConfig): IsolatedMcpService {
  return new IsolatedMcpService({
    codexHome: config.codexHome,
    isolatedMcpServers: config.isolatedMcpServers
  });
}

export function createJobManager(options: {
  readonly config: AppConfig;
  readonly sessions: SessionManager;
  readonly bridge: SlackAgentBridge;
}): JobManager {
  return new JobManager({
    sessions: options.sessions,
    jobsRoot: options.config.jobsRoot,
    reposRoot: options.config.reposRoot,
    brokerHttpBaseUrl: options.config.brokerHttpBaseUrl,
    onEvent: async (event) => {
      await options.bridge.acceptBackgroundJobEvent(event);
    }
  });
}

export function createDiskPressureCleanup(options: {
  readonly config: AppConfig;
  readonly sessions: SessionManager;
  readonly jobManager: JobManager;
}): DiskPressureCleanupService {
  return new DiskPressureCleanupService({
    config: options.config,
    sessions: options.sessions,
    jobTerminator: options.jobManager
  });
}
