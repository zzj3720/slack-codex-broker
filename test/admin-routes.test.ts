import http from "node:http";
import fs from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { renderAdminShellHtml } from "../src/admin-ui/admin-shell.js";
import { stableSessionOrder } from "../src/admin-ui/session-order.js";
import { renderAdminPage } from "../src/http/admin-page.js";
import { deferUntilResponseFinished } from "../src/http/response-deferred-tasks.js";
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
      deployRelease: async () => ({ ok: true }),
      rollbackRelease: async () => ({ ok: true })
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

  it("runs deploy restart callbacks only after the deploy response is finished", async () => {
    const restartCalls: string[] = [];
    const baseUrl = await startAdminServer({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test"
    } as NodeJS.ProcessEnv, {
      deployRelease: async () => {
        const deferred = deferUntilResponseFinished(async () => {
          restartCalls.push("restart");
        });
        return {
          ok: true,
          deferred,
          restartCount: restartCalls.length
        };
      }
    });

    const response = await fetch(`${baseUrl}/admin/api/deploy`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ref: "main",
        allow_active: true
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      deferred: true,
      restartCount: 0
    });

    await waitFor(() => restartCalls.length === 1, "deferred restart callback");
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
      deployRelease: async () => ({ ok: true }),
      rollbackRelease: async () => ({ ok: true })
    });

    const page = await fetch(`${baseUrl}/admin`);
    expect(page.status).toBe(200);
    const html = await page.text();
    const shell = renderAdminShellHtml("slack-codex-broker");
    const sessionViewSource = await fs.readFile(new URL("../src/admin-ui/session-view.tsx", import.meta.url), "utf8");

    expect(html).toContain('id="admin-root"');
    expect(html).toContain('id="admin-config"');
    expect(html).toContain('/admin/assets/admin-ui.css');
    expect(html).toContain('/admin/assets/admin-ui.js');
    expect(html).not.toContain("switchAdminView");
    expect(shell).toContain("open-add-profile-dialog");
    expect(shell).toContain("admin-nav");
    expect(shell).toContain('data-admin-view="sessions"');
    expect(shell).toContain('data-admin-view="ops"');
    expect(shell).toContain('data-view-target="sessions"');
    expect(shell).toContain('data-view-target="ops"');
    expect(shell).toContain('id="topbar-quota"');
    expect(shell).toContain("auth-profiles-panel");
    expect(shell).toContain("认证档案");
    expect(shell).toContain("github-authors-panel");
    expect(shell).toContain("GitHub 作者映射");
    expect(shell).toContain("发布");
    expect(shell).toContain("deploy-release-button");
    expect(shell).toContain("add-profile-dialog");
    expect(shell).toContain("session-react-root");
    expect(sessionViewSource).toContain("session-search");
    expect(sessionViewSource).toContain("session-detail-panel");
    expect(sessionViewSource).toContain("会话详情");
    expect(shell).not.toContain("Session Inspector");
    expect(shell).not.toContain("session-table-header");
    expect(shell).toContain("系统日志");
    expect(sessionViewSource).toContain("待处理：");
    expect(sessionViewSource).toContain("人：");
    expect(sessionViewSource).toContain("系统：");
    expect(shell).not.toContain("status-strip");
    expect(shell).not.toContain("command-grid");
    expect(shell).not.toContain("MSG: ");
    expect(shell).not.toContain("profile-name-input");
    expect(shell).not.toContain("Account Quota");
    expect(shell).not.toContain("Control");
    expect(shell).not.toContain("ADMIN TOKEN");
    expect(shell).not.toContain("/admin/api/runtime-files");
  });

  it("serves a deep-linkable admin session page", async () => {
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
      deployRelease: async () => ({ ok: true }),
      rollbackRelease: async () => ({ ok: true })
    });

    const page = await fetch(`${baseUrl}/admin/sessions/${encodeURIComponent("C123:111.222")}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    const sessionViewSource = await fs.readFile(new URL("../src/admin-ui/session-view.tsx", import.meta.url), "utf8");

    expect(html).toContain('id="admin-root"');
    expect(html).toContain('/admin/assets/admin-ui.js');
    expect(sessionViewSource).toContain("readPermalinkSessionKey");
    expect(sessionViewSource).toContain("SessionPermalinkView");
    expect(sessionViewSource).toContain("/admin/api/sessions/\" + encodeURIComponent(sessionKey) + \"/timeline");
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
      deployRelease: async () => ({ ok: true }),
      rollbackRelease: async () => ({ ok: true })
    });

    const page = await fetch(`${baseUrl}/admin`);
    expect(page.status).toBe(200);
    const html = await page.text();
    const adminClientSource = await fs.readFile(new URL("../src/admin-ui/admin-legacy.js", import.meta.url), "utf8");
    const adminMainSource = await fs.readFile(new URL("../src/admin-ui/main.tsx", import.meta.url), "utf8");
    const sessionViewSource = await fs.readFile(new URL("../src/admin-ui/session-view.tsx", import.meta.url), "utf8");
    const adminCssSource = await fs.readFile(new URL("../src/admin-ui/admin.css", import.meta.url), "utf8");

    expect(adminClientSource).toContain("admin-ui-state:");
    expect(adminClientSource).toContain("selectedSessionKey");
    expect(sessionViewSource).toContain("data-session-key");
    expect(adminMainSource).toContain("AdminSessionsView");
    expect(adminMainSource).toContain("useReactSessions: true");
    expect(adminMainSource).toContain("publishAdminStatus");
    expect(adminClientSource).toContain("options.onStatus?.(data)");
    expect(sessionViewSource).toContain("useSyncExternalStore");
    expect(sessionViewSource).toContain("orderRef");
    expect(sessionViewSource).toContain("key={session.key}");
    expect(sessionViewSource).not.toContain("innerHTML");
    expect(sessionViewSource).not.toContain("dangerouslySetInnerHTML");
    expect(adminClientSource).toContain("scheduleUiStatePersistence");
    expect(adminClientSource).toContain("window.localStorage.getItem");
    expect(adminClientSource).toContain("selectSession(sessionKey");
    expect(adminClientSource).not.toContain("expandedSessionKeys");
    expect(adminClientSource).not.toContain('row.addEventListener("toggle"');
    expect(adminClientSource).toContain("sessionSearch.onblur");
    expect(sessionViewSource).toContain("ongoing");
    expect(adminClientSource).toContain("renderAccountChip");
    expect(adminClientSource).toContain("账号异常");
    expect(sessionViewSource).toContain("sessionQueueState");
    expect(sessionViewSource).toContain("compareSessionsForMode");
    expect(sessionViewSource).toContain("session-card");
    expect(sessionViewSource).toContain("session-meta-pill");
    expect(sessionViewSource).toContain("待人处理");
    expect(sessionViewSource).toContain('mode === "usage"');
    expect(sessionViewSource).toContain("fmtRelativeTime");
    expect(adminCssSource).toContain("text-overflow: ellipsis");
    expect(adminCssSource).toContain(".quota-account.is-error");
    expect(adminCssSource).toContain("html, body { width: 100%; height: 100%; overflow: hidden; }");
    expect(adminCssSource).toContain(".shell { width: 100%; height: 100dvh;");
    expect(adminCssSource).toContain("grid-template-columns: minmax(320px, 420px)");
    expect(adminCssSource).toContain(".session-detail-panel > .panel-body");
    expect(adminCssSource).toContain(".session-body { flex: 1; min-height: 0; overflow: auto;");
    expect(adminCssSource).toContain(".session-card { display: block; overflow: hidden; }");
    expect(adminCssSource).toContain(".session-meta-line { display: flex; gap: 4px; align-items: center; flex-wrap: nowrap;");
    expect(adminCssSource).toContain(".session-meta-pill { min-width: 0; max-width: 100%; flex: 0 1 auto;");
    expect(adminCssSource).toContain(".session-card");
    expect(adminCssSource).toContain(".session-priority-danger");
    expect(adminCssSource).not.toContain(".admin-nav { grid-template-columns: 1fr; }");
  });

  it("keeps the session list order stable while the same view is being refreshed", () => {
    const initial = stableSessionOrder({ viewKey: "", keys: [] }, "ongoing\n", ["a", "b", "c"]);
    expect(initial.keys).toEqual(["a", "b", "c"]);

    const refreshed = stableSessionOrder(initial, "ongoing\n", ["c", "a", "d", "b"]);
    expect(refreshed.keys).toEqual(["a", "b", "c", "d"]);

    const removed = stableSessionOrder(refreshed, "ongoing\n", ["d", "a"]);
    expect(removed.keys).toEqual(["a", "d"]);

    const changedView = stableSessionOrder(removed, "usage\n", ["d", "a"]);
    expect(changedView.keys).toEqual(["d", "a"]);
  });

  it("uses the Vite dev server assets when admin ui dev origin is configured", () => {
    const previous = process.env.ADMIN_UI_DEV_ORIGIN;
    process.env.ADMIN_UI_DEV_ORIGIN = "http://127.0.0.1:5173/";
    try {
      const html = renderAdminPage({ serviceName: "slack-codex-broker" });
      expect(html).toContain("http://127.0.0.1:5173/@react-refresh");
      expect(html).toContain("__vite_plugin_react_preamble_installed__");
      expect(html).toContain("http://127.0.0.1:5173/@vite/client");
      expect(html).toContain("http://127.0.0.1:5173/src/admin-ui/main.tsx");
      expect(html).not.toContain("/admin/assets/admin-ui.css");
      expect(html).not.toContain("/admin/assets/admin-ui.js");
    } finally {
      if (previous == null) {
        delete process.env.ADMIN_UI_DEV_ORIGIN;
      } else {
        process.env.ADMIN_UI_DEV_ORIGIN = previous;
      }
    }
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
      deployRelease: async () => ({ ok: true }),
      rollbackRelease: async () => ({ ok: true })
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
      deployRelease: async () => ({ ok: true }),
      rollbackRelease: async () => ({ ok: true })
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

  it("loads the admin client module without syntax errors", async () => {
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
      deployRelease: async () => ({ ok: true }),
      rollbackRelease: async () => ({ ok: true })
    });

    const page = await fetch(`${baseUrl}/admin`);
    const html = await page.text();
    expect(html).not.toMatch(/<script>[\s\S]*switchAdminView[\s\S]*<\/script>/);
    const adminClient = await import(new URL("../src/admin-ui/admin-legacy.js", import.meta.url).href) as {
      readonly initAdminPage?: unknown;
    };
    expect(adminClient.initAdminPage).toBeTypeOf("function");
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
      deployRelease: async (payload: Record<string, unknown>) => {
        calls.push(payload);
        return { ok: true };
      },
      rollbackRelease: async () => ({ ok: true })
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
      deployRelease: async () => ({ ok: true }),
      rollbackRelease: async (payload: Record<string, unknown>) => {
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

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
