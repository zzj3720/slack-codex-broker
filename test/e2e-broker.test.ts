import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { CodexInputItem } from "../src/services/codex/app-server-client.js";
import { MockCodexAppServer } from "./helpers/mock-codex-app-server.js";
import { MockSlackServer } from "./manual/mock-slack-server.js";

const brokerRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const DEFAULT_E2E_TIMEOUT_MS = process.env.CI ? 30_000 : 15_000;

describe.sequential("slack-codex-broker e2e", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      await cleanup?.();
    }
  });

  it("starts a new session, backfills history, and forwards full Slack card payloads", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-broker-e2e-"));
    cleanups.push(async () => {
      await fs.rm(tempRoot, { force: true, recursive: true });
    });

    const mockSlack = new MockSlackServer("UBOT", {
      botId: "BBOT",
      appId: "AAPP"
    });
    const mockCodex = new MockCodexAppServer();
    const slackPort = await mockSlack.start();
    const codexUrl = await mockCodex.start();
    cleanups.push(async () => {
      await mockCodex.stop();
      await mockSlack.stop();
    });

    const broker = await startBrokerProcess({
      port: await getFreePort(),
      slackPort,
      codexUrl,
      tempRoot
    });
    cleanups.push(() => broker.stop());

    await mockSlack.sendEvent("evt-pre-root", {
      type: "message",
      user: "U123",
      channel: "C123",
      ts: "111.220",
      text: "ROOT_CONTEXT_ABC"
    });
    await mockSlack.sendEvent("evt-pre-recent", {
      type: "message",
      user: "U234",
      channel: "C123",
      thread_ts: "111.220",
      ts: "111.221",
      text: "RECENT_CONTEXT_DEF"
    });
    await mockSlack.sendEvent("evt-mention", {
      type: "app_mention",
      user: "U123",
      channel: "C123",
      thread_ts: "111.220",
      ts: "111.222",
      text: "<@UBOT> 看看这条 thread"
    });

    await waitFor(() => mockCodex.turnsStarted.length >= 1, "first turn start");
    await waitForSessionIdle(tempRoot, "C123:111.220");
    const firstTurnText = collectTextInput(mockCodex.turnsStarted[0]!.input);
    expect(firstTurnText).toContain("ROOT_CONTEXT_ABC");
    expect(firstTurnText).toContain("RECENT_CONTEXT_DEF");
    expect(firstTurnText).toContain("structured_message_json");

    await mockSlack.sendEvent("evt-linear-card", {
      type: "message",
      channel: "C123",
      thread_ts: "111.220",
      ts: "111.223",
      subtype: "bot_message",
      bot_id: "BLINEAR",
      app_id: "ALINEAR",
      username: "Linear",
      text: "",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*CUE-1180* 感觉 ai chat webview 帧率很低"
          }
        }
      ],
      attachments: [
        {
          title: "CUE-1180 感觉 ai chat webview 帧率很低",
          title_link: "https://linear.app/cue/issue/CUE-1180",
          text: "State: Backlog"
        }
      ]
    });

    await waitFor(() => {
      const deliveredTexts = [
        ...mockCodex.turnsStarted.map((turn) => collectTextInput(turn.input)),
        ...mockCodex.steers.map((steer) => collectTextInput(steer.input))
      ];
      return deliveredTexts.some((text) => text.includes("\"bot_id\": \"BLINEAR\""));
    }, "delivery of bot card payload");
    const deliveredTexts = [
      ...mockCodex.turnsStarted.map((turn) => collectTextInput(turn.input)),
      ...mockCodex.steers.map((steer) => collectTextInput(steer.input))
    ];
    const botCardText = deliveredTexts.find((text) => text.includes("\"bot_id\": \"BLINEAR\"")) ?? "";
    expect(botCardText).toContain("\"attachments\"");
    expect(botCardText).toContain("https://linear.app/cue/issue/CUE-1180");
  }, 60_000);

  it("replays missed thread messages after restart as a single recovered batch", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-broker-e2e-"));
    cleanups.push(async () => {
      await fs.rm(tempRoot, { force: true, recursive: true });
    });

    const mockSlack = new MockSlackServer("UBOT", {
      botId: "BBOT",
      appId: "AAPP"
    });
    const mockCodex = new MockCodexAppServer();
    const slackPort = await mockSlack.start();
    const codexUrl = await mockCodex.start();
    cleanups.push(async () => {
      await mockCodex.stop();
      await mockSlack.stop();
    });

    const port = await getFreePort();
    const broker = await startBrokerProcess({
      port,
      slackPort,
      codexUrl,
      tempRoot
    });
    cleanups.push(() => broker.stop());

    await mockSlack.sendEvent("evt-session", {
      type: "app_mention",
      user: "U123",
      channel: "C123",
      thread_ts: "222.220",
      ts: "222.221",
      text: "<@UBOT> 开个 session"
    });
    await waitFor(() => mockCodex.turnsStarted.length >= 1, "session bootstrap turn");
    await waitForSessionIdle(tempRoot, "C123:222.220");
    await broker.stop();
    cleanups.pop();

    mockSlack.recordThreadMessage({
      channel: "C123",
      threadTs: "222.220",
      ts: "222.222",
      text: "漏掉的第一条",
      user: "U123"
    });
    mockSlack.recordThreadMessage({
      channel: "C123",
      threadTs: "222.220",
      ts: "222.223",
      text: "漏掉的第二条",
      user: "U234"
    });

    const restarted = await startBrokerProcess({
      port,
      slackPort,
      codexUrl,
      tempRoot
    });
    cleanups.push(() => restarted.stop());

    await waitFor(() => {
      const deliveredTexts = [
        ...mockCodex.turnsStarted.slice(1).map((turn) => collectTextInput(turn.input)),
        ...mockCodex.steers.map((steer) => collectTextInput(steer.input))
      ];
      return deliveredTexts.some((text) => text.includes("recovered_message_batch_json"));
    }, "recovered batch turn");
    const deliveredTexts = [
      ...mockCodex.turnsStarted.slice(1).map((turn) => collectTextInput(turn.input)),
      ...mockCodex.steers.map((steer) => collectTextInput(steer.input))
    ];
    const recoveredText = deliveredTexts.find((text) => text.includes("recovered_message_batch_json")) ?? "";
    expect(recoveredText).toContain("recovered_message_batch_json");
    expect(recoveredText).toContain("漏掉的第一条");
    expect(recoveredText).toContain("漏掉的第二条");
    expect(recoveredText).toContain("\"batch_message_count\": 2");
  }, 60_000);

  it("injects background job events back into the same session", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-broker-e2e-"));
    cleanups.push(async () => {
      await fs.rm(tempRoot, { force: true, recursive: true });
    });

    const mockSlack = new MockSlackServer("UBOT", {
      botId: "BBOT",
      appId: "AAPP"
    });
    const mockCodex = new MockCodexAppServer();
    const slackPort = await mockSlack.start();
    const codexUrl = await mockCodex.start();
    cleanups.push(async () => {
      await mockCodex.stop();
      await mockSlack.stop();
    });

    const broker = await startBrokerProcess({
      port: await getFreePort(),
      slackPort,
      codexUrl,
      tempRoot
    });
    cleanups.push(() => broker.stop());

    await mockSlack.sendEvent("evt-session", {
      type: "app_mention",
      user: "U123",
      channel: "C123",
      thread_ts: "333.220",
      ts: "333.221",
      text: "<@UBOT> 先起一个 session"
    });
    await waitFor(() => mockCodex.turnsStarted.length >= 1, "initial turn");
    await waitForSessionIdle(tempRoot, "C123:333.220");

    const registerResponse = await fetch(`${broker.baseUrl}/jobs/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        channel_id: "C123",
        thread_ts: "333.220",
        kind: "watch_ci",
        script: "#!/bin/sh\nsleep 30"
      })
    });
    const registerBody = await registerResponse.json() as {
      job?: { id: string; token: string };
    };
    expect(registerResponse.ok).toBe(true);
    expect(registerBody.job?.id).toBeTruthy();
    expect(registerBody.job?.token).toBeTruthy();

    await postJson(`${broker.baseUrl}/jobs/${registerBody.job!.id}/event`, {
      token: registerBody.job!.token,
      event_kind: "state_changed",
      summary: "CI turned green."
    });
    await postJson(`${broker.baseUrl}/jobs/${registerBody.job!.id}/complete`, {
      token: registerBody.job!.token,
      summary: "job done"
    });

    await waitFor(() => {
      const deliveredTexts = [
        ...mockCodex.turnsStarted.slice(1).map((turn) => collectTextInput(turn.input)),
        ...mockCodex.steers.map((steer) => collectTextInput(steer.input))
      ];
      return deliveredTexts.some((text) => text.includes("background_job_event_json"));
    }, "background job event delivery");
    const deliveredTexts = [
      ...mockCodex.turnsStarted.slice(1).map((turn) => collectTextInput(turn.input)),
      ...mockCodex.steers.map((steer) => collectTextInput(steer.input))
    ];
    expect(deliveredTexts.some((text) => text.includes("background_job_event_json"))).toBe(true);
    expect(deliveredTexts.some((text) => text.includes("CI turned green."))).toBe(true);
    expect(deliveredTexts.some((text) => text.includes("\"job_kind\": \"watch_ci\""))).toBe(true);
  }, 60_000);

  it("nudges long-running turns to consider a Slack progress update", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-broker-e2e-"));
    cleanups.push(async () => {
      await fs.rm(tempRoot, { force: true, recursive: true });
    });

    const mockSlack = new MockSlackServer("UBOT", {
      botId: "BBOT",
      appId: "AAPP"
    });
    const mockCodex = new MockCodexAppServer({
      onTurnStart: async (context) => {
        await delay(900);
        context.complete("");
      }
    });
    const slackPort = await mockSlack.start();
    const codexUrl = await mockCodex.start();
    cleanups.push(async () => {
      await mockCodex.stop();
      await mockSlack.stop();
    });

    const broker = await startBrokerProcess({
      port: await getFreePort(),
      slackPort,
      codexUrl,
      tempRoot,
      extraEnv: {
        SLACK_ACTIVE_TURN_RECONCILE_INTERVAL_MS: "100",
        SLACK_PROGRESS_REMINDER_AFTER_MS: "200",
        SLACK_PROGRESS_REMINDER_REPEAT_MS: "200"
      }
    });
    cleanups.push(() => broker.stop());

    await mockSlack.sendEvent("evt-session", {
      type: "app_mention",
      user: "U123",
      channel: "C123",
      thread_ts: "444.220",
      ts: "444.221",
      text: "<@UBOT> 花点时间调研一下"
    });

    await waitFor(() => mockCodex.turnsStarted.length >= 1, "initial long-running turn");
    await waitFor(
      () =>
        mockCodex.steers.some((steer) =>
          collectTextInput(steer.input).includes("This is only a reminder, not a command to send filler.")
        ),
      "progress reminder steer"
    );

    const reminder = mockCodex.steers.find((steer) =>
      collectTextInput(steer.input).includes("This is only a reminder, not a command to send filler.")
    );
    expect(reminder).toBeTruthy();
    expect(collectTextInput(reminder!.input)).toContain("If yes, send a short Slack update. If not, keep working.");
    await waitForSessionIdle(tempRoot, "C123:444.220");
  }, 60_000);

  it("does not recover the broker's own Slack messages as inbound work", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-broker-e2e-"));
    cleanups.push(async () => {
      await fs.rm(tempRoot, { force: true, recursive: true });
    });

    const brokerPort = await getFreePort();
    const brokerBaseUrl = `http://127.0.0.1:${brokerPort}`;
    const mockSlack = new MockSlackServer("UBOT", {
      botId: "BBOT",
      appId: "AAPP"
    });
    const mockCodex = new MockCodexAppServer({
      onTurnStart: async () => {
        await postJson(`${brokerBaseUrl}/slack/post-message`, {
          channel_id: "C123",
          thread_ts: "555.220",
          text: "broker self reply"
        });
      }
    });
    const slackPort = await mockSlack.start();
    const codexUrl = await mockCodex.start();
    cleanups.push(async () => {
      await mockCodex.stop();
      await mockSlack.stop();
    });

    const broker = await startBrokerProcess({
      port: brokerPort,
      slackPort,
      codexUrl,
      tempRoot
    });
    cleanups.push(() => broker.stop());

    await mockSlack.sendEvent("evt-session", {
      type: "app_mention",
      user: "U123",
      channel: "C123",
      thread_ts: "555.220",
      ts: "555.221",
      text: "<@UBOT> 触发一次回复"
    });
    await waitFor(() => mockCodex.turnsStarted.length >= 1, "initial turn");
    await waitFor(() => mockSlack.postedMessages.some((message) => message.text === "broker self reply"), "bot reply");
    await waitForSessionIdle(tempRoot, "C123:555.220");

    await broker.stop();
    cleanups.pop();

    const restarted = await startBrokerProcess({
      port: brokerPort,
      slackPort,
      codexUrl,
      tempRoot
    });
    cleanups.push(() => restarted.stop());

    await delay(2_000);
    expect(mockCodex.turnsStarted).toHaveLength(1);
  }, 60_000);
});

async function startBrokerProcess(options: {
  readonly port: number;
  readonly slackPort: number;
  readonly codexUrl: string;
  readonly tempRoot: string;
  readonly extraEnv?: Record<string, string>;
}): Promise<{
  readonly baseUrl: string;
  readonly stop: () => Promise<void>;
  readonly logs: readonly string[];
}> {
  const logs: string[] = [];
  const child = spawn("pnpm", ["exec", "tsx", "src/index.ts"], {
    cwd: brokerRoot,
    env: {
      ...process.env,
      ...options.extraEnv,
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_API_BASE_URL: `http://127.0.0.1:${options.slackPort}/api`,
      SLACK_SOCKET_OPEN_URL: "apps.connections.open",
      SLACK_INITIAL_THREAD_HISTORY_COUNT: "8",
      SLACK_HISTORY_API_MAX_LIMIT: "50",
      STATE_DIR: path.join(options.tempRoot, "state"),
      SESSIONS_ROOT: path.join(options.tempRoot, "sessions"),
      REPOS_ROOT: path.join(options.tempRoot, "repos"),
      JOBS_ROOT: path.join(options.tempRoot, "jobs"),
      CODEX_HOME: path.join(options.tempRoot, "codex-home"),
      PORT: String(options.port),
      BROKER_HTTP_BASE_URL: `http://127.0.0.1:${options.port}`,
      CODEX_APP_SERVER_URL: options.codexUrl,
      DEBUG: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => {
    logs.push(chunk.toString());
  });
  child.stderr.on("data", (chunk) => {
    logs.push(chunk.toString());
  });

  await waitForHttpReady(`http://127.0.0.1:${options.port}`, logs);

  return {
    baseUrl: `http://127.0.0.1:${options.port}`,
    logs,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }

      child.kill("SIGTERM");
      const graceful = await Promise.race([
        once(child, "exit").then(() => true),
        delay(5_000).then(() => false)
      ]);
      if (graceful) {
        return;
      }

      child.kill("SIGKILL");
      await once(child, "exit");
    }
  };
}

async function waitForHttpReady(url: string, logs: readonly string[], timeoutMs = DEFAULT_E2E_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // ignore and retry
    }

    await delay(200);
  }

  throw new Error(`Timed out waiting for broker readiness: ${url}\n${logs.join("")}`);
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = DEFAULT_E2E_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(100);
  }

  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForSessionIdle(
  tempRoot: string,
  sessionKey: string,
  timeoutMs = DEFAULT_E2E_TIMEOUT_MS
): Promise<void> {
  const sessionFile = path.join(
    tempRoot,
    "state",
    "sessions",
    `${Buffer.from(sessionKey, "utf8").toString("base64url")}.json`
  );
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(sessionFile, "utf8");
      const session = JSON.parse(raw) as {
        readonly activeTurnId?: string | undefined;
      };
      if (!session.activeTurnId) {
        return;
      }
    } catch {
      // session file may not exist yet
    }

    await delay(100);
  }

  throw new Error(`Timed out waiting for session idle: ${sessionKey}`);
}

async function delay(timeoutMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

async function getFreePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to allocate free port");
  }

  const port = address.port;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return port;
}

function collectTextInput(input: readonly CodexInputItem[]): string {
  return input
    .filter((item): item is Extract<CodexInputItem, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

async function postJson(url: string, payload: Record<string, unknown>): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}: ${await response.text()}`);
  }
}
