import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import { logger } from "../../logger.js";
import { ensureDir, fileExists } from "../../utils/fs.js";
import { syncUserCodexHome } from "./codex-home.js";

export class AppServerProcess {
  readonly #codexHome: string;
  readonly #runtimeHome: string;
  readonly #port: number;
  readonly #openAiApiKey: string | undefined;
  readonly #authJsonPath: string | undefined;
  readonly #hostCodexHomePath: string | undefined;
  readonly #disabledMcpServers: string[];
  #child: ChildProcessByStdio<null, Readable, Readable> | undefined;

  constructor(options: {
    readonly codexHome: string;
    readonly port: number;
    readonly openAiApiKey?: string | undefined;
    readonly authJsonPath?: string | undefined;
    readonly hostCodexHomePath?: string | undefined;
    readonly disabledMcpServers?: string[] | undefined;
  }) {
    this.#codexHome = options.codexHome;
    this.#runtimeHome = path.join(path.dirname(options.codexHome), "runtime-home");
    this.#port = options.port;
    this.#openAiApiKey = options.openAiApiKey;
    this.#authJsonPath = options.authJsonPath;
    this.#hostCodexHomePath = options.hostCodexHomePath;
    this.#disabledMcpServers = options.disabledMcpServers ?? [];
  }

  get url(): string {
    return `ws://127.0.0.1:${this.#port}`;
  }

  async start(): Promise<void> {
    if (this.#child) {
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
    await this.#bootstrapAuth();
    await this.#disableConfiguredMcpServers();

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_HOME: this.#codexHome,
      HOME: this.#runtimeHome
    };

    if (this.#openAiApiKey) {
      env.OPENAI_API_KEY = this.#openAiApiKey;
    }

    this.#child = spawn("codex", ["app-server", "--listen", this.url], {
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

    const waitForListen = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for codex app-server to start"));
      }, 15_000);

      const onData = (chunk: Buffer): void => {
        const text = chunk.toString();
        logger.debug("codex app-server stdout", { text });
        if (text.includes("listening on:")) {
          clearTimeout(timeout);
          resolve();
        }
      };

      const onError = (chunk: Buffer): void => {
        const text = chunk.toString();
        logger.warn("codex app-server stderr", { text });
        if (text.includes("listening on:")) {
          clearTimeout(timeout);
          resolve();
        }
      };

      child.stdout.on("data", onData);
      child.stderr.on("data", onError);
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`codex app-server exited early with code ${code ?? "null"}`));
      });
    });

    await waitForListen;
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async stop(): Promise<void> {
    if (!this.#child) {
      return;
    }

    const child = this.#child;
    this.#child = undefined;

    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    child.kill("SIGTERM");
    const exitedOnSigterm = await waitForChildExit(child, 5_000);
    if (exitedOnSigterm) {
      return;
    }

    logger.warn("codex app-server did not exit after SIGTERM; sending SIGKILL");
    child.kill("SIGKILL");
    const exitedOnSigkill = await waitForChildExit(child, 2_000);
    if (exitedOnSigkill) {
      return;
    }

    logger.warn("codex app-server did not exit after SIGKILL timeout");
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

  async #disableConfiguredMcpServers(): Promise<void> {
    if (this.#disabledMcpServers.length === 0) {
      return;
    }

    const credentials = await this.#readStoredOauthServerNames();
    const configuredServers = await this.#listConfiguredMcpServers();
    const namesToDisable = this.#disabledMcpServers.filter((name) => configuredServers.has(name) && !credentials.has(name));

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

  async #readStoredOauthServerNames(): Promise<Set<string>> {
    const credentialsPath = path.join(this.#codexHome, ".credentials.json");
    if (!(await fileExists(credentialsPath))) {
      return new Set();
    }

    try {
      const raw = await fs.readFile(credentialsPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, { server_name?: string }>;
      const names = Object.values(parsed)
        .map((entry) => entry?.server_name)
        .filter((value): value is string => Boolean(value));
      return new Set(names);
    } catch (error) {
      logger.warn("Failed to read broker MCP credentials file", {
        error: error instanceof Error ? error.message : String(error)
      });
      return new Set();
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
