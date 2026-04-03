import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("throws when required variables are missing", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrowError(
      "Missing required environment variable: SLACK_APP_TOKEN"
    );
  });

  it("loads required configuration", () => {
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test"
    } as NodeJS.ProcessEnv);

    expect(config.slackAppToken).toBe("xapp-test");
    expect(config.slackBotToken).toBe("xoxb-test");
    expect(config.stateDir.endsWith(".data/state")).toBe(true);
    expect(config.sessionsRoot.endsWith(".data/sessions")).toBe(true);
    expect(config.reposRoot.endsWith(".data/repos")).toBe(true);
    expect(config.logDir.endsWith(".data/logs")).toBe(true);
    expect(config.codexHostHomePath).toBeUndefined();
    expect(config.slackInitialThreadHistoryCount).toBe(8);
    expect(config.slackHistoryApiMaxLimit).toBe(50);
    expect(config.slackActiveTurnReconcileIntervalMs).toBe(15_000);
    expect(config.slackProgressReminderAfterMs).toBe(120_000);
    expect(config.slackProgressReminderRepeatMs).toBe(120_000);
    expect(config.sessionInactiveTtlMs).toBe(86_400_000);
    expect(config.sessionCleanupIntervalMs).toBe(3_600_000);
    expect(config.sessionCleanupMaxPerSweep).toBe(20);
    expect(config.logLevel).toBe("info");
    expect(config.logRawSlackEvents).toBe(true);
    expect(config.logRawCodexRpc).toBe(true);
    expect(config.logRawHttpRequests).toBe(true);
    expect(config.brokerAdminToken).toBeUndefined();
    expect(config.geminiHostHomePath).toBeUndefined();
    expect(config.geminiHttpProxy).toBeUndefined();
    expect(config.geminiHttpsProxy).toBeUndefined();
    expect(config.geminiAllProxy).toBeUndefined();
    expect(config.isolatedMcpServers).toEqual(["linear", "notion"]);
    expect(config.codexDisabledMcpServers).toEqual(["*", "linear", "notion"]);
    expect(config.tempadLinkServiceUrl).toBeUndefined();
  });

  it("rejects invalid numeric values", () => {
    expect(() =>
      loadConfig({
        SLACK_APP_TOKEN: "xapp-test",
        SLACK_BOT_TOKEN: "xoxb-test",
        PORT: "nope"
      } as NodeJS.ProcessEnv)
    ).toThrowError("Invalid numeric environment variable: PORT");
  });

  it("loads an explicit host codex home path", () => {
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      CODEX_HOST_HOME_PATH: "/host-codex-home"
    } as NodeJS.ProcessEnv);

    expect(config.codexHostHomePath).toBe("/host-codex-home");
  });

  it("loads Gemini runtime configuration", () => {
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      GEMINI_HOST_HOME_PATH: "/host-gemini-home",
      GEMINI_HTTP_PROXY: "http://host.docker.internal:6152",
      GEMINI_HTTPS_PROXY: "http://host.docker.internal:6152",
      GEMINI_ALL_PROXY: "socks5://host.docker.internal:6153"
    } as NodeJS.ProcessEnv);

    expect(config.geminiHostHomePath).toBe("/host-gemini-home");
    expect(config.geminiHttpProxy).toBe("http://host.docker.internal:6152");
    expect(config.geminiHttpsProxy).toBe("http://host.docker.internal:6152");
    expect(config.geminiAllProxy).toBe("socks5://host.docker.internal:6153");
  });

  it("loads an explicit tempad link service url override", () => {
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      TEMPAD_LINK_SERVICE_URL: "http://host.docker.internal:4320"
    } as NodeJS.ProcessEnv);

    expect(config.tempadLinkServiceUrl).toBe("http://host.docker.internal:4320");
  });

  it("parses disabled MCP servers as a csv list and unions isolated MCP servers", () => {
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      CODEX_DISABLED_MCP_SERVERS: " github, linear ,, ",
      ISOLATED_MCP_SERVERS: " notion, linear ,, "
    } as NodeJS.ProcessEnv);

    expect(config.isolatedMcpServers).toEqual(["notion", "linear"]);
    expect(config.codexDisabledMcpServers).toEqual(["*", "github", "linear", "notion"]);
  });

  it("parses log configuration", () => {
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      LOG_LEVEL: "debug",
      LOG_RAW_SLACK_EVENTS: "false",
      LOG_RAW_CODEX_RPC: "false",
      LOG_RAW_HTTP_REQUESTS: "true"
    } as NodeJS.ProcessEnv);

    expect(config.logLevel).toBe("debug");
    expect(config.logRawSlackEvents).toBe(false);
    expect(config.logRawCodexRpc).toBe(false);
    expect(config.logRawHttpRequests).toBe(true);
  });

  it("parses session cleanup configuration", () => {
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      SESSION_INACTIVE_TTL_MS: "60000",
      SESSION_CLEANUP_INTERVAL_MS: "30000",
      SESSION_CLEANUP_MAX_PER_SWEEP: "5"
    } as NodeJS.ProcessEnv);

    expect(config.sessionInactiveTtlMs).toBe(60_000);
    expect(config.sessionCleanupIntervalMs).toBe(30_000);
    expect(config.sessionCleanupMaxPerSweep).toBe(5);
  });

  it("loads an optional broker admin token", () => {
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      BROKER_ADMIN_TOKEN: "secret-admin-token"
    } as NodeJS.ProcessEnv);

    expect(config.brokerAdminToken).toBe("secret-admin-token");
  });
});
