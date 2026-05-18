import http from "node:http";
import fs from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
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
        target: "worker",
        version: "0.2.0",
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

  it("serves recent logs as a separate admin resource", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const baseUrl = await startAdminServer({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test"
    } as NodeJS.ProcessEnv, {
      getRecentLogs: async (payload: Record<string, unknown>) => {
        calls.push(payload);
        return {
          ok: true,
          logs: [{ ts: "2026-05-13T09:00:00.000Z", level: "info", message: "ready" }]
        };
      }
    });

    const response = await fetch(`${baseUrl}/admin/api/logs?limit=3`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      logs: [
        {
          level: "info",
          message: "ready"
        }
      ]
    });
    expect(calls).toEqual([{ limit: 3 }]);
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
      deployRelease: async () => ({ ok: true }),
      rollbackRelease: async () => ({ ok: true })
    });

    const page = await fetch(`${baseUrl}/admin`);
    expect(page.status).toBe(200);
    const html = await page.text();
    const adminIndexSource = await fs.readFile(new URL("../src/admin-ui/index.html", import.meta.url), "utf8");
    const adminMainSource = await fs.readFile(new URL("../src/admin-ui/main.tsx", import.meta.url), "utf8");
    const adminShellSource = await fs.readFile(new URL("../src/admin-ui/admin-shell.tsx", import.meta.url), "utf8");
    const viteConfigSource = await fs.readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
    const sessionViewSource = await fs.readFile(new URL("../src/admin-ui/session-view.tsx", import.meta.url), "utf8");

    expect(html).toContain('id="admin-root"');
    expect(html).toContain('id="admin-config"');
    expect(html).toContain('/admin/assets/admin-ui.css');
    expect(html).toContain('/admin/assets/admin-ui.js');
    expect(html).not.toContain("switchAdminView");
    expect(adminIndexSource).toContain('id="admin-root"');
    expect(adminIndexSource).toContain('id="admin-config"');
    expect(adminIndexSource).toContain('src="/main.tsx"');
    expect(viteConfigSource).toContain('root: "src/admin-ui"');
    expect(viteConfigSource).toContain('base: "/admin/"');
    expect(viteConfigSource).toContain('input: "index.html"');
    expect(adminMainSource).toContain("<AdminShell");
    expect(adminMainSource).not.toContain("initAdminPage");
    expect(adminMainSource).not.toContain("dangerouslySetInnerHTML");
    expect(adminShellSource).toContain("export function AdminShell");
    expect(adminShellSource).toContain("admin-nav");
    expect(adminShellSource).toContain('data-admin-view="sessions"');
    expect(adminShellSource).toContain('data-admin-view="ops"');
    expect(adminShellSource).not.toContain("top-actions");
    expect(adminShellSource).not.toContain("refresh-button");
    expect(adminShellSource).not.toContain("last-refresh");
    expect(adminShellSource).not.toContain("实时");
    expect(adminShellSource).not.toContain("刷新");
    expect(adminShellSource).toContain("账号池");
    expect(adminShellSource).toContain("GitHub 账号");
    expect(adminShellSource).not.toContain("GitHub 作者映射");
    expect(adminShellSource).toContain("发布");
    expect(adminShellSource).toContain("推荐使用设备码 OAuth");
    expect(adminShellSource).toContain("备用：导入 auth.json");
    expect(adminShellSource).toContain("绑定 GitHub");
    expect(adminShellSource).not.toContain("Slack 用户 ID（U123...）");
    expect(adminShellSource).not.toContain("Commit 作者：姓名 <email@example.com>");
    expect(adminShellSource).not.toContain("编辑作者");
    expect(adminShellSource).not.toContain("历史 Commit 作者");
    expect(adminShellSource).not.toContain("session-react-root");
    expect(sessionViewSource).not.toContain("session-search");
    expect(sessionViewSource).not.toContain("sessionSearch");
    expect(sessionViewSource).not.toContain('type="search"');
    expect(adminShellSource).not.toContain('type="search"');
    expect(adminShellSource).not.toContain("筛选 Slack / GitHub 账号");
    expect(sessionViewSource).toContain("session-detail-panel");
    expect(sessionViewSource).not.toContain("Agent 工作台");
    expect(adminShellSource).not.toContain("Session Inspector");
    expect(sessionViewSource).not.toContain("session-table-header");
    expect(adminShellSource).toContain("系统日志");
    expect(sessionViewSource).toContain("待处理");
    expect(sessionViewSource).toContain("openHumanInboundCount");
    expect(sessionViewSource).toContain("openSystemInboundCount");
    expect(adminShellSource).not.toContain("status-strip");
    expect(adminShellSource).not.toContain("command-grid");
    expect(adminShellSource).not.toContain("MSG: ");
    expect(adminShellSource).not.toContain("profile-name-input");
    expect(adminShellSource).not.toContain("Account Quota");
    expect(adminShellSource).not.toContain("Control");
    expect(adminShellSource).not.toContain("ADMIN TOKEN");
    expect(adminShellSource).not.toContain("/admin/api/runtime-files");
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
      deployRelease: async () => ({ ok: true }),
      rollbackRelease: async () => ({ ok: true })
    });

    const page = await fetch(`${baseUrl}/admin/sessions/${encodeURIComponent("C123:111.222")}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    const adminMainSource = await fs.readFile(new URL("../src/admin-ui/main.tsx", import.meta.url), "utf8");
    const adminCssSource = await fs.readFile(new URL("../src/admin-ui/admin.css", import.meta.url), "utf8");
    const sessionViewSource = await fs.readFile(new URL("../src/admin-ui/session-view.tsx", import.meta.url), "utf8");

    expect(html).toContain('id="admin-root"');
    expect(html).toContain('/admin/assets/admin-ui.js');
    expect(adminMainSource).toContain("isSessionPermalinkPath");
    expect(adminMainSource).toContain("session-permalink-page");
    expect(adminCssSource).toContain("body.session-permalink-page .topbar");
    expect(sessionViewSource).toContain("readPermalinkSessionKey");
    expect(sessionViewSource).toContain("SessionPermalinkView");
    expect(sessionViewSource).toContain("/admin/api/sessions/\" + encodeURIComponent(sessionKey) + \"/timeline");
  });

  it("routes session Slack thread permalink resolution", async () => {
    const calls: string[] = [];
    const baseUrl = await startAdminServer({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test"
    } as NodeJS.ProcessEnv, {
      getSessionSlackThreadUrl: async (sessionKey: string) => {
        calls.push(sessionKey);
        return {
          ok: true,
          url: "https://workspace.slack.com/archives/C123/p111222?thread_ts=111.222&cid=C123"
        };
      }
    });

    const response = await fetch(`${baseUrl}/admin/api/sessions/${encodeURIComponent("C123:111.222")}/slack-thread-url`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      url: "https://workspace.slack.com/archives/C123/p111222?thread_ts=111.222&cid=C123"
    });
    expect(calls).toEqual(["C123:111.222"]);
  });

  it("serves the GitHub bind session deep link and routes device OAuth api calls", async () => {
    const calls: string[] = [];
    const baseUrl = await startAdminServer({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test"
    } as NodeJS.ProcessEnv, {
      getSessionGitHubIdentity: async (sessionKey: string) => {
        calls.push(`identity:${sessionKey}`);
        return {
          ok: true,
          sessionKey,
          identity: {
            binding: { state: "unbound" },
            defaultAccount: { available: true, githubLogin: "default-bot" }
          }
        };
      },
      startSessionGitHubDeviceAuthorization: async (sessionKey: string) => {
        calls.push(`start:${sessionKey}`);
        return {
          ok: true,
          device: {
            id: "device-1",
            userCode: "ABCD-EFGH"
          }
        };
      },
      pollGitHubDeviceAuthorization: async (deviceAuthorizationId: string) => {
        calls.push(`poll:${deviceAuthorizationId}`);
        return {
          ok: true,
          result: { status: "pending" }
        };
      }
    });
    const sessionKey = "C123:111.222";

    const page = await fetch(`${baseUrl}/admin/sessions/${encodeURIComponent(sessionKey)}/github/bind`);
    expect(page.status).toBe(200);
    await expect(page.text()).resolves.toContain('id="admin-root"');
    const sessionViewSource = await fs.readFile(new URL("../src/admin-ui/session-view.tsx", import.meta.url), "utf8");
    expect(sessionViewSource).toContain("function GitHubBindPage");
    expect(sessionViewSource).toContain("github-bind-page");
    expect(sessionViewSource).toContain("github-bind-card");
    expect(sessionViewSource).toContain("GitHubBindingFlow");
    expect(sessionViewSource).not.toContain('const shouldAutoStart = typeof window !== "undefined" && window.location.pathname.endsWith("/github/bind")');

    const identity = await fetch(`${baseUrl}/admin/api/sessions/${encodeURIComponent(sessionKey)}/github-identity`);
    expect(identity.status).toBe(200);
    await expect(identity.json()).resolves.toMatchObject({
      ok: true,
      identity: {
        binding: { state: "unbound" },
        defaultAccount: { githubLogin: "default-bot" }
      }
    });

    const started = await fetch(`${baseUrl}/admin/api/sessions/${encodeURIComponent(sessionKey)}/github-oauth/device/start`, {
      method: "POST"
    });
    expect(started.status).toBe(200);
    await expect(started.json()).resolves.toMatchObject({
      ok: true,
      device: {
        id: "device-1",
        userCode: "ABCD-EFGH"
      }
    });

    const polled = await fetch(`${baseUrl}/admin/api/github-oauth/device/device-1`);
    expect(polled.status).toBe(200);
    await expect(polled.json()).resolves.toMatchObject({
      ok: true,
      result: { status: "pending" }
    });
    expect(calls).toEqual([
      "identity:C123:111.222",
      "start:C123:111.222",
      "poll:device-1"
    ]);
  });

  it("routes admin GitHub account OAuth start by existing Slack user id", async () => {
    const calls: string[] = [];
    const baseUrl = await startAdminServer({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test"
    } as NodeJS.ProcessEnv, {
      startGitHubAccountDeviceAuthorization: async (slackUserId: string) => {
        calls.push(slackUserId);
        return {
          ok: true,
          device: {
            id: "device-1",
            slackUserId,
            userCode: "ABCD-EFGH"
          }
        };
      }
    });

    const started = await fetch(`${baseUrl}/admin/api/github-accounts/${encodeURIComponent("U123")}/oauth/device/start`, {
      method: "POST"
    });
    expect(started.status).toBe(200);
    await expect(started.json()).resolves.toMatchObject({
      ok: true,
      device: {
        id: "device-1",
        slackUserId: "U123"
      }
    });
    expect(calls).toEqual(["U123"]);
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
      deployRelease: async () => ({ ok: true }),
      rollbackRelease: async () => ({ ok: true })
    });

    const page = await fetch(`${baseUrl}/admin`);
    expect(page.status).toBe(200);
    const html = await page.text();
    const adminMainSource = await fs.readFile(new URL("../src/admin-ui/main.tsx", import.meta.url), "utf8");
    const adminShellSource = await fs.readFile(new URL("../src/admin-ui/admin-shell.tsx", import.meta.url), "utf8");
    const sessionViewSource = await fs.readFile(new URL("../src/admin-ui/session-view.tsx", import.meta.url), "utf8");
    const sessionRowDisplaySource = await fs.readFile(new URL("../src/admin-ui/session-row-display.ts", import.meta.url), "utf8");
    const adminCssSource = await fs.readFile(new URL("../src/admin-ui/admin.css", import.meta.url), "utf8");

    expect(adminMainSource).not.toContain("admin-legacy");
    expect(sessionViewSource).toContain("admin-ui-state:");
    expect(sessionViewSource).toContain("selectedSessionKey");
    expect(sessionViewSource).toContain("data-session-key");
    expect(adminShellSource).toContain("AdminSessionsView");
    expect(adminShellSource).toContain("publishAdminStatus");
    expect(sessionViewSource).toContain("useSyncExternalStore");
    expect(sessionViewSource).toContain("orderRef");
    expect(sessionViewSource).toContain("key={session.key}");
    expect(sessionViewSource).not.toContain("innerHTML");
    expect(sessionViewSource).not.toContain("dangerouslySetInnerHTML");
    expect(adminShellSource).toContain("window.localStorage.getItem");
    expect(sessionViewSource).not.toContain("expandedSessionKeys");
    expect(sessionViewSource).toContain("ongoing");
    expect(adminShellSource).toContain("authProfileQuotaItems");
    expect(adminShellSource).toContain("profileTitle");
    expect(sessionViewSource).toContain("自动分配");
    expect(sessionViewSource).toContain('mode: "auto"');
    expect(adminShellSource).not.toContain("renderAccountChip");
    expect(adminShellSource).not.toContain("refreshButton");
    expect(adminShellSource).not.toContain("lastRefresh");
    expect(adminShellSource).not.toContain(" 活跃 · ");
    expect(adminShellSource).not.toContain(" 待处理 · ");
    expect(sessionViewSource).toContain("sessionQueueState");
    expect(sessionViewSource).toContain("compareSessionsForMode");
    expect(sessionViewSource).toContain("session-card");
    expect(sessionViewSource).toContain("session-meta-pill");
    expect(sessionRowDisplaySource).not.toContain("待人处理");
    expect(sessionRowDisplaySource).toContain("待处理");
    expect(sessionRowDisplaySource).not.toContain("任务失败");
    expect(sessionViewSource).toContain('mode === "issues" && !sessionAuthBlockActive');
    expect(sessionViewSource).toContain('mode === "usage"');
    expect(sessionViewSource).toContain("fmtRelativeTime");
    expect(adminCssSource).toContain("text-overflow: ellipsis");
    expect(adminCssSource).toContain("overflow-x: auto");
    expect(adminCssSource).toContain("flex: 0 0 auto");
    expect(adminCssSource).toContain("grid-auto-rows: max-content");
    expect(adminCssSource).toContain("align-content: start");
    expect(adminCssSource).toContain("html, body { width: 100%; height: 100%; overflow: hidden; }");
    expect(adminCssSource).toContain(".shell { width: 100%; height: 100dvh;");
    expect(adminCssSource).toContain("grid-template-columns: minmax(320px, 420px)");
    expect(adminCssSource).toContain(".session-detail-panel > .panel-body");
    expect(adminCssSource).toContain(".session-body { flex: 1; min-height: 0; overflow: hidden;");
    expect(adminCssSource).toContain(".session-timeline-panel .mini-body { flex: 1; min-height: 0; overflow: hidden;");
    expect(adminCssSource).toContain(".timeline { flex: 1; min-height: 0; display: flex; flex-direction: column;");
    expect(adminCssSource).toContain(".agent-transcript");
    expect(adminCssSource).toContain(".agent-message-body");
    expect(adminCssSource).toContain(".agent-tool-step");
    expect(adminCssSource).toContain(".session-card { display: block; overflow: hidden; }");
    expect(adminCssSource).toContain(".session-meta-line { display: flex; gap: 4px; align-items: center; flex-wrap: nowrap;");
    expect(adminCssSource).toContain(".session-meta-pill { min-width: 0; max-width: 100%; flex: 0 1 auto;");
    expect(adminCssSource).toContain(".session-card");
    expect(adminCssSource).toContain(".session-priority-danger");
    expect(adminCssSource).toContain("dialog[open]");
    expect(adminCssSource).toContain("position: fixed");
    expect(adminCssSource).toContain("z-index: 1000");
    expect(adminCssSource).not.toContain(".top-actions");
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
      expect(html).toContain("http://127.0.0.1:5173/admin/@react-refresh");
      expect(html).toContain("__vite_plugin_react_preamble_installed__");
      expect(html).toContain("http://127.0.0.1:5173/admin/@vite/client");
      expect(html).toContain("http://127.0.0.1:5173/admin/main.tsx");
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

  it("forwards auth profile device-code start and completion to the admin service", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const baseUrl = await startAdminServer({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test"
    } as NodeJS.ProcessEnv, {
      getStatus: async () => ({ ok: true, status: "admin-ok" }),
      addAuthProfile: async () => ({ ok: true }),
      startAuthProfileDeviceCode: async () => {
        calls.push({ type: "start" });
        return {
          ok: true,
          deviceCode: {
            deviceAuthId: "device-1",
            userCode: "ABCD-EFGH"
          }
        };
      },
      completeAuthProfileDeviceCode: async (payload: Record<string, unknown>) => {
        calls.push({ type: "complete", ...payload });
        return {
          ok: true,
          deviceCode: {
            status: "pending"
          }
        };
      },
      upsertGitHubAuthorMapping: async () => ({ ok: true }),
      deleteGitHubAuthorMapping: async () => ({ ok: true }),
      deleteAuthProfile: async () => ({ ok: true }),
      deployRelease: async () => ({ ok: true }),
      rollbackRelease: async () => ({ ok: true })
    });

    const start = await fetch(`${baseUrl}/admin/api/auth-profiles/device-code/start`, {
      method: "POST"
    });
    expect(start.status).toBe(200);

    const complete = await fetch(`${baseUrl}/admin/api/auth-profiles/device-code/complete`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        device_auth_id: "device-1",
        user_code: "ABCD-EFGH",
        retry_after_seconds: 8
      })
    });
    expect(complete.status).toBe(200);
    expect(calls).toEqual([
      {
        type: "start"
      },
      {
        type: "complete",
        name: undefined,
        deviceAuthId: "device-1",
        userCode: "ABCD-EFGH",
        retryAfterSeconds: 8
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

  it("forwards default GitHub PR account selection to the admin service", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const baseUrl = await startAdminServer({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test"
    } as NodeJS.ProcessEnv, {
      getStatus: async () => ({ ok: true }),
      addAuthProfile: async () => ({ ok: true }),
      upsertGitHubAuthorMapping: async () => ({ ok: true }),
      deleteGitHubAuthorMapping: async () => ({ ok: true }),
      setDefaultGitHubPrAccount: async (payload: Record<string, unknown>) => {
        calls.push(payload);
        return { ok: true, status: { ok: true } };
      },
      deleteAuthProfile: async () => ({ ok: true }),
      deployRelease: async () => ({ ok: true }),
      rollbackRelease: async () => ({ ok: true })
    });

    const missing = await fetch(`${baseUrl}/admin/api/github-accounts/default-pr`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    });
    expect(missing.status).toBe(400);

    const response = await fetch(`${baseUrl}/admin/api/github-accounts/default-pr`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        slack_user_id: "U123"
      })
    });
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        slackUserId: "U123"
      }
    ]);
  });

  it("forwards automatic session auth profile switches without requiring a profile name", async () => {
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
      deployRelease: async () => ({ ok: true }),
      rollbackRelease: async () => ({ ok: true }),
      switchSessionAuthProfile: async (payload: Record<string, unknown>) => {
        calls.push(payload);
        return { ok: true };
      }
    });

    const response = await fetch(`${baseUrl}/admin/api/sessions/${encodeURIComponent("C123:111.222")}/auth-profile`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        mode: "auto"
      })
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        sessionKey: "C123:111.222",
        mode: "auto"
      }
    ]);
  });

  it("serves the React admin client without the legacy inline script", async () => {
    const baseUrl = await startAdminServer({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test"
    } as NodeJS.ProcessEnv, {
      getStatus: async () => ({ ok: true, status: "admin-ok" }),
      addAuthProfile: async () => ({ ok: true }),
      upsertGitHubAuthorMapping: async () => ({ ok: true }),
      deleteGitHubAuthorMapping: async () => ({ ok: true }),
      deleteAuthProfile: async () => ({ ok: true }),
      deployRelease: async () => ({ ok: true }),
      rollbackRelease: async () => ({ ok: true })
    });

    const page = await fetch(`${baseUrl}/admin`);
    const html = await page.text();
    expect(html).not.toMatch(/<script>[\s\S]*switchAdminView[\s\S]*<\/script>/);
    expect(html).toContain('/admin/assets/admin-ui.js');
    const adminShellSource = await fs.readFile(new URL("../src/admin-ui/admin-shell.tsx", import.meta.url), "utf8");
    expect(adminShellSource).toContain("export function AdminShell");
    expect(adminShellSource).not.toContain("initAdminPage");
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
        target: "worker",
        version: "0.2.0",
        allow_active: true
      })
    });
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        target: "worker",
        version: "0.2.0",
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
        target: "admin",
        version: "0.1.0",
        allow_active: false
      })
    });
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        target: "admin",
        version: "0.1.0",
        allowActive: false
      }
    ]);
  });

  it("forwards session delete requests to the admin service", async () => {
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
      rollbackRelease: async () => ({ ok: true }),
      deleteSession: async (payload: Record<string, unknown>) => {
        calls.push(payload);
        return { ok: true };
      }
    });

    const response = await fetch(`${baseUrl}/admin/api/sessions/${encodeURIComponent("C123:111.222")}`, {
      method: "DELETE"
    });
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        sessionKey: "C123:111.222"
      }
    ]);
  });

  it("maps missing session delete failures to 404", async () => {
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
      rollbackRelease: async () => ({ ok: true }),
      deleteSession: async () => {
        throw new Error("Session not found: C123:missing");
      }
    });

    const response = await fetch(`${baseUrl}/admin/api/sessions/${encodeURIComponent("C123:missing")}`, {
      method: "DELETE"
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "Session not found: C123:missing"
    });
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
