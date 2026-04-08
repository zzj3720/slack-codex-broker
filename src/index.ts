import http from "node:http";

import { loadConfig } from "./config.js";
import { createHttpHandler } from "./http/router.js";
import { configureLogger, logger } from "./logger.js";
import { AdminService } from "./services/admin-service.js";
import { AuthProfileService } from "./services/auth-profile-service.js";
import { CodexBroker } from "./services/codex/codex-broker.js";
import { CodexRuntimeControl } from "./services/codex-runtime-control.js";
import { IsolatedMcpService } from "./services/codex/isolated-mcp-service.js";
import { GitHubAuthorMappingService } from "./services/github-author-mapping-service.js";
import { JobManager } from "./services/job-manager.js";
import { SessionArtifactJanitor } from "./services/session-artifact-janitor.js";
import { SessionManager } from "./services/session-manager.js";
import { SlackCodexBridge } from "./services/slack/slack-codex-bridge.js";
import { StateStore } from "./store/state-store.js";

export async function startService(): Promise<{
  readonly stop: () => Promise<void>;
}> {
  const startedAt = new Date();
  const config = loadConfig();
  configureLogger({
    logDir: config.logDir,
    level: config.logLevel,
    rawSlackEvents: config.logRawSlackEvents,
    rawCodexRpc: config.logRawCodexRpc,
    rawHttpRequests: config.logRawHttpRequests
  });
  const stateStore = new StateStore(config.stateDir, config.sessionsRoot);
  const sessionManager = new SessionManager({
    stateStore,
    sessionsRoot: config.sessionsRoot
  });
  const githubAuthorMappings = new GitHubAuthorMappingService({
    stateDir: config.stateDir
  });
  await githubAuthorMappings.load();
  const codexBroker = new CodexBroker({
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
  const bridge = new SlackCodexBridge({
    config,
    sessions: sessionManager,
    codex: codexBroker,
    mappings: githubAuthorMappings
  });
  const isolatedMcp = new IsolatedMcpService({
    codexHome: config.codexHome,
    isolatedMcpServers: config.isolatedMcpServers
  });
  const jobManager = new JobManager({
    sessions: sessionManager,
    jobsRoot: config.jobsRoot,
    reposRoot: config.reposRoot,
    brokerHttpBaseUrl: config.brokerHttpBaseUrl,
    onEvent: async (event) => {
      await bridge.acceptBackgroundJobEvent(event);
    }
  });
  const sessionArtifactJanitor = new SessionArtifactJanitor({
    sessions: sessionManager,
    inactivityTtlMs: config.sessionArtifactInactiveTtlMs,
    cleanupIntervalMs: config.sessionArtifactCleanupIntervalMs,
    cleanupMaxPerSweep: config.sessionArtifactCleanupMaxPerSweep
  });
  const authProfiles = new AuthProfileService({
    config
  });
  const adminService = new AdminService({
    config,
    sessions: sessionManager,
    runtime: new CodexRuntimeControl(codexBroker),
    authProfiles,
    githubAuthorMappings,
    startedAt
  });
  const server = http.createServer(
    createHttpHandler({
      adminService,
      bridge,
      isolatedMcp,
      jobManager,
      config
    })
  );

  try {
    await bridge.start();
    await jobManager.start();
    await sessionArtifactJanitor.start();
    await new Promise<void>((resolve, reject) => {
      server.listen(config.port, () => resolve());
      server.once("error", reject);
    });
  } catch (error) {
    await sessionArtifactJanitor.stop().catch(() => {});
    await jobManager.stop().catch(() => {});
    await bridge.stop().catch(() => {});
    if (server.listening) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    throw error;
  }

  logger.info("Service booted", {
    port: config.port,
    sessionsRoot: config.sessionsRoot,
    reposRoot: config.reposRoot
  });

  return {
    stop: async () => {
      await sessionArtifactJanitor.stop();
      await bridge.stop();
      await jobManager.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  };
}

startService().catch((error: unknown) => {
  logger.error("Fatal startup error", {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
