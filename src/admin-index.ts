import http from "node:http";

import { loadConfig } from "./config.js";
import { createHttpHandler } from "./http/router.js";
import { configureLogger, logger } from "./logger.js";
import { AdminService } from "./services/admin-service.js";
import { AuthProfileService } from "./services/auth-profile-service.js";
import { AuthFileRuntimeControl } from "./services/auth-file-runtime-control.js";
import { WorkerDeploymentService } from "./services/deploy/worker-deployment-service.js";
import { GitHubAuthorMappingService } from "./services/github-author-mapping-service.js";
import { SessionManager } from "./services/session-manager.js";
import { StateStore } from "./store/state-store.js";

export async function startAdminService(): Promise<{
  readonly stop: () => Promise<void>;
}> {
  const startedAt = new Date();
  const config = loadConfig();
  configureLogger({
    logDir: config.logDir,
    level: config.logLevel,
    rawSlackEvents: config.logRawSlackEvents,
    rawCodexRpc: config.logRawCodexRpc,
    rawHttpRequests: config.logRawHttpRequests,
    rawMaxBytes: config.logRawMaxBytes
  });

  const stateStore = new StateStore(config.stateDir, config.sessionsRoot);
  const sessions = new SessionManager({
    stateStore,
    sessionsRoot: config.sessionsRoot
  });
  await sessions.load();
  const authProfiles = new AuthProfileService({
    config
  });
  const githubAuthorMappings = new GitHubAuthorMappingService({
    stateDir: config.stateDir
  });
  await githubAuthorMappings.load();
  const deployment = createWorkerDeploymentService(config);
  const runtime = new AuthFileRuntimeControl(config, {
    onRestart: async (reason) => {
      if (!deployment) {
        throw new Error("Worker deployment is not configured for this admin runtime.");
      }
      await deployment.restartWorker(reason);
    }
  });
  const adminService = new AdminService({
    config,
    sessions,
    runtime,
    authProfiles,
    githubAuthorMappings,
    startedAt,
    deployment
  });
  const server = http.createServer(
    createHttpHandler({
      adminService,
      config
    })
  );

  await new Promise<void>((resolve, reject) => {
    server.listen(config.port, () => resolve());
    server.once("error", reject);
  });

  logger.info("Admin service booted", {
    port: config.port,
    serviceRoot: config.serviceRoot ?? null,
    workerBaseUrl: config.workerBaseUrl
  });

  return {
    stop: async () => {
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

function createWorkerDeploymentService(config: ReturnType<typeof loadConfig>): WorkerDeploymentService | undefined {
  if (
    !config.serviceRoot ||
    !config.releaseRepoRoot ||
    !config.releasesRoot ||
    !config.currentReleasePath ||
    !config.previousReleasePath ||
    !config.failedReleasePath ||
    !config.workerPlistPath ||
    !config.workerLaunchdLabel
  ) {
    return undefined;
  }

  return new WorkerDeploymentService({
    serviceRoot: config.serviceRoot,
    repoRoot: config.releaseRepoRoot,
    releasesRoot: config.releasesRoot,
    currentReleasePath: config.currentReleasePath,
    previousReleasePath: config.previousReleasePath,
    failedReleasePath: config.failedReleasePath,
    workerPlistPath: config.workerPlistPath,
    workerLaunchdLabel: config.workerLaunchdLabel,
    workerBaseUrl: config.workerBaseUrl,
    codexAppServerPort: config.codexAppServerPort,
    releaseRepoUrl: config.releaseRepoUrl
  });
}

startAdminService().catch((error: unknown) => {
  logger.error("Fatal admin startup error", {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
