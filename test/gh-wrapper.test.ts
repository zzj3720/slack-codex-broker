import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import { runGhWrapper } from "../src/tools/gh.js";

describe("broker gh wrapper", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) {
      await cleanups.pop()?.();
    }
  });

  it("asks the broker for the current session token and execs the real gh with GH_TOKEN", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "broker-gh-wrapper-"));
    cleanups.push(async () => fs.rm(tempRoot, { recursive: true, force: true }));
    const capturePath = path.join(tempRoot, "capture.json");
    const realGhPath = path.join(tempRoot, "real-gh.mjs");
    await fs.writeFile(realGhPath, [
      "#!/usr/bin/env node",
      "import fs from 'node:fs/promises';",
      "await fs.writeFile(process.env.CAPTURE_PATH, JSON.stringify({",
      "  argv: process.argv.slice(2),",
      "  ghToken: process.env.GH_TOKEN,",
      "  cwd: process.cwd()",
      "}));"
    ].join("\n"));
    await fs.chmod(realGhPath, 0o755);

    let resolveRequest: Record<string, unknown> | undefined;
    const server = http.createServer(async (request, response) => {
      if (request.method !== "POST" || request.url !== "/slack/github-token/resolve") {
        response.writeHead(404);
        response.end();
        return;
      }
      let body = "";
      for await (const chunk of request) {
        body += chunk;
      }
      resolveRequest = JSON.parse(body) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        mode: "initiator",
        githubLogin: "alice",
        token: "starter-token"
      }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(async () => new Promise<void>((resolve) => server.close(() => resolve())));

    const result = await runGhWrapper({
      brokerApiBase: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      realGhPath,
      cwd: tempRoot,
      argv: ["pr", "create", "--fill"],
      env: {
        ...process.env,
        CAPTURE_PATH: capturePath
      }
    });

    expect(result.status).toBe(0);
    expect(resolveRequest).toMatchObject({
      cwd: tempRoot,
      command: ["pr", "create", "--fill"]
    });
    const realTempRoot = await fs.realpath(tempRoot);
    await expect(fs.readFile(capturePath, "utf8").then(JSON.parse)).resolves.toMatchObject({
      argv: ["pr", "create", "--fill"],
      ghToken: "starter-token",
      cwd: realTempRoot
    });
  });

  it("does not call the real gh when broker token resolution blocks", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "broker-gh-wrapper-"));
    cleanups.push(async () => fs.rm(tempRoot, { recursive: true, force: true }));
    const realGhPath = path.join(tempRoot, "real-gh.mjs");
    await fs.writeFile(realGhPath, [
      "#!/usr/bin/env node",
      "throw new Error('real gh should not run');"
    ].join("\n"));
    await fs.chmod(realGhPath, 0o755);

    const server = http.createServer((request, response) => {
      if (request.method !== "POST" || request.url !== "/slack/github-token/resolve") {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(409, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: false,
        mode: "blocked",
        reason: "initiator_token_invalid",
        message: "GitHub token for alice is invalid."
      }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(async () => new Promise<void>((resolve) => server.close(() => resolve())));

    const result = await runGhWrapper({
      brokerApiBase: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      realGhPath,
      cwd: tempRoot,
      argv: ["pr", "create"],
      env: process.env
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("GitHub token for alice is invalid.");
  });
});
