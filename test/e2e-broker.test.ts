import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { CodexInputItem } from "../src/services/codex/app-server-client.js";
import { SessionManager } from "../src/services/session-manager.js";
import { StateStore } from "../src/store/state-store.js";
import type { PersistedInboundMessage, SlackSessionRecord } from "../src/types.js";
import { MockCodexAppServer } from "./helpers/mock-codex-app-server.js";
import { MockSlackServer } from "./manual/mock-slack-server.js";

const brokerRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const DEFAULT_E2E_TIMEOUT_MS = 30_000;

describe.sequential("slack-codex-broker e2e", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      await cleanup?.();
    }
  });

  it("shows Slack assistant thread status while a turn is running and clears it after replying", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-broker-e2e-"));
    cleanups.push(async () => {
      await removeTempRoot(tempRoot);
    });

    let brokerBaseUrl = "";
    const mockSlack = new MockSlackServer("UBOT", {
      botId: "BBOT",
      appId: "AAPP"
    });
    const mockCodex = new MockCodexAppServer({
      onTurnStart: async (context) => {
        await waitFor(() => {
          return mockSlack.assistantStatusUpdates.some((update) => update.status === "Thinking...");
        }, "assistant thinking status");

        const response = await fetch(`${brokerBaseUrl}/slack/post-message`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded; charset=utf-8"
          },
          body: new URLSearchParams({
            channel_id: "C123",
            thread_ts: "110.220",
            text: "STATUS_REPLY_OK",
            kind: "final"
          }).toString()
        });
        if (!response.ok) {
          throw new Error(`Failed to post broker Slack reply: ${response.status}`);
        }

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
      tempRoot
    });
    brokerBaseUrl = broker.baseUrl;
    cleanups.push(() => broker.stop());

    await mockSlack.sendEvent("evt-status-mention", {
      type: "app_mention",
      user: "U123",
      channel: "C123",
      thread_ts: "110.220",
      ts: "110.221",
      text: "<@UBOT> status test"
    });

    await waitFor(() => {
      return mockSlack.assistantStatusUpdates.some((update) => update.status === "Thinking...");
    }, "assistant thinking status call");
    await waitFor(() => {
      return mockSlack.postedMessages.some((message) => message.text === "STATUS_REPLY_OK");
    }, "broker-posted Slack reply");
    await waitFor(() => {
      return mockSlack.assistantStatusUpdates.some((update) => update.status === "");
    }, "assistant status clear");

    expect(mockSlack.assistantStatusUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "C123",
          threadTs: "110.220",
          status: "Thinking...",
          loadingMessages: "Thinking..."
        }),
        expect.objectContaining({
          channel: "C123",
          threadTs: "110.220",
          status: ""
        })
      ])
    );
  }, 90_000);

  it("falls back to an eyes reaction when Slack assistant status is unavailable", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-broker-e2e-"));
    cleanups.push(async () => {
      await removeTempRoot(tempRoot);
    });

    let brokerBaseUrl = "";
    const mockSlack = new MockSlackServer("UBOT", {
      botId: "BBOT",
      appId: "AAPP",
      assistantStatusError: "unknown_method"
    });
    const mockCodex = new MockCodexAppServer({
      onTurnStart: async (context) => {
        await waitFor(() => {
          return mockSlack.reactionOperations.some((operation) => (
            operation.action === "add" &&
            operation.channel === "C123" &&
            operation.timestamp === "120.220" &&
            operation.name === "eyes"
          ));
        }, "assistant fallback reaction add");

        const response = await fetch(`${brokerBaseUrl}/slack/post-message`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded; charset=utf-8"
          },
          body: new URLSearchParams({
            channel_id: "C123",
            thread_ts: "120.220",
            text: "FALLBACK_REPLY_OK",
            kind: "final"
          }).toString()
        });
        if (!response.ok) {
          throw new Error(`Failed to post broker Slack reply: ${response.status}`);
        }

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
      tempRoot
    });
    brokerBaseUrl = broker.baseUrl;
    cleanups.push(() => broker.stop());

    await mockSlack.sendEvent("evt-fallback-mention", {
      type: "app_mention",
      user: "U123",
      channel: "C123",
      thread_ts: "120.220",
      ts: "120.221",
      text: "<@UBOT> fallback test"
    });

    await waitFor(() => {
      return mockSlack.reactionOperations.some((operation) => (
        operation.action === "add" &&
        operation.channel === "C123" &&
        operation.timestamp === "120.220" &&
        operation.name === "eyes"
      ));
    }, "assistant fallback reaction add");
    await waitFor(() => {
      return mockSlack.postedMessages.some((message) => message.text === "FALLBACK_REPLY_OK");
    }, "fallback broker-posted Slack reply");
    await waitFor(() => {
      return mockSlack.reactionOperations.some((operation) => (
        operation.action === "remove" &&
        operation.channel === "C123" &&
        operation.timestamp === "120.220" &&
        operation.name === "eyes"
      ));
    }, "assistant fallback reaction clear");

    expect(mockSlack.assistantStatusUpdates).toHaveLength(0);
  }, 90_000);

  it("starts a new session, backfills history, and forwards full Slack card payloads", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-broker-e2e-"));
    cleanups.push(async () => {
      await removeTempRoot(tempRoot);
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
  }, 90_000);

  it("replays missed thread messages after restart as a single recovered batch", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-broker-e2e-"));
    cleanups.push(async () => {
      await removeTempRoot(tempRoot);
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
  }, 90_000);

  it("starts a fresh turn instead of resyncing back to an older active turn after a steer mismatch reset", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-broker-e2e-"));
    cleanups.push(async () => {
      await removeTempRoot(tempRoot);
    });

    let turnStartCount = 0;
    let releaseFirstTurn: (() => void) | undefined;
    const firstTurnGate = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve;
    });
    const mockSlack = new MockSlackServer("UBOT", {
      botId: "BBOT",
      appId: "AAPP"
    });
    const mockCodex = new MockCodexAppServer({
      onTurnStart: async (context) => {
        turnStartCount += 1;
        if (turnStartCount === 1) {
          await firstTurnGate;
          return;
        }
        if (turnStartCount >= 2) {
          context.complete("RECOVERED_AFTER_MISMATCH");
        }
      }
    });
    const slackPort = await mockSlack.start();
    const codexUrl = await mockCodex.start();
    cleanups.push(async () => {
      await mockCodex.stop();
      await mockSlack.stop();
    });
    cleanups.push(async () => {
      releaseFirstTurn?.();
    });

    const port = await getFreePort();
    const sessionKey = "C123:223.220";
    const broker = await startBrokerProcess({
      port,
      slackPort,
      codexUrl,
      tempRoot,
      extraEnv: {
        SLACK_ACTIVE_TURN_RECONCILE_INTERVAL_MS: "100",
        SLACK_MISSED_THREAD_RECOVERY_INTERVAL_MS: "100",
        SLACK_STALE_IDLE_RUNTIME_RESET_AFTER_MS: "100"
      }
    });
    cleanups.push(() => broker.stop());

    await mockSlack.sendEvent("evt-steer-mismatch-session", {
      type: "app_mention",
      user: "U123",
      channel: "C123",
      thread_ts: "223.220",
      ts: "223.221",
      text: "<@UBOT> keep this turn running"
    });

    await waitFor(() => mockCodex.turnsStarted.length >= 1, "initial active turn");
    await waitForSessionActive(tempRoot, sessionKey);
    await broker.stop();
    cleanups.pop();

    const writerStore = new StateStore(path.join(tempRoot, "state"), path.join(tempRoot, "sessions"));
    const writerSessions = new SessionManager({
      stateStore: writerStore,
      sessionsRoot: path.join(tempRoot, "sessions")
    });
    await writerSessions.load();
    const existingSession = writerSessions.getSession("C123", "223.220");
    expect(existingSession?.activeTurnId).toBeTruthy();

    const fakeTurnId = "turn-fake-new";
    const fakeActiveSession = await writerSessions.setActiveTurnId("C123", "223.220", fakeTurnId);
    expect(fakeActiveSession.activeTurnId).toBe(fakeTurnId);
    const inflightMessages = writerSessions.listInboundMessages({
      channelId: "C123",
      rootThreadTs: "223.220",
      status: "inflight"
    });
    expect(inflightMessages.length).toBeGreaterThan(0);
    await writerSessions.updateInboundMessagesForBatch(
      "C123",
      "223.220",
      inflightMessages.map((message) => message.messageTs),
      {
        status: "inflight",
        batchId: fakeTurnId
      }
    );

    mockSlack.recordThreadMessage({
      channel: "C123",
      threadTs: "223.220",
      ts: "223.222",
      text: "MISSED_AFTER_MISMATCH",
      user: "U234"
    });
    const codexThread = existingSession?.codexThreadId ? mockCodex.getThread(existingSession.codexThreadId) : undefined;
    if (codexThread) {
      codexThread.activeTurnId = undefined;
      for (const turn of codexThread.turns) {
        if (turn.status === "inProgress") {
          turn.status = "interrupted";
        }
      }
    }

    const restarted = await startBrokerProcess({
      port,
      slackPort,
      codexUrl,
      tempRoot,
      extraEnv: {
        SLACK_ACTIVE_TURN_RECONCILE_INTERVAL_MS: "100",
        SLACK_MISSED_THREAD_RECOVERY_INTERVAL_MS: "100",
        SLACK_STALE_IDLE_RUNTIME_RESET_AFTER_MS: "100"
      }
    });
    cleanups.push(() => restarted.stop());

    try {
      await waitFor(() => mockCodex.turnsStarted.length >= 2, "replacement turn after steer mismatch", 60_000);
    } catch (error) {
      console.error(restarted.logs.join("").slice(-8_000));
      throw error;
    }
    await waitForSessionIdle(tempRoot, sessionKey);

    const recoveredTurnText = collectTextInput(mockCodex.turnsStarted[1]!.input);
    expect(recoveredTurnText).toContain("recovered_message_batch_json");
    expect(recoveredTurnText).toContain("MISSED_AFTER_MISMATCH");

    const finalSession = await readSessionRecord(tempRoot, sessionKey);
    expect(finalSession.activeTurnId).toBeUndefined();
    expect(finalSession.lastDeliveredMessageTs).toBe("223.222");

    const finalInbound = await readInboundMessages(tempRoot, sessionKey);
    expect(finalInbound.filter((message) => message.status !== "done")).toHaveLength(0);
  }, 120_000);

  it("periodically recovers missed thread replies without requiring a socket reconnect", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-broker-e2e-"));
    cleanups.push(async () => {
      await removeTempRoot(tempRoot);
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
      tempRoot,
      extraEnv: {
        SLACK_ACTIVE_TURN_RECONCILE_INTERVAL_MS: "100",
        SLACK_MISSED_THREAD_RECOVERY_INTERVAL_MS: "100",
        SLACK_STALE_IDLE_RUNTIME_RESET_AFTER_MS: "100"
      }
    });
    cleanups.push(() => broker.stop());

    await mockSlack.sendEvent("evt-periodic-session", {
      type: "app_mention",
      user: "U123",
      channel: "C123",
      thread_ts: "333.220",
      ts: "333.221",
      text: "<@UBOT> 开个 session"
    });
    await waitFor(() => mockCodex.turnsStarted.length >= 1, "session bootstrap turn");
    await waitForSessionIdle(tempRoot, "C123:333.220");

    mockSlack.recordThreadMessage({
      channel: "C123",
      threadTs: "333.220",
      ts: "333.222",
      text: "漏掉的周期性恢复消息",
      user: "U234"
    });

    await waitFor(() => {
      const deliveredTexts = [
        ...mockCodex.turnsStarted.slice(1).map((turn) => collectTextInput(turn.input)),
        ...mockCodex.steers.map((steer) => collectTextInput(steer.input))
      ];
      return deliveredTexts.some((text) => text.includes("漏掉的周期性恢复消息"));
    }, "periodic recovered thread reply");

    const deliveredTexts = [
      ...mockCodex.turnsStarted.slice(1).map((turn) => collectTextInput(turn.input)),
      ...mockCodex.steers.map((steer) => collectTextInput(steer.input))
    ];
    const recoveredText = deliveredTexts.find((text) => text.includes("漏掉的周期性恢复消息")) ?? "";
    expect(recoveredText).toContain("recovered_message_batch_json");
    expect(recoveredText).toContain("\"recovery_kind\": \"missed_thread_messages\"");
    expect(recoveredText).toContain("漏掉的周期性恢复消息");
  }, 90_000);

  it("recovers persisted pending backlog on startup when a session has no active turn", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-broker-e2e-"));
    cleanups.push(async () => {
      await removeTempRoot(tempRoot);
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
      thread_ts: "666.220",
      ts: "666.221",
      text: "<@UBOT> 开个 session"
    });
    await waitFor(() => mockCodex.turnsStarted.length >= 1, "session bootstrap turn");
    await waitForSessionIdle(tempRoot, "C123:666.220");
    await broker.stop();
    cleanups.pop();

    const stateStore = new StateStore(path.join(tempRoot, "state"), path.join(tempRoot, "sessions"));
    const sessions = new SessionManager({
      stateStore,
      sessionsRoot: path.join(tempRoot, "sessions")
    });
    await sessions.load();
    const session = sessions.getSession("C123", "666.220");
    expect(session).toBeTruthy();

    const now = new Date().toISOString();
    const pendingMessage: PersistedInboundMessage = {
      key: `C123:666.220:666.222`,
      sessionKey: "C123:666.220",
      channelId: "C123",
      rootThreadTs: "666.220",
      messageTs: "666.222",
      source: "thread_reply",
      userId: "U234",
      text: "BOOT_PENDING_RECOVERY",
      senderKind: "user",
      mentionedUserIds: [],
      images: [],
      slackMessage: {
        type: "message",
        user: "U234",
        ts: "666.222",
        text: "BOOT_PENDING_RECOVERY",
        thread_ts: "666.220",
        channel: "C123"
      },
      status: "pending",
      createdAt: now,
      updatedAt: now
    };
    await sessions.upsertInboundMessage(pendingMessage);

    const restarted = await startBrokerProcess({
      port,
      slackPort,
      codexUrl,
      tempRoot
    });
    cleanups.push(() => restarted.stop());

    await waitFor(() => {
      const deliveredTexts = mockCodex.turnsStarted.slice(1).map((turn) => collectTextInput(turn.input));
      return deliveredTexts.some((text) => text.includes("BOOT_PENDING_RECOVERY"));
    }, "startup recovery of persisted pending backlog");
  }, 90_000);

  it("reclaims sessions older than the hard protection window even when they still look active", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-broker-e2e-"));
    cleanups.push(async () => {
      await removeTempRoot(tempRoot);
    });

    const stateStore = new StateStore(path.join(tempRoot, "state"), path.join(tempRoot, "sessions"));
    const sessions = new SessionManager({
      stateStore,
      sessionsRoot: path.join(tempRoot, "sessions")
    });
    await sessions.load();

    const oldAt = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    const protectedAt = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
    const recentStateWriteAt = new Date().toISOString();
    const staleSession = await sessions.ensureSession("CSTALE", "777.100");
    await stateStore.upsertSession({
      ...staleSession,
      activeTurnId: "turn-stale",
      activeTurnStartedAt: oldAt,
      createdAt: oldAt,
      updatedAt: recentStateWriteAt
    });
    await fs.writeFile(path.join(staleSession.workspacePath, "marker.txt"), "stale active session");

    const staleJobDir = path.join(tempRoot, "jobs", "job-stale-active");
    await fs.mkdir(staleJobDir, { recursive: true });
    const staleJobScript = path.join(staleJobDir, "run.sh");
    await fs.writeFile(staleJobScript, "#!/bin/sh\nsleep 300\n");
    await fs.chmod(staleJobScript, 0o755);
    await sessions.upsertBackgroundJob({
      id: "job-stale-active",
      token: "token-stale-active",
      sessionKey: staleSession.key,
      channelId: staleSession.channelId,
      rootThreadTs: staleSession.rootThreadTs,
      kind: "watch_ci",
      shell: "sh",
      cwd: staleSession.workspacePath,
      scriptPath: staleJobScript,
      restartOnBoot: true,
      status: "running",
      createdAt: oldAt,
      updatedAt: oldAt,
      startedAt: oldAt,
      heartbeatAt: oldAt
    });

    const protectedSession = await sessions.ensureSession("CPROTECTED", "888.100");
    await stateStore.upsertSession({
      ...protectedSession,
      createdAt: protectedAt,
      updatedAt: protectedAt
    });
    await fs.writeFile(path.join(protectedSession.workspacePath, "marker.txt"), "protected job session");

    const protectedJobDir = path.join(tempRoot, "jobs", "job-protected");
    await fs.mkdir(protectedJobDir, { recursive: true });
    const protectedJobScript = path.join(protectedJobDir, "run.sh");
    await fs.writeFile(protectedJobScript, "#!/bin/sh\nsleep 300\n");
    await fs.chmod(protectedJobScript, 0o755);
    await sessions.upsertBackgroundJob({
      id: "job-protected",
      token: "token-protected",
      sessionKey: protectedSession.key,
      channelId: protectedSession.channelId,
      rootThreadTs: protectedSession.rootThreadTs,
      kind: "watch_ci",
      shell: "sh",
      cwd: protectedSession.workspacePath,
      scriptPath: protectedJobScript,
      restartOnBoot: true,
      status: "running",
      createdAt: protectedAt,
      updatedAt: protectedAt,
      startedAt: protectedAt,
      heartbeatAt: protectedAt
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
      tempRoot,
      extraEnv: {
        DISK_CLEANUP_MIN_FREE_BYTES: "1000000000000000",
        DISK_CLEANUP_TARGET_FREE_BYTES: "1000000000000000",
        DISK_CLEANUP_INACTIVE_SESSION_MS: String(24 * 60 * 60 * 1000),
        DISK_CLEANUP_JOB_PROTECTION_MS: String(48 * 60 * 60 * 1000),
        DISK_CLEANUP_OLD_LOG_MS: String(24 * 60 * 60 * 1000)
      }
    });
    cleanups.push(() => broker.stop());

    await waitFor(async () => !(await pathExists(staleSession.workspacePath)), "stale active session cleanup");
    await stateStore.load();

    expect(sessions.getSessionByKey(staleSession.key)).toBeUndefined();
    expect(sessions.getBackgroundJob("job-stale-active")).toBeUndefined();
    expect(await pathExists(staleJobDir)).toBe(false);
    expect(sessions.getSessionByKey(protectedSession.key)).toBeDefined();
    expect(await pathExists(protectedSession.workspacePath)).toBe(true);
    expect(await pathExists(protectedJobDir)).toBe(true);
  }, 90_000);

  it("injects background job events back into the same session", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-broker-e2e-"));
    cleanups.push(async () => {
      await removeTempRoot(tempRoot);
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

  it("does not wake an unexpected-stop turn after a routine running job event stays silent", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-broker-e2e-"));
    cleanups.push(async () => {
      await removeTempRoot(tempRoot);
    });

    const brokerPort = await getFreePort();
    const brokerBaseUrl = `http://127.0.0.1:${brokerPort}`;
    const mockSlack = new MockSlackServer("UBOT", {
      botId: "BBOT",
      appId: "AAPP"
    });
    let turnCount = 0;
    const mockCodex = new MockCodexAppServer({
      onTurnStart: async (context) => {
        turnCount += 1;
        if (turnCount === 1) {
          await postJson(`${brokerBaseUrl}/slack/post-state`, {
            channel_id: "C123",
            thread_ts: "334.220",
            kind: "final"
          });
        }
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
      thread_ts: "334.220",
      ts: "334.221",
      text: "<@UBOT> 先起一个 session"
    });
    await waitFor(() => mockCodex.turnsStarted.length >= 1, "initial turn");
    await waitForSessionIdle(tempRoot, "C123:334.220");

    const registerResponse = await fetch(`${broker.baseUrl}/jobs/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        channel_id: "C123",
        thread_ts: "334.220",
        kind: "watch_ci",
        script: "#!/bin/sh\nsleep 30"
      })
    });
    const registerBody = await registerResponse.json() as {
      job?: { id: string; token: string };
    };
    expect(registerResponse.ok).toBe(true);

    await postJson(`${broker.baseUrl}/jobs/${registerBody.job!.id}/event`, {
      token: registerBody.job!.token,
      event_kind: "state_changed",
      summary: "CI is still pending."
    });

    await waitFor(() => mockCodex.turnsStarted.length >= 2, "background event turn");
    await waitForSessionIdle(tempRoot, "C123:334.220");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(mockCodex.turnsStarted).toHaveLength(2);

    await postJson(`${broker.baseUrl}/jobs/${registerBody.job!.id}/cancel`, {
      token: registerBody.job!.token
    });
  }, 60_000);

  it("nudges long-running turns to consider a Slack progress update", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-broker-e2e-"));
    cleanups.push(async () => {
      await removeTempRoot(tempRoot);
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

  it("wakes a turn that ends without an explicit final, block, or wait state", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-broker-e2e-"));
    cleanups.push(async () => {
      await removeTempRoot(tempRoot);
    });

    const mockSlack = new MockSlackServer("UBOT", {
      botId: "BBOT",
      appId: "AAPP"
    });
    let turnCount = 0;
    const mockCodex = new MockCodexAppServer({
      onTurnStart: async (context) => {
        turnCount += 1;
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
      tempRoot
    });
    cleanups.push(() => broker.stop());

    await mockSlack.sendEvent("evt-session", {
      type: "app_mention",
      user: "U123",
      channel: "C123",
      thread_ts: "666.220",
      ts: "666.221",
      text: "<@UBOT> 继续把这个做完"
    });

    await waitFor(() => mockCodex.turnsStarted.length >= 2, "unexpected stop wake turn", 120_000);
    const wakeText = collectTextInput(mockCodex.turnsStarted[1]!.input);
    expect(wakeText).toContain("unexpected_turn_stop_json");
    expect(wakeText).toContain("explicit final, block, or wait state");
    await waitForSessionIdle(tempRoot, "C123:666.220");
    expect(turnCount).toBe(2);
  }, 150_000);

  it("wakes a wait turn when no running async job backs that wait state", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-broker-e2e-"));
    cleanups.push(async () => {
      await removeTempRoot(tempRoot);
    });

    const brokerPort = await getFreePort();
    const brokerBaseUrl = `http://127.0.0.1:${brokerPort}`;
    const mockSlack = new MockSlackServer("UBOT", {
      botId: "BBOT",
      appId: "AAPP"
    });
    let turnCount = 0;
    const mockCodex = new MockCodexAppServer({
      onTurnStart: async () => {
        turnCount += 1;
        if (turnCount === 1) {
          await postJson(`${brokerBaseUrl}/slack/post-state`, {
            channel_id: "C123",
            thread_ts: "777.220",
            kind: "wait",
            reason: "waiting for async job"
          });
        }
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
      thread_ts: "777.220",
      ts: "777.221",
      text: "<@UBOT> 盯一下这个"
    });

    await waitFor(() => mockCodex.turnsStarted.length >= 2, "wait-without-job wake turn");
    const wakeText = collectTextInput(mockCodex.turnsStarted[1]!.input);
    expect(wakeText).toContain("unexpected_turn_stop_json");
    expect(wakeText).toContain("there is no running broker-managed async job");
    await waitForSessionIdle(tempRoot, "C123:777.220");
    expect(turnCount).toBe(2);
  }, 60_000);

  it("does not wake a silent wait turn when a running async job backs that wait state", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-broker-e2e-"));
    cleanups.push(async () => {
      await removeTempRoot(tempRoot);
    });

    const brokerPort = await getFreePort();
    const brokerBaseUrl = `http://127.0.0.1:${brokerPort}`;
    const mockSlack = new MockSlackServer("UBOT", {
      botId: "BBOT",
      appId: "AAPP"
    });
    let turnCount = 0;
    const mockCodex = new MockCodexAppServer({
      onTurnStart: async () => {
        turnCount += 1;
        if (turnCount === 1) {
          const registerResponse = await fetch(`${brokerBaseUrl}/jobs/register`, {
            method: "POST",
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({
              channel_id: "C123",
              thread_ts: "778.220",
              kind: "watch_ci",
              script: "#!/bin/sh\nsleep 30"
            })
          });
          expect(registerResponse.ok).toBe(true);

          await postJson(`${brokerBaseUrl}/slack/post-state`, {
            channel_id: "C123",
            thread_ts: "778.220",
            kind: "wait",
            reason: "waiting for async job"
          });
        }
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
      thread_ts: "778.220",
      ts: "778.221",
      text: "<@UBOT> 盯一下这个"
    });

    await waitForSessionIdle(tempRoot, "C123:778.220");
    const postedMessageCountAfterIdle = mockSlack.postedMessages.length;
    await delay(1_000);
    expect(turnCount).toBe(1);
    expect(mockSlack.postedMessages).toHaveLength(postedMessageCountAfterIdle);
  }, 60_000);

  it("does not wake a silent block turn that already recorded its blocker", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-broker-e2e-"));
    cleanups.push(async () => {
      await removeTempRoot(tempRoot);
    });

    const brokerPort = await getFreePort();
    const brokerBaseUrl = `http://127.0.0.1:${brokerPort}`;
    const mockSlack = new MockSlackServer("UBOT", {
      botId: "BBOT",
      appId: "AAPP"
    });
    let turnCount = 0;
    const mockCodex = new MockCodexAppServer({
      onTurnStart: async () => {
        turnCount += 1;
        if (turnCount === 1) {
          await postJson(`${brokerBaseUrl}/slack/post-state`, {
            channel_id: "C123",
            thread_ts: "779.220",
            kind: "block",
            reason: "waiting for user approval"
          });
        }
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
      thread_ts: "779.220",
      ts: "779.221",
      text: "<@UBOT> 这步先停住"
    });

    await waitForSessionIdle(tempRoot, "C123:779.220");
    const postedMessageCountAfterIdle = mockSlack.postedMessages.length;
    await delay(1_000);
    expect(turnCount).toBe(1);
    expect(mockSlack.postedMessages).toHaveLength(postedMessageCountAfterIdle);
  }, 60_000);

  it("does not wake a silent final turn or replay stale watcher events after completion", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-broker-e2e-"));
    cleanups.push(async () => {
      await removeTempRoot(tempRoot);
    });

    const brokerPort = await getFreePort();
    const brokerBaseUrl = `http://127.0.0.1:${brokerPort}`;
    const mockSlack = new MockSlackServer("UBOT", {
      botId: "BBOT",
      appId: "AAPP"
    });
    let turnCount = 0;
    let registeredJobId = "";
    let registeredJobToken = "";
    const mockCodex = new MockCodexAppServer({
      onTurnStart: async () => {
        turnCount += 1;
        if (turnCount === 1) {
          const registerResponse = await fetch(`${brokerBaseUrl}/jobs/register`, {
            method: "POST",
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({
              channel_id: "C123",
              thread_ts: "780.220",
              kind: "watch_ci",
              script: "#!/bin/sh\nsleep 30"
            })
          });
          expect(registerResponse.ok).toBe(true);
          const registerJson = await registerResponse.json() as {
            job: { id: string; token: string };
          };
          registeredJobId = registerJson.job.id;
          registeredJobToken = registerJson.job.token;

          await postJson(`${brokerBaseUrl}/slack/post-state`, {
            channel_id: "C123",
            thread_ts: "780.220",
            kind: "final"
          });
        }
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
      thread_ts: "780.220",
      ts: "780.221",
      text: "<@UBOT> 合并之后继续盯一下"
    });

    await waitForSessionIdle(tempRoot, "C123:780.220");
    expect(turnCount).toBe(1);
    expect(registeredJobId).not.toBe("");
    expect(registeredJobToken).not.toBe("");

    const postedMessageCountAfterIdle = mockSlack.postedMessages.length;
    const eventResponse = await fetch(`${brokerBaseUrl}/jobs/${registeredJobId}/event`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        token: registeredJobToken,
        event_kind: "state_changed",
        summary: "PR merged on main"
      })
    });
    expect(eventResponse.ok).toBe(true);

    await delay(1_000);
    expect(turnCount).toBe(1);
    expect(mockSlack.postedMessages).toHaveLength(postedMessageCountAfterIdle);
  }, 60_000);

  it("does not recover the broker's own Slack messages as inbound work", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-broker-e2e-"));
    cleanups.push(async () => {
      await removeTempRoot(tempRoot);
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
    await waitFor(
      () => mockSlack.postedMessages.some((message) => message.text === "broker self reply"),
      "bot reply",
      30_000
    );
    await waitForSessionIdle(tempRoot, "C123:555.220", 30_000);
    const turnCountBeforeRestart = mockCodex.turnsStarted.length;

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
    expect(mockCodex.turnsStarted).toHaveLength(turnCountBeforeRestart);
  }, 60_000);

  it("converts markdownish Slack posts to mrkdwn before delivery", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-broker-e2e-"));
    cleanups.push(async () => {
      await removeTempRoot(tempRoot);
    });

    const brokerPort = await getFreePort();
    const brokerBaseUrl = `http://127.0.0.1:${brokerPort}`;
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
      port: brokerPort,
      slackPort,
      codexUrl,
      tempRoot
    });
    cleanups.push(() => broker.stop());

    await mockSlack.sendEvent("evt-format-session", {
      type: "app_mention",
      user: "U123",
      channel: "C123",
      thread_ts: "777.220",
      ts: "777.221",
      text: "<@UBOT> 开个 session"
    });
    await waitFor(() => mockCodex.turnsStarted.length >= 1, "format session bootstrap turn");
    await waitForSessionIdle(tempRoot, "C123:777.220");

    await postJson(`${brokerBaseUrl}/slack/post-message`, {
      channel_id: "C123",
      thread_ts: "777.220",
      text: "## Summary\n- **done**\n- [docs](https://example.com)\n- `https://linear.app/settings/api`"
    });

    await waitFor(
      () => mockSlack.postedMessages.some((message) => message.threadTs === "777.220" && message.text.includes("*Summary*")),
      "converted slack markdown post"
    );

    const posted = mockSlack.postedMessages.find((message) => message.threadTs === "777.220" && message.text.includes("*Summary*"));
    expect(posted?.text).toBe(
      "*Summary*\n• *done*\n• <https://example.com|docs>\n• `https://linear.\u200Bapp/settings/api`"
    );
  }, 60_000);

  it("chunks long Slack posts after markdownish conversion", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-broker-e2e-"));
    cleanups.push(async () => {
      await removeTempRoot(tempRoot);
    });

    const brokerPort = await getFreePort();
    const brokerBaseUrl = `http://127.0.0.1:${brokerPort}`;
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
      port: brokerPort,
      slackPort,
      codexUrl,
      tempRoot
    });
    cleanups.push(() => broker.stop());

    await mockSlack.sendEvent("evt-long-format-session", {
      type: "app_mention",
      user: "U123",
      channel: "C123",
      thread_ts: "888.220",
      ts: "888.221",
      text: "<@UBOT> 开个 session"
    });
    await waitFor(() => mockCodex.turnsStarted.length >= 1, "long format session bootstrap turn");
    await waitForSessionIdle(tempRoot, "C123:888.220");

    const markdownUnit = "1. **item**\n";
    const mrkdwnUnit = "1. *item*\n";
    const markdown = markdownUnit.repeat(400).trimEnd();

    await postJson(`${brokerBaseUrl}/slack/post-message`, {
      channel_id: "C123",
      thread_ts: "888.220",
      text: markdown
    });

    await waitFor(
      () =>
        mockSlack.postedMessages.filter(
          (message) => message.threadTs === "888.220" && message.text.startsWith("1. *item*")
        ).length >= 2,
      "multi-chunk converted slack post"
    );

    const posted = mockSlack.postedMessages.filter(
      (message) => message.threadTs === "888.220" && message.text.startsWith("1. *item*")
    );
    expect(posted).toHaveLength(2);
    expect(posted[0]?.text).toBe(mrkdwnUnit.repeat(350));
    expect(posted[1]?.text).toBe(mrkdwnUnit.repeat(49) + "1. *item*");
    expect(posted[0]?.text).not.toContain("**");
    expect(posted[1]?.text).not.toContain("**");
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
  const runner = resolvePnpmRunner();
  const child = spawn(runner.command, [...runner.args, "exec", "tsx", "src/index.ts"], {
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

  child.on("error", (error) => {
    logs.push(`broker process failed to start: ${error.message}\n`);
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

function resolvePnpmRunner(): {
  readonly command: string;
  readonly args: readonly string[];
} {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath?.includes("pnpm")) {
    return {
      command: process.execPath,
      args: [npmExecPath]
    };
  }

  return {
    command: "corepack",
    args: ["pnpm"]
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

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = DEFAULT_E2E_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
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
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const session = await readSessionRecord(tempRoot, sessionKey);
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

async function waitForSessionActive(
  tempRoot: string,
  sessionKey: string,
  timeoutMs = DEFAULT_E2E_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const session = await readSessionRecord(tempRoot, sessionKey);
      if (session.activeTurnId) {
        return;
      }
    } catch {
      // session file may not exist yet
    }

    await delay(100);
  }

  throw new Error(`Timed out waiting for session active: ${sessionKey}`);
}

async function readSessionRecord(tempRoot: string, sessionKey: string): Promise<SlackSessionRecord> {
  const sessionFile = path.join(
    tempRoot,
    "state",
    "sessions",
    `${Buffer.from(sessionKey, "utf8").toString("base64url")}.json`
  );
  const raw = await fs.readFile(sessionFile, "utf8");
  return JSON.parse(raw) as SlackSessionRecord;
}

async function readInboundMessages(tempRoot: string, sessionKey: string): Promise<PersistedInboundMessage[]> {
  const inboundFile = path.join(
    tempRoot,
    "state",
    "inbound-messages",
    `${Buffer.from(sessionKey, "utf8").toString("base64url")}.json`
  );
  const raw = await fs.readFile(inboundFile, "utf8");
  return JSON.parse(raw) as PersistedInboundMessage[];
}

async function delay(timeoutMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function removeTempRoot(tempRoot: string): Promise<void> {
  let lastError: unknown = undefined;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(tempRoot, { force: true, recursive: true });
      return;
    } catch (error) {
      lastError = error;
      await delay(100 * (attempt + 1));
    }
  }

  throw lastError;
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
