import type { AppConfig } from "../config.js";
import { configureLogger } from "../logger.js";
import { StateStore } from "../store/state-store.js";
import { CodexBroker } from "./codex/codex-broker.js";
import { IsolatedMcpService } from "./codex/isolated-mcp-service.js";
import { DiskPressureCleanupService } from "./disk-pressure-cleanup-service.js";
import { GitHubAuthorMappingService } from "./github-author-mapping-service.js";
import { JobManager } from "./job-manager.js";
import { SessionManager } from "./session-manager.js";
import { SlackCodexBridge } from "./slack/slack-codex-bridge.js";

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

export async function createGitHubAuthorMappings(config: AppConfig): Promise<GitHubAuthorMappingService> {
  const mappings = new GitHubAuthorMappingService({
    stateDir: config.stateDir
  });
  await mappings.load();
  return mappings;
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

export function createSlackBridge(options: {
  readonly config: AppConfig;
  readonly sessions: SessionManager;
  readonly codex: CodexBroker;
  readonly mappings: GitHubAuthorMappingService;
}): SlackCodexBridge {
  return new SlackCodexBridge({
    config: options.config,
    sessions: options.sessions,
    codex: options.codex,
    mappings: options.mappings
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
  readonly bridge: SlackCodexBridge;
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
