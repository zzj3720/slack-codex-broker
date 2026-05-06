import fs from "node:fs/promises";
import path from "node:path";

import { logger } from "../../logger.js";
import { execCommand } from "../../utils/exec.js";
import { ensureDir, fileExists } from "../../utils/fs.js";

const RELEASE_METADATA_FILENAME = ".broker-release.json";
const RELEASE_STATE_SCHEMA_VERSION = 1;

export interface ReleaseMetadata {
  readonly revision: string | null;
  readonly shortRevision: string | null;
  readonly branch: string | null;
  readonly builtAt: string;
  readonly builtBy: string;
  readonly builtFromHost: string;
  readonly requestedRef?: string | null | undefined;
  readonly stateSchemaVersion: number;
}

export interface ReleaseInfo {
  readonly linkPath: string;
  readonly targetPath: string | null;
  readonly exists: boolean;
  readonly metadata: ReleaseMetadata | null;
}

export interface WorkerHealthStatus {
  readonly launchdLoaded: boolean;
  readonly healthOk: boolean;
  readonly readyOk: boolean;
  readonly healthBody: string;
  readonly readyError: string | null;
}

export interface AdminHealthStatus {
  readonly launchdLoaded: boolean;
  readonly healthOk: boolean;
  readonly healthBody: string;
}

export interface ReleaseDeploymentStatus {
  readonly serviceRoot: string;
  readonly repoRoot: string;
  readonly repoUrl: string | null;
  readonly currentRelease: ReleaseInfo;
  readonly previousRelease: ReleaseInfo;
  readonly failedRelease: ReleaseInfo;
  readonly recentReleases: readonly ReleaseInfo[];
  readonly admin: AdminHealthStatus | null;
  readonly worker: WorkerHealthStatus;
}

export interface DeployReleaseOptions {
  readonly ref: string;
}

export interface RollbackReleaseOptions {
  readonly ref?: string | undefined;
}

export class ReleaseDeploymentService {
  readonly #uid = typeof process.getuid === "function" ? process.getuid() : 0;
  #operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      readonly serviceRoot: string;
      readonly repoRoot: string;
      readonly releasesRoot: string;
      readonly currentReleasePath: string;
      readonly previousReleasePath: string;
      readonly failedReleasePath: string;
      readonly adminPlistPath?: string | undefined;
      readonly adminLaunchdLabel?: string | undefined;
      readonly adminBaseUrl?: string | undefined;
      readonly workerPlistPath: string;
      readonly workerLaunchdLabel: string;
      readonly workerBaseUrl: string;
      readonly codexAppServerPort: number;
      readonly releaseRepoUrl?: string | undefined;
      readonly corepackPath?: string | undefined;
      readonly healthCheckTimeoutMs?: number | undefined;
      readonly healthCheckIntervalMs?: number | undefined;
      readonly scheduleAdminRestart?: ((restart: () => Promise<void>) => void) | undefined;
      readonly exec?: typeof execCommand | undefined;
    }
  ) {}

  async getStatus(): Promise<ReleaseDeploymentStatus> {
    const [currentRelease, previousRelease, failedRelease, recentReleases, admin, worker] = await Promise.all([
      this.#readLinkedRelease(this.options.currentReleasePath),
      this.#readLinkedRelease(this.options.previousReleasePath),
      this.#readLinkedRelease(this.options.failedReleasePath),
      this.#readRecentReleases(),
      this.#readAdminHealth(),
      this.#readWorkerHealth()
    ]);

    return {
      serviceRoot: this.options.serviceRoot,
      repoRoot: this.options.repoRoot,
      repoUrl: await this.#readRepoUrl(),
      currentRelease,
      previousRelease,
      failedRelease,
      recentReleases,
      admin,
      worker
    };
  }

  async deploy(options: DeployReleaseOptions): Promise<ReleaseDeploymentStatus> {
    return await this.#runExclusive(async () => {
      await this.#ensureRepoReady();
      const revision = await this.#resolveRevision(options.ref);
      const releaseRoot = await this.#ensureReleaseWorktree(revision);
      const metadata = await this.#buildReleaseMetadata(revision, options.ref);
      await this.#buildRelease(releaseRoot);
      await this.#writeReleaseMetadata(releaseRoot, metadata);
      await this.#activateRelease(releaseRoot);
      return await this.getStatus();
    });
  }

  async rollback(options: RollbackReleaseOptions = {}): Promise<ReleaseDeploymentStatus> {
    return await this.#runExclusive(async () => {
      const releaseRoot = options.ref
        ? await this.#resolveRollbackRelease(options.ref)
        : await this.#requirePreviousRelease();
      await this.#activateRelease(releaseRoot);
      return await this.getStatus();
    });
  }

  async restartWorker(reason: string): Promise<void> {
    await this.#runExclusive(async () => {
      await this.#restartLaunchdWorker(reason);
      await this.#assertWorkerHealthy();
    });
  }

  async #runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#operationQueue;
    let releaseQueue = () => {};
    this.#operationQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      releaseQueue();
    }
  }

  async #resolveRollbackRelease(ref: string): Promise<string> {
    const directPath = path.join(this.options.releasesRoot, ref);
    if (await fileExists(directPath)) {
      return directPath;
    }

    await this.#ensureRepoReady();
    const revision = await this.#resolveRevision(ref);
    const releaseRoot = await this.#ensureReleaseWorktree(revision);
    const metadataPath = path.join(releaseRoot, RELEASE_METADATA_FILENAME);
    if (!(await fileExists(metadataPath))) {
      const metadata = await this.#buildReleaseMetadata(revision, ref);
      await this.#buildRelease(releaseRoot);
      await this.#writeReleaseMetadata(releaseRoot, metadata);
    }
    return releaseRoot;
  }

  async #requirePreviousRelease(): Promise<string> {
    const previous = await this.#readLinkedRelease(this.options.previousReleasePath);
    if (!previous.targetPath || !(await fileExists(previous.targetPath))) {
      throw new Error(`No previous worker release found at ${this.options.previousReleasePath}`);
    }
    return previous.targetPath;
  }

  async #ensureRepoReady(): Promise<void> {
    if (!(await fileExists(path.join(this.options.repoRoot, ".git")))) {
      if (!this.options.releaseRepoUrl) {
        throw new Error("Missing release repo clone and RELEASE_REPO_URL is not configured.");
      }
      await ensureDir(path.dirname(this.options.repoRoot));
      await this.#exec("git", ["clone", this.options.releaseRepoUrl, this.options.repoRoot]);
    }

    if (this.options.releaseRepoUrl) {
      await this.#exec("git", ["-C", this.options.repoRoot, "remote", "set-url", "origin", this.options.releaseRepoUrl]);
    }

    await this.#exec("git", ["-C", this.options.repoRoot, "fetch", "--prune", "--tags", "origin"]);
  }

  async #resolveRevision(ref: string): Promise<string> {
    const result = await this.#exec("git", ["-C", this.options.repoRoot, "rev-parse", `${ref}^{commit}`]);
    return result.stdout.trim();
  }

  async #ensureReleaseWorktree(revision: string): Promise<string> {
    const releaseRoot = path.join(this.options.releasesRoot, revision);
    if (await fileExists(path.join(releaseRoot, ".git"))) {
      const existingRevision = (await this.#exec("git", ["-C", releaseRoot, "rev-parse", "HEAD"])).stdout.trim();
      if (existingRevision === revision) {
        return releaseRoot;
      }
      throw new Error(`Existing release path points at a different revision: ${releaseRoot}`);
    }

    if (await fileExists(releaseRoot)) {
      await fs.rm(releaseRoot, { force: true, recursive: true });
      await this.#exec("git", ["-C", this.options.repoRoot, "worktree", "prune"]);
    }

    await ensureDir(this.options.releasesRoot);
    await this.#exec("git", ["-C", this.options.repoRoot, "worktree", "add", "--detach", releaseRoot, revision]);
    return releaseRoot;
  }

  async #buildReleaseMetadata(revision: string, requestedRef: string): Promise<ReleaseMetadata> {
    let branch: string | null = null;
    try {
      const result = await this.#exec("git", ["-C", this.options.repoRoot, "branch", "--contains", revision, "--format=%(refname:short)"]);
      branch = result.stdout
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .find(Boolean) ?? null;
    } catch {
      branch = null;
    }

    return {
      revision,
      shortRevision: revision.slice(0, 12),
      branch,
      builtAt: new Date().toISOString(),
      builtBy: process.env.USER || process.env.LOGNAME || "unknown",
      builtFromHost: process.env.HOSTNAME || "unknown",
      requestedRef,
      stateSchemaVersion: RELEASE_STATE_SCHEMA_VERSION
    };
  }

  async #buildRelease(releaseRoot: string): Promise<void> {
    const corepack = this.options.corepackPath || "corepack";
    await this.#exec(corepack, ["pnpm", "install", "--frozen-lockfile"], { cwd: releaseRoot });
    await this.#exec(corepack, ["pnpm", "build"], { cwd: releaseRoot });
    await this.#exec(corepack, ["pnpm", "install", "--prod", "--frozen-lockfile"], { cwd: releaseRoot });
  }

  async #writeReleaseMetadata(releaseRoot: string, metadata: ReleaseMetadata): Promise<void> {
    await fs.writeFile(
      path.join(releaseRoot, RELEASE_METADATA_FILENAME),
      `${JSON.stringify(metadata, null, 2)}\n`,
      "utf8"
    );
  }

  async #activateRelease(releaseRoot: string): Promise<void> {
    const currentRelease = await this.#readLinkedRelease(this.options.currentReleasePath);
    const previousRelease = await this.#readLinkedRelease(this.options.previousReleasePath);
    const previousCurrentPath = currentRelease.targetPath;
    const previousPreviousPath = previousRelease.targetPath;

    await this.#pointLink(this.options.currentReleasePath, releaseRoot);
    if (previousCurrentPath && previousCurrentPath !== releaseRoot) {
      await this.#pointLink(this.options.previousReleasePath, previousCurrentPath);
    }

    try {
      await this.#restartLaunchdWorker("worker release activation");
      await this.#assertWorkerHealthy();
      await fs.rm(this.options.failedReleasePath, { force: true, recursive: true });
      this.#scheduleAdminRestart("admin release activation");
    } catch (error) {
      await this.#pointLink(this.options.failedReleasePath, releaseRoot);
      if (previousCurrentPath) {
        await this.#pointLink(this.options.currentReleasePath, previousCurrentPath);
      } else {
        await fs.rm(this.options.currentReleasePath, { force: true, recursive: true });
      }

      if (previousPreviousPath && previousPreviousPath !== releaseRoot) {
        await this.#pointLink(this.options.previousReleasePath, previousPreviousPath);
      } else if (!previousCurrentPath || previousCurrentPath === releaseRoot) {
        await fs.rm(this.options.previousReleasePath, { force: true, recursive: true });
      }

      if (previousCurrentPath) {
        await this.#restartLaunchdWorker("worker release rollback");
      }

      throw error;
    }
  }

  async #restartLaunchdWorker(reason: string): Promise<void> {
    await this.#restartLaunchdService({
      reason,
      plistPath: this.options.workerPlistPath,
      launchdLabel: this.options.workerLaunchdLabel,
      serviceName: "worker"
    });
  }

  async #restartLaunchdAdmin(reason: string): Promise<void> {
    if (!this.options.adminPlistPath || !this.options.adminLaunchdLabel) {
      return;
    }

    await this.#restartLaunchdService({
      reason,
      plistPath: this.options.adminPlistPath,
      launchdLabel: this.options.adminLaunchdLabel,
      serviceName: "admin"
    });
    await this.#assertAdminHealthy();
  }

  async #restartLaunchdService(options: {
    readonly reason: string;
    readonly plistPath: string;
    readonly launchdLabel: string;
    readonly serviceName: string;
  }): Promise<void> {
    if (!(await fileExists(options.plistPath))) {
      throw new Error(`Missing ${options.serviceName} launchd plist: ${options.plistPath}`);
    }

    const domain = `gui/${this.#uid}`;
    await this.#exec("launchctl", ["bootout", domain, options.plistPath]).catch(() => undefined);
    await this.#exec("launchctl", ["bootstrap", domain, options.plistPath]);
    await this.#exec("launchctl", ["kickstart", "-k", `${domain}/${options.launchdLabel}`]);
  }

  async #assertWorkerHealthy(): Promise<void> {
    const timeoutMs = this.options.healthCheckTimeoutMs ?? 20_000;
    const intervalMs = this.options.healthCheckIntervalMs ?? 500;
    const deadline = Date.now() + timeoutMs;
    let lastStatus = await this.#readWorkerHealth();

    while (Date.now() < deadline) {
      if (lastStatus.launchdLoaded && lastStatus.healthOk && lastStatus.readyOk) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      lastStatus = await this.#readWorkerHealth();
    }

    if (!lastStatus.launchdLoaded || !lastStatus.healthOk || !lastStatus.readyOk) {
      throw new Error(
        `Worker failed health checks: launchdLoaded=${lastStatus.launchdLoaded} healthOk=${lastStatus.healthOk} readyOk=${lastStatus.readyOk}${lastStatus.readyError ? ` readyError=${lastStatus.readyError}` : ""}`
      );
    }
  }

  async #readWorkerHealth(): Promise<WorkerHealthStatus> {
    const launchdLoaded = await this.#isLaunchdLoaded(this.options.workerLaunchdLabel);
    const healthResponse = await this.#fetchText(`${this.options.workerBaseUrl}/readyz`);
    const healthOk = Boolean(healthResponse.ok && healthResponse.body.includes("\"ok\":true"));
    const ready = await this.#checkWsReady();
    return {
      launchdLoaded,
      healthOk,
      readyOk: ready.ok,
      healthBody: healthResponse.body,
      readyError: ready.ok ? null : ready.error
    };
  }

  async #readAdminHealth(): Promise<AdminHealthStatus | null> {
    if (!this.options.adminLaunchdLabel || !this.options.adminBaseUrl) {
      return null;
    }

    const launchdLoaded = await this.#isLaunchdLoaded(this.options.adminLaunchdLabel);
    const healthResponse = await this.#fetchText(`${this.options.adminBaseUrl}/readyz`);
    return {
      launchdLoaded,
      healthOk: Boolean(healthResponse.ok && healthResponse.body.includes("\"ok\":true")),
      healthBody: healthResponse.body
    };
  }

  async #assertAdminHealthy(): Promise<void> {
    if (!this.options.adminLaunchdLabel || !this.options.adminBaseUrl) {
      return;
    }

    const timeoutMs = this.options.healthCheckTimeoutMs ?? 20_000;
    const intervalMs = this.options.healthCheckIntervalMs ?? 500;
    const deadline = Date.now() + timeoutMs;
    let lastStatus = await this.#readAdminHealth();

    while (Date.now() < deadline) {
      if (lastStatus?.launchdLoaded && lastStatus.healthOk) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      lastStatus = await this.#readAdminHealth();
    }

    throw new Error(
      `Admin failed health checks: launchdLoaded=${lastStatus?.launchdLoaded ?? false} healthOk=${lastStatus?.healthOk ?? false}`
    );
  }

  #scheduleAdminRestart(reason: string): void {
    if (!this.options.adminPlistPath || !this.options.adminLaunchdLabel) {
      return;
    }

    const restart = async () => {
      await this.#restartLaunchdAdmin(reason);
    };

    if (this.options.scheduleAdminRestart) {
      this.options.scheduleAdminRestart(restart);
      return;
    }

    const timer = setTimeout(() => {
      void restart().catch((error) => {
        logger.error("Scheduled admin restart failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }, 250);
    timer.unref?.();
  }

  async #isLaunchdLoaded(label: string): Promise<boolean> {
    const domain = `gui/${this.#uid}/${label}`;
    try {
      await this.#exec("launchctl", ["print", domain]);
      return true;
    } catch {
      return false;
    }
  }

  async #fetchText(url: string): Promise<{ readonly ok: boolean; readonly body: string }> {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(3_000)
      });
      const body = await response.text();
      return {
        ok: response.ok,
        body
      };
    } catch (error) {
      return {
        ok: false,
        body: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async #checkWsReady(): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({
          ok: false,
          error: "timeout"
        });
      }, 3_000);

      let socket: WebSocket;
      try {
        socket = new WebSocket(`ws://127.0.0.1:${this.options.codexAppServerPort}`);
      } catch (error) {
        clearTimeout(timer);
        resolve({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
        return;
      }

      const finish = (result: { readonly ok: true } | { readonly ok: false; readonly error: string }) => {
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          // ignore close failures
        }
        resolve(result);
      };

      socket.addEventListener("open", () => {
        finish({ ok: true });
      });
      socket.addEventListener("error", (event) => {
        const error = "error" in event && event.error instanceof Error ? event.error.message : "websocket_open_failed";
        finish({
          ok: false,
          error
        });
      });
    });
  }

  async #readRepoUrl(): Promise<string | null> {
    if (!(await fileExists(path.join(this.options.repoRoot, ".git")))) {
      return this.options.releaseRepoUrl ?? null;
    }

    try {
      const result = await this.#exec("git", ["-C", this.options.repoRoot, "remote", "get-url", "origin"]);
      return result.stdout.trim() || this.options.releaseRepoUrl || null;
    } catch {
      return this.options.releaseRepoUrl ?? null;
    }
  }

  async #readRecentReleases(): Promise<readonly ReleaseInfo[]> {
    if (!(await fileExists(this.options.releasesRoot))) {
      return [];
    }

    const entries = await fs.readdir(this.options.releasesRoot, { withFileTypes: true });
    const releases = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const targetPath = path.join(this.options.releasesRoot, entry.name);
          const metadata = await this.#readReleaseMetadata(targetPath);
          const stat = await fs.stat(targetPath);
          return {
            linkPath: targetPath,
            targetPath,
            exists: true,
            metadata,
            mtimeMs: stat.mtimeMs
          };
        })
    );

    return releases
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, 10)
      .map(({ mtimeMs: _mtimeMs, ...release }) => release);
  }

  async #readLinkedRelease(linkPath: string): Promise<ReleaseInfo> {
    const targetPath = await this.#readLinkTarget(linkPath);
    return {
      linkPath,
      targetPath,
      exists: targetPath ? await fileExists(targetPath) : false,
      metadata: targetPath ? await this.#readReleaseMetadata(targetPath) : null
    };
  }

  async #readReleaseMetadata(releaseRoot: string): Promise<ReleaseMetadata | null> {
    const metadataPath = path.join(releaseRoot, RELEASE_METADATA_FILENAME);
    if (!(await fileExists(metadataPath))) {
      return null;
    }

    const raw = await fs.readFile(metadataPath, "utf8");
    return JSON.parse(raw) as ReleaseMetadata;
  }

  async #readLinkTarget(linkPath: string): Promise<string | null> {
    try {
      const rawTarget = await fs.readlink(linkPath);
      return path.resolve(path.dirname(linkPath), rawTarget);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return null;
      }
      if (error && typeof error === "object" && "code" in error && error.code === "EINVAL") {
        return path.resolve(linkPath);
      }
      throw error;
    }
  }

  async #pointLink(linkPath: string, targetPath: string): Promise<void> {
    await ensureDir(path.dirname(linkPath));
    const tempPath = `${linkPath}.tmp-${process.pid}-${Date.now()}`;
    const relativeTarget = path.relative(path.dirname(linkPath), targetPath);
    await fs.rm(tempPath, { force: true, recursive: true });
    await fs.symlink(relativeTarget, tempPath, "dir");
    await fs.rename(tempPath, linkPath);
  }

  async #exec(
    command: string,
    args: readonly string[],
    options: {
      readonly cwd?: string | undefined;
    } = {}
  ) {
    const exec = this.options.exec ?? execCommand;
    return await exec(command, args, options.cwd ? { cwd: options.cwd, env: process.env } : { env: process.env });
  }
}
