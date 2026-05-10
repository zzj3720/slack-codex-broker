import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { renderAdminShellHtml } from "../src/admin-ui/admin-shell.js";
import { createHttpHandler } from "../src/http/router.js";
import { AdminService } from "../src/services/admin-service.js";
import { createAgentRuntime, createCodexBroker } from "../src/services/service-components.js";
import { SessionManager } from "../src/services/session-manager.js";
import { SlackInboundStore } from "../src/services/slack/slack-inbound-store.js";
import { SlackTurnRunner } from "../src/services/slack/slack-turn-runner.js";
import { StateStore } from "../src/store/state-store.js";
import { MockCodexAppServer } from "./helpers/mock-codex-app-server.js";

describe("admin token usage e2e", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("records exact agent turn token usage and exposes it through admin resources", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-token-usage-"));
    cleanups.push(async () => {
      await fs.rm(dataRoot, { force: true, recursive: true });
    });

    const mockCodex = new MockCodexAppServer({
      emitThreadTokenUsage: true,
      onTurnStart: (context) => {
        (context.complete as (message: string, usage: unknown) => void)("turn finished", {
          input_tokens: 1_200,
          cached_input_tokens: 300,
          output_tokens: 450,
          reasoning_tokens: 75,
          total_tokens: 1_725,
          model: "gpt-5.5",
          effort: "xhigh"
        });
      }
    });
    const codexUrl = await mockCodex.start();
    cleanups.push(async () => {
      await mockCodex.stop();
    });

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      DATA_ROOT: dataRoot,
      CODEX_APP_SERVER_URL: codexUrl,
      SERVICE_ROOT: dataRoot,
      ADMIN_LAUNCHD_LABEL: "admin.test",
      WORKER_LAUNCHD_LABEL: "worker.test",
      ADMIN_PLIST_PATH: path.join(dataRoot, "admin.plist"),
      WORKER_PLIST_PATH: path.join(dataRoot, "worker.plist")
    } as NodeJS.ProcessEnv);
    await fs.mkdir(config.codexHome, { recursive: true });
    await fs.mkdir(config.logDir, { recursive: true });

    const stateStore = new StateStore(config.stateDir, config.sessionsRoot);
    const sessions = new SessionManager({
      stateStore,
      sessionsRoot: config.sessionsRoot
    });
    await sessions.load();
    cleanups.push(async () => {
      stateStore.close();
    });

    const codex = createCodexBroker(config);
    const agentRuntime = createAgentRuntime({
      config,
      codex,
      sessions,
      authProfiles: {
        listProfilesStatus: async () => ({
          managedRoot: path.join(dataRoot, "auth-profiles"),
          profilesRoot: path.join(dataRoot, "auth-profiles", "docker", "profiles"),
          activeProfile: null,
          activeAuthPath: path.join(config.codexHome, "auth.json"),
          profiles: []
        })
      } as never
    });
    await agentRuntime.start();
    cleanups.push(async () => {
      await agentRuntime.stop();
    });

    const slackApi = {
      getUserIdentity: async () => ({
        userId: "U123",
        mention: "<@U123>",
        realName: "User One"
      }),
      downloadFileAttachment: async () => ({ bytes: Buffer.from(""), contentType: "image/png" })
    } as never;
    const inboundStore = new SlackInboundStore({
      sessions,
      slackApi
    });
    const runner = new SlackTurnRunner({
      agentRuntime,
      slackApi,
      sessions,
      inboundStore
    });

    let session = await sessions.ensureSession("C123", "111.222");
    session = await runner.ensureAgentSession(session);
    await runner.submitInputWithRecovery({
      session,
      sessionKey: session.key,
      senderUserId: "U123",
      input: [
        {
          type: "text",
          text: "请检查 PR",
          text_elements: []
        }
      ],
      messageTsList: []
    });

    const adminService = new AdminService({
      config,
      sessions,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
      authProfiles: {
        listProfilesStatus: async () => ({
          managedRoot: path.join(dataRoot, "auth-profiles"),
          profilesRoot: path.join(dataRoot, "auth-profiles", "docker", "profiles"),
          activeProfile: "primary",
          activeAuthPath: path.join(config.codexHome, "auth.json"),
          profiles: []
        }),
        addProfile: async () => ({ name: "profile" }),
        deleteProfile: async () => {},
        activateProfile: async (name: string) => ({ name })
      } as never,
      githubAuthorMappings: {
        load: async () => {},
        listMappings: () => [],
        upsertManualMapping: async () => ({}),
        deleteMapping: async () => {}
      } as never,
      runtime: {
        restartRuntime: async () => {},
        readAccountSummary: async () => ({
          account: {
            email: "usage@example.com",
            type: "chatgpt",
            planType: "team"
          },
          requiresOpenaiAuth: false
        }),
        readAccountRateLimits: async () => ({
          rateLimits: {
            limitId: "codex",
            limitName: "Codex",
            primary: {
              usedPercent: 20,
              windowDurationMins: 300,
              resetsAt: 1_777_777_777
            },
            secondary: null,
            credits: null,
            planType: "team"
          },
          rateLimitsByLimitId: {}
        })
      } as never
    });

    const server = http.createServer(
      createHttpHandler({
        adminService,
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
      throw new Error("failed to start admin usage fixture");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const usage = await readJson(`${baseUrl}/admin/api/usage`);
    expect(usage).toMatchObject({
      ok: true,
      totals: {
        totalTurns: 1,
        exactTurns: 1,
        totalTokens: 1_725,
        inputTokens: 1_200,
        cachedInputTokens: 300,
        outputTokens: 450,
        reasoningTokens: 75
      },
      recentTurns: [
        {
          sessionKey: "C123:111.222",
          channelId: "C123",
          rootThreadTs: "111.222",
          source: "exact",
          model: "gpt-5.5",
          effort: "xhigh",
          totalTokens: 1_725
        }
      ],
      bySession: [
        {
          sessionKey: "C123:111.222",
          totalTokens: 1_725,
          turnCount: 1
        }
      ]
    });

    const status = await readJson(`${baseUrl}/admin/api/status`);
    expect(status).toMatchObject({
      usage: {
        totals: {
          totalTokens: 1_725
        }
      },
      state: {
        sessions: [
          {
            key: "C123:111.222",
            usage: {
              totalTokens: 1_725,
              turnCount: 1,
              exactTurns: 1,
              missingTurns: 0
            }
          }
        ]
      }
    });

    const page = await fetch(`${baseUrl}/admin`);
    const html = await page.text();
    const shell = renderAdminShellHtml("slack-codex-broker");
    const sessionViewSource = await fs.readFile(new URL("../src/admin-ui/session-view.tsx", import.meta.url), "utf8");
    expect(html).toContain('/admin/assets/admin-ui.js');
    expect(shell).toContain('id="topbar-quota"');
    expect(shell).toContain("session-react-root");
    expect(sessionViewSource).toContain("会话详情");
    expect(sessionViewSource).toContain("Token 消耗");
    expect(sessionViewSource).toContain('<Kpi label="Token"');
    expect(sessionViewSource).not.toContain("Token / 轮次");
  });
});

async function readJson(url: string): Promise<Record<string, any>> {
  const response = await fetch(url);
  const payload = await response.json() as Record<string, any>;
  expect(response.status).toBe(200);
  return payload;
}
