import http from "node:http";

import { loadConfig } from "./config.js";
import { createHttpHandler } from "./http/router.js";
import { configureLogger, logger } from "./logger.js";
import { CodexBroker } from "./services/codex/codex-broker.js";
import { JobManager } from "./services/job-manager.js";
import { SessionManager } from "./services/session-manager.js";
import { SlackCodexBridge } from "./services/slack/slack-codex-bridge.js";
import { StateStore } from "./store/state-store.js";

export async function startService(): Promise<{
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
  const codexBroker = new CodexBroker({
    serviceName: config.serviceName,
    brokerHttpBaseUrl: config.brokerHttpBaseUrl,
    codexHome: config.codexHome,
    reposRoot: config.reposRoot,
    hostCodexHomePath: config.codexHostHomePath,
    codexAppServerPort: config.codexAppServerPort,
    codexAppServerUrl: config.codexAppServerUrl,
    codexAuthJsonPath: config.codexAuthJsonPath,
    codexDisabledMcpServers: config.codexDisabledMcpServers,
    openAiApiKey: config.codexOpenAiApiKey
  });
  const bridge = new SlackCodexBridge({
    config,
    sessions: sessionManager,
    codex: codexBroker
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
  const server = http.createServer(
    createHttpHandler({
      bridge,
      jobManager,
      config
    })
  );

  await new Promise<void>((resolve) => {
    server.listen(config.port, resolve);
  });
  await bridge.start();
  await jobManager.start();

  logger.info("Service booted", {
    port: config.port,
    sessionsRoot: config.sessionsRoot,
    reposRoot: config.reposRoot
  });

  return {
    stop: async () => {
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
  process.exitCode = 1;
});
