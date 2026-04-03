import http from "node:http";

import { loadConfig } from "./config.js";
import { createHttpHandler } from "./http/router.js";
import { configureLogger, logger } from "./logger.js";
import { CodexBroker } from "./services/codex/codex-broker.js";
import { IsolatedMcpService } from "./services/codex/isolated-mcp-service.js";
import { GitHubAuthorMappingService } from "./services/github-author-mapping-service.js";
import { JobManager } from "./services/job-manager.js";
import { SessionJanitor } from "./services/session-janitor.js";
import { SessionManager } from "./services/session-manager.js";
import { SlackCodexBridge } from "./services/slack/slack-codex-bridge.js";
import { StateStore } from "./store/state-store.js";

export async function startWorkerService(): Promise<{
  readonly stop: () => Promise<void>;
}> {
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
  const sessionJanitor = new SessionJanitor({
    sessions: sessionManager,
    sessionsRoot: config.sessionsRoot,
    jobsRoot: config.jobsRoot,
    logDir: config.logDir,
    inactivityTtlMs: config.sessionInactiveTtlMs,
    cleanupIntervalMs: config.sessionCleanupIntervalMs,
    cleanupMaxPerSweep: config.sessionCleanupMaxPerSweep
  });
  const server = http.createServer(
    createHttpHandler({
      bridge,
      isolatedMcp,
      jobManager,
      config
    })
  );

  try {
    await bridge.start();
    await jobManager.start();
    await sessionJanitor.start();
    await new Promise<void>((resolve, reject) => {
      server.listen(config.port, config.workerBindHost, () => resolve());
      server.once("error", reject);
    });
  } catch (error) {
    await sessionJanitor.stop().catch(() => {});
    await jobManager.stop().catch(() => {});
    await bridge.stop().catch(() => {});
    if (server.listening) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    throw error;
  }

  logger.info("Worker service booted", {
    port: config.port,
    workerBindHost: config.workerBindHost,
    sessionsRoot: config.sessionsRoot,
    reposRoot: config.reposRoot
  });

  return {
    stop: async () => {
      await sessionJanitor.stop();
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

startWorkerService().catch((error: unknown) => {
  logger.error("Fatal worker startup error", {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
