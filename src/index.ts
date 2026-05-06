import http from "node:http";

import { loadConfig } from "./config.js";
import { createHttpHandler } from "./http/router.js";
import { logger } from "./logger.js";
import { AdminService } from "./services/admin-service.js";
import { AuthProfileService } from "./services/auth-profile-service.js";
import { CodexRuntimeControl } from "./services/codex-runtime-control.js";
import {
  configureServiceLogger,
  createCodexBroker,
  createDiskPressureCleanup,
  createGitHubAuthorMappings,
  createIsolatedMcpService,
  createJobManager,
  createSessionServices,
  createSlackBridge
} from "./services/service-components.js";

export async function startService(): Promise<{
  readonly stop: () => Promise<void>;
}> {
  const startedAt = new Date();
  const config = loadConfig();
  configureServiceLogger(config);
  const { sessions: sessionManager } = createSessionServices(config);
  const githubAuthorMappings = await createGitHubAuthorMappings(config);
  const codexBroker = createCodexBroker(config);
  const bridge = createSlackBridge({
    config,
    sessions: sessionManager,
    codex: codexBroker,
    mappings: githubAuthorMappings
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
    await sessionManager.load();
    await diskCleanup.runOnce("startup");
    await bridge.start();
    await jobManager.start();
    diskCleanup.start();
    await new Promise<void>((resolve, reject) => {
      server.listen(config.port, () => resolve());
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

  logger.info("Service booted", {
    port: config.port,
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

startService().catch((error: unknown) => {
  logger.error("Fatal startup error", {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
