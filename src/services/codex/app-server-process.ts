import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import { logger } from "../../logger.js";
import { ensureDir, fileExists } from "../../utils/fs.js";
import { resolveRuntimeToolPath } from "../../utils/runtime-paths.js";
import { syncUserCodexHome } from "./codex-home.js";
import { syncGeminiHome } from "./gemini-home.js";

const ALL_MCP_SERVERS = "*";

export class AppServerProcess {
  readonly #brokerHttpBaseUrl: string;
  readonly #codexHome: string;
  readonly #runtimeHome: string;
  readonly #port: number;
  readonly #openAiApiKey: string | undefined;
  readonly #authJsonPath: string | undefined;
  readonly #hostCodexHomePath: string | undefined;
  readonly #hostGeminiHomePath: string | undefined;
  readonly #disabledMcpServers: string[];
  readonly #tempadLinkServiceUrl: string | undefined;
  readonly #geminiHttpProxy: string | undefined;
  readonly #geminiHttpsProxy: string | undefined;
  readonly #geminiAllProxy: string | undefined;
  #child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  #homePrepared = false;

  constructor(options: {
    readonly brokerHttpBaseUrl: string;
    readonly codexHome: string;
    readonly port: number;
    readonly openAiApiKey?: string | undefined;
    readonly authJsonPath?: string | undefined;
    readonly hostCodexHomePath?: string | undefined;
    readonly hostGeminiHomePath?: string | undefined;
    readonly disabledMcpServers?: string[] | undefined;
    readonly tempadLinkServiceUrl?: string | undefined;
    readonly geminiHttpProxy?: string | undefined;
    readonly geminiHttpsProxy?: string | undefined;
    readonly geminiAllProxy?: string | undefined;
  }) {
    this.#brokerHttpBaseUrl = options.brokerHttpBaseUrl;
    this.#codexHome = options.codexHome;
    this.#runtimeHome = path.join(path.dirname(options.codexHome), "runtime-home");
    this.#port = options.port;
    this.#openAiApiKey = options.openAiApiKey;
    this.#authJsonPath = options.authJsonPath;
    this.#hostCodexHomePath = options.hostCodexHomePath;
    this.#hostGeminiHomePath = options.hostGeminiHomePath;
    this.#disabledMcpServers = options.disabledMcpServers ?? [];
    this.#tempadLinkServiceUrl = options.tempadLinkServiceUrl;
    this.#geminiHttpProxy = options.geminiHttpProxy;
    this.#geminiHttpsProxy = options.geminiHttpsProxy;
    this.#geminiAllProxy = options.geminiAllProxy;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.#port}`;
  }

  async start(options?: {
    readonly reuseExisting?: boolean | undefined;
  }): Promise<void> {
    if (this.#child) {
      return;
    }

    if (options?.reuseExisting ?? true) {
      const existingPids = await listListeningPortPids(this.#port);
      if (existingPids.length > 0 && await isHealthyCodexAppServer(this.#port)) {
        logger.warn("Reusing existing codex app-server listener", {
          port: this.#port,
          pids: existingPids
        });
        return;
      }
    }

    await this.#prepareCodexHome();
    await this.#bootstrapAuth();
    await this.#disableConfiguredMcpServers();
    await this.#ensureGitCommitHook();
    const tempadLinkServiceUrl = await this.#resolveTempadLinkServiceUrl();

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_HOME: this.#codexHome,
      HOME: this.#runtimeHome,
      BROKER_API_BASE: this.#brokerHttpBaseUrl,
      TEMPAD_LINK_SERVICE_URL: tempadLinkServiceUrl,
      BROKER_GIT_COAUTHOR_HELPER:
        process.env.BROKER_GIT_COAUTHOR_HELPER?.trim() || resolveRuntimeToolPath("git-coauthor.js"),
      BROKER_GEMINI_UI_HELPER:
        process.env.BROKER_GEMINI_UI_HELPER?.trim() || resolveRuntimeToolPath("gemini-ui.js")
    };

    if (this.#geminiHttpProxy) {
      env.BROKER_GEMINI_HTTP_PROXY = this.#geminiHttpProxy;
    }

    if (this.#geminiHttpsProxy) {
      env.BROKER_GEMINI_HTTPS_PROXY = this.#geminiHttpsProxy;
    }

    if (this.#geminiAllProxy) {
      env.BROKER_GEMINI_ALL_PROXY = this.#geminiAllProxy;
    }

    if (this.#openAiApiKey) {
      env.OPENAI_API_KEY = this.#openAiApiKey;
    }

    await this.#startProcess(env, true);
  }

  async restart(): Promise<void> {
    await this.stop();
    await reclaimPortListeners(this.#port, [process.pid]);
    await this.start({
      reuseExisting: false
    });
  }

  async stop(): Promise<void> {
    if (!this.#child) {
      return;
    }

    const child = this.#child;
    this.#child = undefined;
    await stopChildProcess(child);
  }

  async #startProcess(env: NodeJS.ProcessEnv, allowPortRecovery: boolean): Promise<void> {
    this.#child = spawn("codex", ["app-server", "--listen", this.url], {
      detached: true,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const child = this.#child;

    child.once("exit", (code, signal) => {
      logger.warn("codex app-server process exited", {
        code,
        signal: signal ?? null
      });

      if (this.#child === child) {
        this.#child = undefined;
      }
    });

    try {
      await waitForAppServerListen(child);
    } catch (error) {
      if (this.#child === child) {
        this.#child = undefined;
      }
      await stopChildProcess(child);

      if (allowPortRecovery && isAddressInUseStartupError(error)) {
        logger.warn("codex app-server port is occupied; reclaiming stale listener and retrying", {
          port: this.#port,
          error: error instanceof Error ? error.message : String(error)
        });
        await reclaimPortListeners(this.#port, [child.pid, process.pid]);
        await this.#startProcess(env, false);
        return;
      }

      throw error;
    }
  }

  async #prepareCodexHome(): Promise<void> {
    if (this.#homePrepared) {
      return;
    }

    await ensureDir(this.#codexHome);
    await syncUserCodexHome({
      codexHome: this.#codexHome,
      hostCodexHomePath: this.#hostCodexHomePath,
      runtimeHomePath: this.#runtimeHome,
      legacyPersonalMemoryPath:
        path.resolve(this.#runtimeHome) === path.resolve(os.homedir())
        ? undefined
          : path.join(os.homedir(), ".codex", "AGENT.md")
    });
    await syncGeminiHome({
      runtimeHomePath: this.#runtimeHome,
      hostGeminiHomePath: this.#hostGeminiHomePath
    });
    this.#homePrepared = true;
  }

  async #bootstrapAuth(): Promise<void> {
    const authTarget = path.join(this.#codexHome, "auth.json");

    if (await fileExists(authTarget)) {
      return;
    }

    const candidatePaths = [
      this.#authJsonPath,
      path.join(os.homedir(), ".codex", "auth.json")
    ].filter((value): value is string => Boolean(value));

    for (const candidate of candidatePaths) {
      if (await fileExists(candidate)) {
        await fs.copyFile(candidate, authTarget);
        return;
      }
    }
  }

  async #ensureGitCommitHook(): Promise<void> {
    const hooksDir = path.join(this.#runtimeHome, ".config", "git", "hooks");
    await ensureDir(hooksDir);

    const hookPath = path.join(hooksDir, "commit-msg");
    const hookScript = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "if [ -z \"${BROKER_GIT_COAUTHOR_HELPER:-}\" ]; then",
      "  exit 0",
      "fi",
      "node \"$BROKER_GIT_COAUTHOR_HELPER\" commit-msg \"$1\""
    ].join("\n");
    await fs.writeFile(hookPath, `${hookScript}\n`, { mode: 0o755 });
    await fs.chmod(hookPath, 0o755);
    await this.#runGit(["config", "--global", "core.hooksPath", hooksDir]);
  }

  async #disableConfiguredMcpServers(): Promise<void> {
    if (this.#disabledMcpServers.length === 0) {
      return;
    }

    const configuredServers = await this.#listConfiguredMcpServers();
    const namesToDisable = this.#disabledMcpServers.includes(ALL_MCP_SERVERS)
      ? [...configuredServers]
      : this.#disabledMcpServers.filter((name) => configuredServers.has(name));

    for (const name of namesToDisable) {
      try {
        await this.#runCodex(["mcp", "remove", name]);
        logger.info("Removed disabled MCP server from broker Codex config", { name });
      } catch (error) {
        logger.warn("Failed to remove disabled MCP server from broker Codex config", {
          name,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  async #listConfiguredMcpServers(): Promise<Set<string>> {
    try {
      const output = await this.#runCodex(["mcp", "list", "--json"]);
      const parsed = JSON.parse(output) as Array<{ name?: string }>;
      return new Set(parsed.map((entry) => entry.name).filter((value): value is string => Boolean(value)));
    } catch (error) {
      logger.warn("Failed to list configured MCP servers", {
        error: error instanceof Error ? error.message : String(error)
      });
      return new Set();
    }
  }

  async #runCodex(args: string[]): Promise<string> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_HOME: this.#codexHome,
      HOME: this.#runtimeHome
    };

    if (this.#openAiApiKey) {
      env.OPENAI_API_KEY = this.#openAiApiKey;
    }

    return await new Promise<string>((resolve, reject) => {
      const child = spawn("codex", args, {
        env,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) {
          resolve(stdout);
          return;
        }

        reject(new Error(`codex ${args.join(" ")} failed with code ${code ?? "null"}: ${stderr || stdout}`));
      });
    });
  }

  async #runGit(args: string[]): Promise<string> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: this.#runtimeHome
    };

    return await new Promise<string>((resolve, reject) => {
      const child = spawn("git", args, {
        env,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) {
          resolve(stdout);
          return;
        }

        reject(new Error(`git ${args.join(" ")} failed with code ${code ?? "null"}: ${stderr || stdout}`));
      });
    });
  }

  async #resolveTempadLinkServiceUrl(): Promise<string> {
    const candidates = uniqueStrings([
      this.#tempadLinkServiceUrl,
      "http://host.docker.internal:4318",
      "http://host.docker.internal:4320"
    ]);

    for (const candidate of candidates) {
      if (await isHealthyHttpService(candidate)) {
        logger.info("Selected tempad link service url", { url: candidate });
        return candidate;
      }
    }

    const fallback = candidates[0] ?? "http://host.docker.internal:4320";
    logger.warn("Failed to find a healthy tempad link service; falling back to first candidate", {
      url: fallback,
      attemptedCandidates: candidates
    });
    return fallback;
  }
}

function killChildProcessGroup(
  child: ChildProcessByStdio<null, Readable, Readable>,
  signal: NodeJS.Signals
): void {
  if (typeof child.pid !== "number") {
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // ignore best-effort shutdown failures here; callers already handle timeouts
    }
  }
}

async function stopChildProcess(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  killChildProcessGroup(child, "SIGTERM");
  const exitedOnSigterm = await waitForChildExit(child, 5_000);
  if (exitedOnSigterm) {
    return;
  }

  logger.warn("codex app-server did not exit after SIGTERM; sending SIGKILL");
  killChildProcessGroup(child, "SIGKILL");
  const exitedOnSigkill = await waitForChildExit(child, 2_000);
  if (exitedOnSigkill) {
    return;
  }

  logger.warn("codex app-server did not exit after SIGKILL timeout");
}

async function waitForChildExit(
  child: ChildProcessByStdio<null, Readable, Readable>,
  timeoutMs: number
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);

    const onExit = () => {
      cleanup();
      resolve(true);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", onExit);
    };

    child.once("exit", onExit);
  });
}

async function waitForAppServerListen(
  child: ChildProcessByStdio<null, Readable, Readable>
): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    let stdoutTail = "";
    let stderrTail = "";
    let startupComplete = false;
    const timeout = setTimeout(() => {
      cleanup({
        removeStreamListeners: true
      });
      reject(
        new Error(
          `Timed out waiting for codex app-server to start${formatStartupDetails(stdoutTail, stderrTail)}`
        )
      );
    }, 15_000);

    const cleanup = (options?: {
      readonly removeStreamListeners?: boolean;
    }) => {
      clearTimeout(timeout);
      child.off("exit", onStartupExit);

      if (options?.removeStreamListeners) {
        child.stdout.off("data", onStdout);
        child.stderr.off("data", onStderr);
      }
    };

    const finishStartup = () => {
      if (startupComplete) {
        return;
      }

      startupComplete = true;
      // Keep draining stdout/stderr after the startup banner so later app-server
      // transport warnings (for example websocket disconnect reasons) are not
      // lost and the child cannot block on a full pipe.
      cleanup();
      child.once("exit", onPostStartupExit);
      resolve();
    };

    const onStdout = (chunk: Buffer): void => {
      const text = chunk.toString();
      stdoutTail = `${stdoutTail}${text}`.slice(-8_000);
      logger.debug("codex app-server stdout", { text });
      if (text.includes("listening on:")) {
        finishStartup();
      }
    };

    const onStderr = (chunk: Buffer): void => {
      const text = chunk.toString();
      stderrTail = `${stderrTail}${text}`.slice(-8_000);
      logger.warn("codex app-server stderr", { text });
      if (text.includes("listening on:")) {
        finishStartup();
      }
    };

    const onPostStartupExit = () => {
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onPostStartupExit);
    };

    const onStartupExit = (code: number | null) => {
      cleanup({
        removeStreamListeners: true
      });
      reject(
        new Error(
          `codex app-server exited early with code ${code ?? "null"}${formatStartupDetails(stdoutTail, stderrTail)}`
        )
      );
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onStartupExit);
  });
}

function formatStartupDetails(stdoutTail: string, stderrTail: string): string {
  const details = (stderrTail || stdoutTail).trim();
  return details ? `: ${details}` : "";
}

function isAddressInUseStartupError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /address already in use|EADDRINUSE|os error 48/i.test(message);
}

async function reclaimPortListeners(port: number, excludedPids: readonly (number | undefined)[]): Promise<void> {
  const excluded = new Set(excludedPids.filter((pid): pid is number => typeof pid === "number"));

  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const pids = (await listListeningPortPids(port)).filter((pid) => !excluded.has(pid));
    if (pids.length === 0) {
      return;
    }

    logger.warn("Killing stale listener on codex app-server port", {
      port,
      signal,
      pids
    });

    for (const pid of pids) {
      try {
        process.kill(pid, signal);
      } catch {
        // best-effort cleanup
      }
    }

    await delay(500);
  }
}

async function listListeningPortPids(port: number): Promise<number[]> {
  try {
    const output = await runCommandCapture("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    return parsePidList(output);
  } catch {
    try {
      const output = await runCommandCapture("ps", ["-axo", "pid=,command="]);
      return parseCodexAppServerPidsFromPsOutput(output, port);
    } catch {
      return [];
    }
  }
}

function parsePidList(output: string): number[] {
  return [...new Set(
    output
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value) && value > 0)
  )];
}

function parseCodexAppServerPidsFromPsOutput(output: string, port: number): number[] {
  const listenPatterns = [
    `app-server --listen ws://127.0.0.1:${port}`,
    `app-server --listen ws://localhost:${port}`
  ];

  return [...new Set(
    output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => listenPatterns.some((pattern) => line.includes(pattern)))
      .map((line) => Number.parseInt(line.split(/\s+/, 2)[0] ?? "", 10))
      .filter((value) => Number.isInteger(value) && value > 0)
  )];
}

async function runCommandCapture(command: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} failed with code ${code ?? "null"}: ${stderr || stdout}`));
    });
  });
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function isHealthyHttpService(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/health", baseUrl), {
      signal: AbortSignal.timeout(3_000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function isHealthyCodexAppServer(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
      signal: AbortSignal.timeout(1_000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

function uniqueStrings(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
