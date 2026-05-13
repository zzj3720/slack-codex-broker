import http from "node:http";

import { loadConfig } from "./config.js";
import { createHttpHandler } from "./http/router.js";
import { logger } from "./logger.js";
import { AuthProfileService } from "./services/auth-profile-service.js";
import {
  configureServiceLogger,
  createAgentRuntime,
  createCodexBroker,
  createDiskPressureCleanup,
  createGitHubAuthorMappings,
  createGitHubPrIdentity,
  createIsolatedMcpService,
  createJobManager,
  createSessionServices,
  createSlackBridge
} from "./services/service-components.js";

export async function startWorkerService(): Promise<{
  readonly stop: () => Promise<void>;
}> {
  const config = loadConfig();
  configureServiceLogger(config);

  const { sessions: sessionManager } = createSessionServices(config);
  const githubAuthorMappings = await createGitHubAuthorMappings(config);
  const githubPrIdentity = await createGitHubPrIdentity(config);
  const authProfiles = new AuthProfileService({
    config
  });
  const codexBroker = createCodexBroker(config);
  const agentRuntime = createAgentRuntime({
    config,
    codex: codexBroker,
    sessions: sessionManager,
    authProfiles
  });
  const bridge = createSlackBridge({
    config,
    sessions: sessionManager,
    agentRuntime,
    mappings: githubAuthorMappings,
    githubPrIdentity
  });
  const isolatedMcp = createIsolatedMcpService(config);
  const jobManager = createJobManager({
    config,
    sessions: sessionManager,
    bridge
  });
  const diskCleanup = createDiskPressureCleanup({
    config,
    sessions: sessionManager,
    jobManager
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
    await sessionManager.load();
    await diskCleanup.runOnce("startup");
    await bridge.start();
    await jobManager.start();
    diskCleanup.start();
    await new Promise<void>((resolve, reject) => {
      server.listen(config.port, config.workerBindHost, () => resolve());
      server.once("error", reject);
    });
  } catch (error) {
    diskCleanup.stop();
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
      diskCleanup.stop();
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
