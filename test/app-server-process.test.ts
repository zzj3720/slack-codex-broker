import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AppServerProcess } from "../src/services/codex/app-server-process.js";

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
    const hostCodexHomePath = path.join(tempRoot, "host-codex-home");
    const hostGeminiHomePath = path.join(tempRoot, "host-gemini-home");
    const codexHome = path.join(tempRoot, "codex-home");
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

    await fs.writeFile(
      fakeCodexPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "if [ \"${1:-}\" = \"app-server\" ]; then",
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
    await fs.chmod(fakeCodexPath, 0o755);

    process.env.PATH = `${fakeBinDir}:${originalPath ?? ""}`;

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
    } finally {
      await processManager.stop().catch(() => {});
      await tempadServer.close().catch(() => {});
      await fs.rm(tempRoot, {
        force: true,
        recursive: true
      });
    }

    expect(observedWrites.join("")).toContain(
      "disconnecting slow connection after outbound queue filled: ConnectionId(1)"
    );
  });
});
