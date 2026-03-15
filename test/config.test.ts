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
    expect(config.logLevel).toBe("info");
    expect(config.logRawSlackEvents).toBe(true);
    expect(config.logRawCodexRpc).toBe(true);
    expect(config.logRawHttpRequests).toBe(true);
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

  it("parses disabled MCP servers as a csv list", () => {
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      CODEX_DISABLED_MCP_SERVERS: " notion, linear ,, "
    } as NodeJS.ProcessEnv);

    expect(config.codexDisabledMcpServers).toEqual(["notion", "linear"]);
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
});
