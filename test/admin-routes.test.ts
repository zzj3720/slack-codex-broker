import http from "node:http";
import vm from "node:vm";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createHttpHandler } from "../src/http/router.js";

describe("admin routes", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  async function startAdminServer(configEnv: NodeJS.ProcessEnv, adminService: Record<string, unknown>): Promise<string> {
    const config = loadConfig(configEnv);
    const server = http.createServer(
      createHttpHandler({
        adminService: adminService as never,
        bridge: {} as never,
        isolatedMcp: {} as never,
        jobManager: {} as never,
        config
      })
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to start test server");
    }
    return `http://127.0.0.1:${address.port}`;
  }

  it("requires the configured admin token for admin api requests", async () => {
    const baseUrl = await startAdminServer({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      BROKER_ADMIN_TOKEN: "secret-token"
    } as NodeJS.ProcessEnv, {
      getStatus: async () => ({ ok: true, status: "admin-ok" }),
      addAuthProfile: async () => ({ ok: true }),
      upsertGitHubAuthorMapping: async () => ({ ok: true }),
      deleteGitHubAuthorMapping: async () => ({ ok: true }),
      deleteAuthProfile: async () => ({ ok: true }),
      activateAuthProfile: async () => ({ ok: true }),
      deployWorker: async () => ({ ok: true }),
      rollbackWorker: async () => ({ ok: true })
    });

    const unauthorized = await fetch(`${baseUrl}/admin/api/status`);
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${baseUrl}/admin/api/status`, {
      headers: {
        "x-admin-token": "secret-token"
      }
    });
    expect(authorized.status).toBe(200);
    await expect(authorized.json()).resolves.toMatchObject({
      ok: true,
      status: "admin-ok"
    });
  });

  it("renders auth profile management and session console sections in the admin page", async () => {
    const baseUrl = await startAdminServer({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test"
    } as NodeJS.ProcessEnv, {
      getStatus: async () => ({ ok: true, status: "admin-ok" }),
      addAuthProfile: async () => ({ ok: true }),
      upsertGitHubAuthorMapping: async () => ({ ok: true }),
      deleteGitHubAuthorMapping: async () => ({ ok: true }),
      deleteAuthProfile: async () => ({ ok: true }),
      activateAuthProfile: async () => ({ ok: true }),
      deployWorker: async () => ({ ok: true }),
      rollbackWorker: async () => ({ ok: true })
    });

    const page = await fetch(`${baseUrl}/admin`);
    expect(page.status).toBe(200);
    const html = await page.text();

    expect(html).toContain("open-add-profile-dialog");
    expect(html).toContain("auth-profiles-panel");
    expect(html).toContain("Auth Profiles");
    expect(html).toContain("github-authors-panel");
    expect(html).toContain("GitHub Authors");
    expect(html).toContain("Deploy");
    expect(html).toContain("deploy-release-button");
    expect(html).toContain("Runtime Info");
    expect(html).toContain("add-profile-dialog");
    expect(html).toContain("session-search");
    expect(html).toContain("System Logs");
    expect(html).not.toContain("profile-name-input");
    expect(html).not.toContain("Account Quota");
    expect(html).not.toContain("Control");
    expect(html).not.toContain("ADMIN TOKEN");
    expect(html).not.toContain("/admin/api/runtime-files");
  });

  it("persists session ui state in the admin page script", async () => {
    const baseUrl = await startAdminServer({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test"
    } as NodeJS.ProcessEnv, {
      getStatus: async () => ({ ok: true, status: "admin-ok" }),
      addAuthProfile: async () => ({ ok: true }),
      upsertGitHubAuthorMapping: async () => ({ ok: true }),
      deleteGitHubAuthorMapping: async () => ({ ok: true }),
      deleteAuthProfile: async () => ({ ok: true }),
      activateAuthProfile: async () => ({ ok: true }),
      deployWorker: async () => ({ ok: true }),
      rollbackWorker: async () => ({ ok: true })
    });

    const page = await fetch(`${baseUrl}/admin`);
    expect(page.status).toBe(200);
    const html = await page.text();

    expect(html).toContain("admin-ui-state:");
    expect(html).toContain("expandedSessionKeys");
    expect(html).toContain('data-session-key="');
    expect(html).toContain("scheduleUiStatePersistence");
    expect(html).toContain("pruneExpandedSessionKeys");
    expect(html).toContain("window.localStorage.getItem");
    expect(html).toContain('row.addEventListener("toggle"');
    expect(html).toContain("sessionSearch.onblur");
  });

  it("accepts auth profile creation without an explicit name", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const baseUrl = await startAdminServer({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test"
    } as NodeJS.ProcessEnv, {
      getStatus: async () => ({ ok: true, status: "admin-ok" }),
      addAuthProfile: async (payload: Record<string, unknown>) => {
        calls.push(payload);
        return { ok: true, status: { ok: true } };
      },
      upsertGitHubAuthorMapping: async () => ({ ok: true }),
      deleteGitHubAuthorMapping: async () => ({ ok: true }),
      deleteAuthProfile: async () => ({ ok: true }),
      activateAuthProfile: async () => ({ ok: true }),
      deployWorker: async () => ({ ok: true }),
      rollbackWorker: async () => ({ ok: true })
    });

    const response = await fetch(`${baseUrl}/admin/api/auth-profiles`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        auth_json_content: "{\"tokens\":{\"account_id\":\"acc-1\"}}"
      })
    });
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        name: undefined,
        authJsonContent: "{\"tokens\":{\"account_id\":\"acc-1\"}}"
      }
    ]);
  });

  it("forwards GitHub author mapping upserts to the admin service", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const baseUrl = await startAdminServer({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test"
    } as NodeJS.ProcessEnv, {
      getStatus: async () => ({ ok: true }),
      addAuthProfile: async () => ({ ok: true }),
      upsertGitHubAuthorMapping: async (payload: Record<string, unknown>) => {
        calls.push(payload);
        return { ok: true, status: { ok: true } };
      },
      deleteGitHubAuthorMapping: async () => ({ ok: true }),
      deleteAuthProfile: async () => ({ ok: true }),
      activateAuthProfile: async () => ({ ok: true }),
      deployWorker: async () => ({ ok: true }),
      rollbackWorker: async () => ({ ok: true })
    });

    const response = await fetch(`${baseUrl}/admin/api/github-authors`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        slack_user_id: "U123",
        github_author: "Alice Example <alice@example.com>"
      })
    });
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        slackUserId: "U123",
        githubAuthor: "Alice Example <alice@example.com>"
      }
    ]);
  });

  it("emits admin page inline script without syntax errors", async () => {
    const baseUrl = await startAdminServer({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test"
    } as NodeJS.ProcessEnv, {
      getStatus: async () => ({ ok: true, status: "admin-ok" }),
      addAuthProfile: async () => ({ ok: true }),
      upsertGitHubAuthorMapping: async () => ({ ok: true }),
      deleteGitHubAuthorMapping: async () => ({ ok: true }),
      deleteAuthProfile: async () => ({ ok: true }),
      activateAuthProfile: async () => ({ ok: true }),
      deployWorker: async () => ({ ok: true }),
      rollbackWorker: async () => ({ ok: true })
    });

    const page = await fetch(`${baseUrl}/admin`);
    const html = await page.text();
    const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
    expect(scriptMatch?.[1]).toBeTruthy();
    const scriptSource = scriptMatch?.[1];
    if (!scriptSource) {
      throw new Error("missing admin inline script");
    }
    expect(() => new vm.Script(scriptSource)).not.toThrow();
  });

  it("forwards deploy requests to the admin service", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const baseUrl = await startAdminServer({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test"
    } as NodeJS.ProcessEnv, {
      getStatus: async () => ({ ok: true }),
      addAuthProfile: async () => ({ ok: true }),
      upsertGitHubAuthorMapping: async () => ({ ok: true }),
      deleteGitHubAuthorMapping: async () => ({ ok: true }),
      deleteAuthProfile: async () => ({ ok: true }),
      activateAuthProfile: async () => ({ ok: true }),
      deployWorker: async (payload: Record<string, unknown>) => {
        calls.push(payload);
        return { ok: true };
      },
      rollbackWorker: async () => ({ ok: true })
    });

    const response = await fetch(`${baseUrl}/admin/api/deploy`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ref: "deadbeef",
        allow_active: true
      })
    });
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        ref: "deadbeef",
        allowActive: true
      }
    ]);
  });

  it("forwards rollback requests to the admin service", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const baseUrl = await startAdminServer({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test"
    } as NodeJS.ProcessEnv, {
      getStatus: async () => ({ ok: true }),
      addAuthProfile: async () => ({ ok: true }),
      upsertGitHubAuthorMapping: async () => ({ ok: true }),
      deleteGitHubAuthorMapping: async () => ({ ok: true }),
      deleteAuthProfile: async () => ({ ok: true }),
      activateAuthProfile: async () => ({ ok: true }),
      deployWorker: async () => ({ ok: true }),
      rollbackWorker: async (payload: Record<string, unknown>) => {
        calls.push(payload);
        return { ok: true };
      }
    });

    const response = await fetch(`${baseUrl}/admin/api/rollback`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ref: "abc123",
        allow_active: false
      })
    });
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        ref: "abc123",
        allowActive: false
      }
    ]);
  });
});
