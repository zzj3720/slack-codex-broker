import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import { GitHubPrIdentityService } from "../src/services/github-pr-identity-service.js";
import type { SlackSessionRecord } from "../src/types.js";

describe("GitHubPrIdentityService", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) {
      await cleanups.pop()?.();
    }
  });

  it("resolves session PR identity from the bound initiator before falling back to the default account", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-pr-identity-"));
    cleanups.push(async () => fs.rm(stateDir, { recursive: true, force: true }));
    const service = new GitHubPrIdentityService({
      stateDir,
      defaultGitHubLogin: "default-bot",
      defaultGitHubToken: "default-token"
    });
    await service.load();

    await service.upsertBinding({
      slackUserId: "U_STARTER",
      githubLogin: "alice",
      githubUserId: 101,
      token: "alice-token",
      scopes: ["repo"]
    });

    await expect(service.resolveTokenForSession({
      session: session({ initiatorUserId: "U_STARTER" }),
      command: ["pr", "create"]
    })).resolves.toMatchObject({
      ok: true,
      mode: "initiator",
      slackUserId: "U_STARTER",
      githubLogin: "alice",
      token: "alice-token"
    });

    await expect(service.resolveTokenForSession({
      session: session({ initiatorUserId: "U_UNBOUND" }),
      command: ["pr", "create"]
    })).resolves.toMatchObject({
      ok: true,
      mode: "default",
      githubLogin: "default-bot",
      token: "default-token",
      reason: "initiator_unbound"
    });
  });

  it("blocks instead of silently falling back when the initiator binding is revoked", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-pr-identity-"));
    cleanups.push(async () => fs.rm(stateDir, { recursive: true, force: true }));
    const service = new GitHubPrIdentityService({
      stateDir,
      defaultGitHubLogin: "default-bot",
      defaultGitHubToken: "default-token"
    });
    await service.load();

    await service.upsertBinding({
      slackUserId: "U_STARTER",
      githubLogin: "alice",
      githubUserId: 101,
      token: "alice-token",
      scopes: ["repo"],
      revokedAt: "2026-05-13T00:00:00.000Z"
    });

    await expect(service.resolveTokenForSession({
      session: session({ initiatorUserId: "U_STARTER" }),
      command: ["pr", "create"]
    })).resolves.toMatchObject({
      ok: false,
      mode: "blocked",
      reason: "initiator_token_invalid",
      githubLogin: "alice"
    });
  });

  it("binds a Slack user through GitHub device code OAuth", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-pr-identity-"));
    cleanups.push(async () => fs.rm(stateDir, { recursive: true, force: true }));
    let accessPollCount = 0;
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "POST" && url.pathname === "/login/device/code") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          device_code: "device-1",
          user_code: "ABCD-EFGH",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 1
        }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/login/oauth/access_token") {
        accessPollCount += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(accessPollCount === 1
          ? JSON.stringify({ error: "authorization_pending" })
          : JSON.stringify({ access_token: "user-token", scope: "repo,read:user", token_type: "bearer" }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/user") {
        expect(request.headers.authorization).toBe("Bearer user-token");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: 42, login: "alice" }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(async () => new Promise<void>((resolve) => server.close(() => resolve())));
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const service = new GitHubPrIdentityService({
      stateDir,
      githubOAuthClientId: "client-1",
      githubOAuthBaseUrl: `${baseUrl}/login/oauth`,
      githubApiBaseUrl: baseUrl
    });
    await service.load();

    const started = await service.startDeviceAuthorization({
      slackUserId: "U_STARTER"
    });
    expect(started).toMatchObject({
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device"
    });

    await expect(service.pollDeviceAuthorization(started.id)).resolves.toMatchObject({
      status: "pending"
    });
    await expect(service.pollDeviceAuthorization(started.id)).resolves.toMatchObject({
      status: "completed",
      binding: {
        slackUserId: "U_STARTER",
        githubLogin: "alice",
        githubUserId: 42
      }
    });
    await expect(service.getBinding("U_STARTER")).resolves.toMatchObject({
      token: "user-token",
      scopes: ["repo", "read:user"]
    });
  });
});

function session(patch: Partial<SlackSessionRecord>): SlackSessionRecord {
  return {
    key: "C123:111.222",
    channelId: "C123",
    rootThreadTs: "111.222",
    workspacePath: "/tmp/session",
    createdAt: "2026-05-13T00:00:00.000Z",
    updatedAt: "2026-05-13T00:00:00.000Z",
    ...patch
  };
}
