import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AppServerProcess,
  parseCodexAppServerPidsFromPsOutput
} from "../src/services/codex/app-server-process.js";

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function startHealthyHttpServer(): Promise<{
  readonly close: () => Promise<void>;
  readonly url: string;
}> {
  const server = http.createServer((_request, response) => {
    response.statusCode = 200;
    response.end("ok");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine tempad test server address");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      })
  };
}

describe("AppServerProcess", () => {
  let originalPath = process.env.PATH;

  afterEach(() => {
    process.env.PATH = originalPath;
    vi.restoreAllMocks();
  });

  it("continues draining app-server stderr after startup", async () => {
    originalPath = process.env.PATH;

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "broker-app-server-process-"));
    const tempadServer = await startHealthyHttpServer();
	    const fakeBinDir = path.join(tempRoot, "bin");
	    const fakeCodexPath = path.join(fakeBinDir, "codex");
	    const fakeGitPath = path.join(fakeBinDir, "git");
	    const fakeGhPath = path.join(fakeBinDir, "gh");
	    const argsFile = path.join(tempRoot, "codex-args.txt");
	    const hostCodexHomePath = path.join(tempRoot, "host-codex-home");
	    const hostGeminiHomePath = path.join(tempRoot, "host-gemini-home");
	    const codexHome = path.join(tempRoot, "codex-home");
	    const operatorHome = path.join(tempRoot, "operator-home");
	    const previousHome = process.env.HOME;
	    const observedWrites: string[] = [];

    await fs.mkdir(fakeBinDir, {
      recursive: true
    });
    await fs.mkdir(hostCodexHomePath, {
      recursive: true
    });
	    await fs.mkdir(hostGeminiHomePath, {
	      recursive: true
	    });
	    await fs.mkdir(operatorHome, {
	      recursive: true
	    });

	    await fs.writeFile(
	      fakeCodexPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "if [ \"${1:-}\" = \"app-server\" ]; then",
        `  printf '%s\\n' "$@" > ${shellQuote(argsFile)}`,
        "  printf '%s\\n' 'codex app-server (WebSockets)' >&2",
        "  printf '%s\\n' '  listening on: ws://127.0.0.1:4590' >&2",
        "  sleep 0.1",
        "  printf '%s\\n' 'disconnecting slow connection after outbound queue filled: ConnectionId(1)' >&2",
        "  while true; do",
        "    sleep 1",
        "  done",
        "fi",
        "printf 'unexpected fake codex args: %s\\n' \"$*\" >&2",
        "exit 1",
        ""
      ].join("\n"),
      {
        mode: 0o755
      }
	    );
	    await fs.writeFile(fakeGitPath, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
	    await fs.writeFile(fakeGhPath, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
	    await fs.chmod(fakeCodexPath, 0o755);
	    await fs.chmod(fakeGitPath, 0o755);
	    await fs.chmod(fakeGhPath, 0o755);

	    process.env.PATH = `${fakeBinDir}:${originalPath ?? ""}`;
	    process.env.HOME = operatorHome;

    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      observedWrites.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write);

    const processManager = new AppServerProcess({
      brokerHttpBaseUrl: "http://127.0.0.1:3001",
      codexHome,
      port: 4590,
      hostCodexHomePath,
      hostGeminiHomePath,
      tempadLinkServiceUrl: tempadServer.url
    });

    try {
      await processManager.start();
      await delay(300);
      const observedArgs = (await fs.readFile(argsFile, "utf8")).trim().split("\n");
      expect(observedArgs).toEqual([
        "app-server",
        "--disable",
        "apps",
        "--listen",
        "ws://127.0.0.1:4590"
      ]);
	    } finally {
	      await processManager.stop().catch(() => {});
	      await tempadServer.close().catch(() => {});
	      if (previousHome === undefined) {
	        delete process.env.HOME;
	      } else {
	        process.env.HOME = previousHome;
	      }
	      await fs.rm(tempRoot, {
	        force: true,
        recursive: true
      });
    }

    expect(observedWrites.join("")).toContain(
      "disconnecting slow connection after outbound queue filled: ConnectionId(1)"
    );
  });

  it("keeps per-profile CODEX_HOME but uses the VM HOME without leaking global GitHub tokens", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "broker-app-server-process-"));
    const tempadServer = await startHealthyHttpServer();
    const fakeBinDir = path.join(tempRoot, "bin");
    const fakeCodexPath = path.join(fakeBinDir, "codex");
    const fakeGitPath = path.join(fakeBinDir, "git");
    const fakeGhPath = path.join(fakeBinDir, "gh");
    const appEnvFile = path.join(tempRoot, "app-env.txt");
    const gitEnvFile = path.join(tempRoot, "git-env.txt");
    const operatorHome = path.join(tempRoot, "operator-home");
    const codexHome = path.join(tempRoot, "auth-profile-runtimes", "profile-a", "codex-home");
    const hostCodexHomePath = path.join(tempRoot, "host-codex-home");
    const hostGeminiHomePath = path.join(tempRoot, "host-gemini-home");
    const previousEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GH_TOKEN: process.env.GH_TOKEN,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      BROKER_DEFAULT_GITHUB_TOKEN: process.env.BROKER_DEFAULT_GITHUB_TOKEN
    };

    await fs.mkdir(fakeBinDir, { recursive: true });
    await fs.mkdir(operatorHome, { recursive: true });
    await fs.mkdir(hostCodexHomePath, { recursive: true });
    await fs.mkdir(hostGeminiHomePath, { recursive: true });

    await fs.writeFile(
      fakeCodexPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "if [ \"${1:-}\" = \"app-server\" ]; then",
        `  { printf 'HOME=%s\\n' "\${HOME-}"; printf 'CODEX_HOME=%s\\n' "\${CODEX_HOME-}"; printf 'GH_TOKEN=%s\\n' "\${GH_TOKEN-}"; printf 'GITHUB_TOKEN=%s\\n' "\${GITHUB_TOKEN-}"; printf 'BROKER_DEFAULT_GITHUB_TOKEN=%s\\n' "\${BROKER_DEFAULT_GITHUB_TOKEN-}"; } > ${shellQuote(appEnvFile)}`,
        "  printf '%s\\n' 'codex app-server (WebSockets)' >&2",
        "  printf '%s\\n' '  listening on: ws://127.0.0.1:4592' >&2",
        "  while true; do sleep 1; done",
        "fi",
        "printf 'unexpected fake codex args: %s\\n' \"$*\" >&2",
        "exit 1",
        ""
      ].join("\n"),
      { mode: 0o755 }
    );
    await fs.writeFile(
      fakeGitPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `printf 'HOME=%s\\nGH_TOKEN=%s\\nGITHUB_TOKEN=%s\\nBROKER_DEFAULT_GITHUB_TOKEN=%s\\n' "\${HOME-}" "\${GH_TOKEN-}" "\${GITHUB_TOKEN-}" "\${BROKER_DEFAULT_GITHUB_TOKEN-}" > ${shellQuote(gitEnvFile)}`,
        "exit 0",
        ""
      ].join("\n"),
      { mode: 0o755 }
    );
    await fs.writeFile(fakeGhPath, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    await fs.chmod(fakeCodexPath, 0o755);
    await fs.chmod(fakeGitPath, 0o755);
    await fs.chmod(fakeGhPath, 0o755);

    process.env.PATH = `${fakeBinDir}:${previousEnv.PATH ?? ""}`;
    process.env.HOME = operatorHome;
    process.env.GH_TOKEN = "global-gh-token";
    process.env.GITHUB_TOKEN = "global-github-token";
    process.env.BROKER_DEFAULT_GITHUB_TOKEN = "default-pr-token";

    const processManager = new AppServerProcess({
      brokerHttpBaseUrl: "http://127.0.0.1:3001",
      codexHome,
      port: 4592,
      hostCodexHomePath,
      hostGeminiHomePath,
      tempadLinkServiceUrl: tempadServer.url
    });

    try {
      await processManager.start();
      const appEnv = Object.fromEntries(
        (await fs.readFile(appEnvFile, "utf8"))
          .trim()
          .split("\n")
          .map((line) => line.split("=", 2))
      );
      const gitEnv = Object.fromEntries(
        (await fs.readFile(gitEnvFile, "utf8"))
          .trim()
          .split("\n")
          .map((line) => line.split("=", 2))
      );

      expect(appEnv).toMatchObject({
        HOME: operatorHome,
        CODEX_HOME: codexHome,
        GH_TOKEN: "",
        GITHUB_TOKEN: "",
        BROKER_DEFAULT_GITHUB_TOKEN: ""
      });
      expect(gitEnv).toMatchObject({
        HOME: operatorHome,
        GH_TOKEN: "",
        GITHUB_TOKEN: "",
        BROKER_DEFAULT_GITHUB_TOKEN: ""
      });
    } finally {
      await processManager.stop().catch(() => {});
      await tempadServer.close().catch(() => {});
      process.env.PATH = previousEnv.PATH;
      if (previousEnv.HOME === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousEnv.HOME;
      }
      if (previousEnv.GH_TOKEN === undefined) {
        delete process.env.GH_TOKEN;
      } else {
        process.env.GH_TOKEN = previousEnv.GH_TOKEN;
      }
      if (previousEnv.GITHUB_TOKEN === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = previousEnv.GITHUB_TOKEN;
      }
      if (previousEnv.BROKER_DEFAULT_GITHUB_TOKEN === undefined) {
        delete process.env.BROKER_DEFAULT_GITHUB_TOKEN;
      } else {
        process.env.BROKER_DEFAULT_GITHUB_TOKEN = previousEnv.BROKER_DEFAULT_GITHUB_TOKEN;
      }
      await fs.rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("finds app-server listeners in ps output when feature flags appear before --listen", () => {
    const output = [
      "123 /opt/homebrew/bin/codex app-server --disable apps --listen ws://127.0.0.1:4590",
      "124 /opt/homebrew/bin/codex app-server --listen ws://localhost:4590",
      "125 /opt/homebrew/bin/codex app-server --disable apps --listen ws://127.0.0.1:4591",
      "126 /opt/homebrew/bin/codex exec --listen ws://127.0.0.1:4590",
      "123 /opt/homebrew/bin/codex app-server --disable apps --listen ws://127.0.0.1:4590"
    ].join("\n");

    expect(parseCodexAppServerPidsFromPsOutput(output, 4590)).toEqual([123, 124]);
  });
});
