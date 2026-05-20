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

  it("uses the selected bound account as the default PR identity for unbound initiators", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-pr-identity-"));
    cleanups.push(async () => fs.rm(stateDir, { recursive: true, force: true }));
    const service = new GitHubPrIdentityService({
      stateDir,
      defaultGitHubLogin: "legacy-bot",
      defaultGitHubToken: "legacy-token"
    });
    await service.load();

    await service.upsertBinding({
      slackUserId: "U_DEFAULT",
      githubLogin: "default-user",
      githubUserId: 202,
      token: "default-user-token",
      scopes: ["repo"]
    });
    await expect(service.setDefaultBinding("U_DEFAULT")).resolves.toMatchObject({
      available: true,
      source: "bound",
      slackUserId: "U_DEFAULT",
      githubLogin: "default-user"
    });

    await expect(service.resolveTokenForSession({
      session: session({ initiatorUserId: "U_UNBOUND" }),
      command: ["pr", "create"]
    })).resolves.toMatchObject({
      ok: true,
      mode: "default",
      defaultSource: "bound",
      slackUserId: "U_DEFAULT",
      githubLogin: "default-user",
      token: "default-user-token",
      reason: "initiator_unbound"
    });

    const reloaded = new GitHubPrIdentityService({
      stateDir,
      defaultGitHubLogin: "legacy-bot",
      defaultGitHubToken: "legacy-token"
    });
    await reloaded.load();
    expect(reloaded.getSessionIdentityStatus(session({ initiatorUserId: "U_UNBOUND" })).defaultAccount).toMatchObject({
      available: true,
      source: "bound",
      slackUserId: "U_DEFAULT",
      githubLogin: "default-user"
    });
  });

  it("rejects unbound or revoked bindings as the selected default PR account", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-pr-identity-"));
    cleanups.push(async () => fs.rm(stateDir, { recursive: true, force: true }));
    const service = new GitHubPrIdentityService({ stateDir });
    await service.load();

    await expect(service.setDefaultBinding("U_MISSING")).rejects.toThrow("Cannot set default GitHub PR account to an unbound Slack user.");

    await service.upsertBinding({
      slackUserId: "U_REVOKED",
      githubLogin: "revoked-user",
      githubUserId: 303,
      token: "revoked-token",
      scopes: ["repo"],
      revokedAt: "2026-05-13T00:00:00.000Z"
    });

    await expect(service.setDefaultBinding("U_REVOKED")).rejects.toThrow("Cannot set default GitHub PR account to a revoked binding.");
  });

  it("blocks when the selected default binding becomes revoked instead of using the legacy env fallback", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-pr-identity-"));
    cleanups.push(async () => fs.rm(stateDir, { recursive: true, force: true }));
    const service = new GitHubPrIdentityService({
      stateDir,
      defaultGitHubLogin: "legacy-bot",
      defaultGitHubToken: "legacy-token"
    });
    await service.load();

    await service.upsertBinding({
      slackUserId: "U_DEFAULT",
      githubLogin: "default-user",
      githubUserId: 202,
      token: "default-user-token",
      scopes: ["repo"]
    });
    await service.setDefaultBinding("U_DEFAULT");
    await service.upsertBinding({
      slackUserId: "U_DEFAULT",
      githubLogin: "default-user",
      githubUserId: 202,
      token: "default-user-token",
      scopes: ["repo"],
      revokedAt: "2026-05-13T00:00:00.000Z"
    });

    await expect(service.resolveTokenForSession({
      session: session({ initiatorUserId: "U_UNBOUND" }),
      command: ["pr", "create"]
    })).resolves.toMatchObject({
      ok: false,
      mode: "blocked",
      reason: "default_account_unavailable",
      slackUserId: "U_DEFAULT",
      githubLogin: "default-user"
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

	  it("binds a Slack user through isolated GitHub CLI device login", async () => {
	    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-pr-identity-"));
	    cleanups.push(async () => fs.rm(stateDir, { recursive: true, force: true }));
	    const ghConfigPathFile = path.join(stateDir, "fake-gh-config-path");
	    const ghLoginEnvFile = path.join(stateDir, "fake-gh-login-env.json");
	    const fakeGhPath = path.join(stateDir, "fake-gh.sh");
	    const previousGhToken = process.env.GH_TOKEN;
	    const previousGitHubToken = process.env.GITHUB_TOKEN;
	    process.env.GH_TOKEN = "global-gh-token";
	    process.env.GITHUB_TOKEN = "global-github-token";
	    cleanups.push(async () => {
	      if (previousGhToken === undefined) {
	        delete process.env.GH_TOKEN;
	      } else {
	        process.env.GH_TOKEN = previousGhToken;
	      }
	      if (previousGitHubToken === undefined) {
	        delete process.env.GITHUB_TOKEN;
	      } else {
	        process.env.GITHUB_TOKEN = previousGitHubToken;
	      }
	    });
	    await fs.writeFile(fakeGhPath, `#!/bin/sh
	set -eu
	if [ "$1 $2" = "auth login" ]; then
	  printf "%s" "$GH_CONFIG_DIR" > ${JSON.stringify(ghConfigPathFile)}
	  printf '{"ghToken":"%s","githubToken":"%s","ghConfigDir":"%s"}' "\${GH_TOKEN-}" "\${GITHUB_TOKEN-}" "$GH_CONFIG_DIR" > ${JSON.stringify(ghLoginEnvFile)}
	  echo "! First copy your one-time code: ABCD-EFGH"
	  echo "Open this URL to continue in your web browser: https://github.com/login/device"
	  while [ ! -f "$GH_CONFIG_DIR/complete" ]; do sleep 0.05; done
  exit 0
fi
if [ "$1 $2" = "auth status" ]; then
  echo '{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com","login":"alice","scopes":"repo, read:user, user:email","gitProtocol":"https"}]}}'
  exit 0
fi
if [ "$1 $2" = "auth token" ]; then
  echo "user-token"
  exit 0
fi
echo "unexpected gh args: $*" >&2
exit 2
`);
    await fs.chmod(fakeGhPath, 0o755);
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/user") {
        expect(request.headers.authorization).toBe("Bearer user-token");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: 42, login: "alice", name: "Alice Example", email: null }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/user/emails") {
        expect(request.headers.authorization).toBe("Bearer user-token");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify([
          { email: "secondary@example.com", primary: false, verified: true },
          { email: "alice@example.com", primary: true, verified: true }
        ]));
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
      githubApiBaseUrl: baseUrl,
      ghPath: fakeGhPath
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

	    const ghConfigDir = await fs.readFile(ghConfigPathFile, "utf8");
	    await expect(fs.readFile(ghLoginEnvFile, "utf8").then(JSON.parse)).resolves.toMatchObject({
	      ghToken: "",
	      githubToken: "",
	      ghConfigDir
	    });
	    await fs.writeFile(path.join(ghConfigDir, "complete"), "ok");
    let completed: unknown;
    for (let index = 0; index < 20; index += 1) {
      const result = await service.pollDeviceAuthorization(started.id);
      if (result.status === "completed") {
        completed = result;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(completed).toMatchObject({
      status: "completed",
      binding: {
        slackUserId: "U_STARTER",
        githubLogin: "alice",
        githubUserId: 42,
        githubEmail: "alice@example.com",
        githubName: "Alice Example"
      }
    });
    await expect(service.getBinding("U_STARTER")).resolves.toMatchObject({
      token: "user-token",
      scopes: ["repo", "read:user", "user:email"],
      githubEmail: "alice@example.com"
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
