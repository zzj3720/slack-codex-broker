import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { SlackConversationService } from "../src/services/slack/slack-conversation-service.js";
import type { PersistedInboundMessage, SlackSessionRecord } from "../src/types.js";

const TEST_SESSION: SlackSessionRecord = {
  key: "C123:111.222",
  channelId: "C123",
  rootThreadTs: "111.222",
  workspacePath: "/tmp/workspace",
  codexThreadId: "thread-1",
  activeTurnId: "turn-1",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

const TEST_CONFIG = {
  slackInitialThreadHistoryCount: 8,
  slackHistoryApiMaxLimit: 50,
  slackActiveTurnReconcileIntervalMs: 15_000,
  slackMissedThreadRecoveryIntervalMs: 15_000,
  slackStaleIdleRuntimeResetAfterMs: 120_000,
  slackProgressReminderAfterMs: 120_000,
  slackProgressReminderRepeatMs: 120_000
} as AppConfig;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SlackConversationService", () => {
  it("removes the Codex notification listener on stop", async () => {
    const codex = new EventEmitter();
    const listSessions = vi.fn(() => [TEST_SESSION]);
    const setAssistantThreadStatus = vi.fn(async () => undefined);

    const service = new SlackConversationService({
      config: TEST_CONFIG,
      sessions: {
        listSessions
      } as never,
      codex: codex as never,
      slackApi: {
        setAssistantThreadStatus,
        addReaction: vi.fn(),
        removeReaction: vi.fn()
      } as never,
      selfMessageFilter: {} as never
    });

    expect(codex.listenerCount("notification")).toBe(1);

    codex.emit("notification", "assistant.state", {
      thread_id: TEST_SESSION.codexThreadId,
      state: { phase: "thinking" }
    });

    await vi.waitFor(() => {
      expect(setAssistantThreadStatus).toHaveBeenCalledTimes(1);
    });

    await service.stop();

    expect(codex.listenerCount("notification")).toBe(0);
    expect(setAssistantThreadStatus).toHaveBeenCalledTimes(2);

    codex.emit("notification", "assistant.state", {
      thread_id: TEST_SESSION.codexThreadId,
      state: { phase: "thinking" }
    });

    await Promise.resolve();
    expect(setAssistantThreadStatus).toHaveBeenCalledTimes(2);
  });

  it("skips session scans for notifications without a turn or thread id", async () => {
    const codex = new EventEmitter();
    const listSessions = vi.fn(() => [TEST_SESSION]);
    const setAssistantThreadStatus = vi.fn(async () => undefined);

    const service = new SlackConversationService({
      config: TEST_CONFIG,
      sessions: {
        listSessions
      } as never,
      codex: codex as never,
      slackApi: {
        setAssistantThreadStatus,
        addReaction: vi.fn(),
        removeReaction: vi.fn()
      } as never,
      selfMessageFilter: {} as never
    });

    codex.emit("notification", "assistant.state", {
      state: { phase: "thinking" }
    });

    await Promise.resolve();

    expect(listSessions).not.toHaveBeenCalled();
    expect(setAssistantThreadStatus).not.toHaveBeenCalled();

    await service.stop();
  });

  it("converts file upload initial comments from markdownish to mrkdwn", async () => {
    const codex = new EventEmitter();
    const uploadThreadFile = vi.fn(async () => ({
      fileId: "F123"
    }));
    const setLastSlackReplyAt = vi.fn(async () => TEST_SESSION);

    const service = new SlackConversationService({
      config: TEST_CONFIG,
      sessions: {
        setLastSlackReplyAt
      } as never,
      codex: codex as never,
      slackApi: {
        uploadThreadFile,
        setAssistantThreadStatus: vi.fn(),
        addReaction: vi.fn(),
        removeReaction: vi.fn()
      } as never,
      selfMessageFilter: {} as never
    });

    await service.postSlackFile({
      channelId: "C123",
      rootThreadTs: "111.222",
      contentBase64: Buffer.from("hello world").toString("base64"),
      filename: "report.txt",
      initialComment: "## Summary\n- **done**\n- [docs](https://example.com)"
    });

    expect(uploadThreadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        initialComment: "*Summary*\n• *done*\n• <https://example.com|docs>"
      })
    );
    expect(setLastSlackReplyAt).toHaveBeenCalledTimes(1);

    await service.stop();
  });

  it("clears the active turn when a silent stop state is recorded", async () => {
    const codex = new EventEmitter();
    const recordTurnSignal = vi.fn(async () => TEST_SESSION);
    const setActiveTurnId = vi.fn(async () => ({
      ...TEST_SESSION,
      activeTurnId: undefined
    }));
    const listInboundMessages = vi.fn((): PersistedInboundMessage[] => []);

    const service = new SlackConversationService({
      config: TEST_CONFIG,
      sessions: {
        getSession: vi.fn(() => TEST_SESSION),
        recordTurnSignal,
        setActiveTurnId,
        listInboundMessages,
        updateInboundMessagesForBatch: vi.fn(async () => []),
        setLastDeliveredMessageTs: vi.fn(async () => TEST_SESSION)
      } as never,
      codex: codex as never,
      slackApi: {
        setAssistantThreadStatus: vi.fn(),
        addReaction: vi.fn(),
        removeReaction: vi.fn()
      } as never,
      selfMessageFilter: {} as never
    });

    await service.postSlackState({
      channelId: "C123",
      rootThreadTs: "111.222",
      kind: "wait",
      reason: "waiting on async job"
    });

    expect(recordTurnSignal).toHaveBeenCalledWith("C123", "111.222", expect.objectContaining({
      turnId: "turn-1",
      kind: "wait",
      reason: "waiting on async job"
    }));
    expect(setActiveTurnId).toHaveBeenCalledWith("C123", "111.222", undefined);
    expect(listInboundMessages).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "C123",
      rootThreadTs: "111.222",
      status: "inflight",
      batchId: "turn-1"
    }));

    await service.stop();
  });

  it("clears the active turn when posting a visible final Slack message", async () => {
    const codex = new EventEmitter();
    const recordTurnSignal = vi.fn(async () => TEST_SESSION);
    const setActiveTurnId = vi.fn(async () => ({
      ...TEST_SESSION,
      activeTurnId: undefined
    }));
    const postThreadMessage = vi.fn(async () => "333.444");
    const setLastSlackReplyAt = vi.fn(async () => TEST_SESSION);

    const service = new SlackConversationService({
      config: TEST_CONFIG,
      sessions: {
        recordTurnSignal,
        setActiveTurnId,
        setLastSlackReplyAt,
        listInboundMessages: vi.fn((): PersistedInboundMessage[] => []),
        updateInboundMessagesForBatch: vi.fn(async () => []),
        setLastDeliveredMessageTs: vi.fn(async () => TEST_SESSION)
      } as never,
      codex: codex as never,
      slackApi: {
        postThreadMessage,
        setAssistantThreadStatus: vi.fn(),
        addReaction: vi.fn(),
        removeReaction: vi.fn()
      } as never,
      selfMessageFilter: {
        rememberPostedMessageTs: vi.fn()
      } as never
    });

    await service.postSlackMessage({
      channelId: "C123",
      rootThreadTs: "111.222",
      text: "done",
      kind: "final"
    });

    expect(postThreadMessage).toHaveBeenCalledTimes(1);
    expect(recordTurnSignal).toHaveBeenCalledWith("C123", "111.222", expect.objectContaining({
      turnId: "turn-1",
      kind: "final"
    }));
    expect(setActiveTurnId).toHaveBeenCalledWith("C123", "111.222", undefined);

    await service.stop();
  });

  it("does not clear the active turn when posting a visible progress Slack message", async () => {
    const codex = new EventEmitter();
    const recordTurnSignal = vi.fn(async () => TEST_SESSION);
    const setActiveTurnId = vi.fn(async () => ({
      ...TEST_SESSION,
      activeTurnId: undefined
    }));
    const postThreadMessage = vi.fn(async () => "333.444");
    const setLastSlackReplyAt = vi.fn(async () => TEST_SESSION);

    const service = new SlackConversationService({
      config: TEST_CONFIG,
      sessions: {
        recordTurnSignal,
        setActiveTurnId,
        setLastSlackReplyAt,
        listInboundMessages: vi.fn((): PersistedInboundMessage[] => []),
        updateInboundMessagesForBatch: vi.fn(async () => []),
        setLastDeliveredMessageTs: vi.fn(async () => TEST_SESSION)
      } as never,
      codex: codex as never,
      slackApi: {
        postThreadMessage,
        setAssistantThreadStatus: vi.fn(),
        addReaction: vi.fn(),
        removeReaction: vi.fn()
      } as never,
      selfMessageFilter: {
        rememberPostedMessageTs: vi.fn()
      } as never
    });

    await service.postSlackMessage({
      channelId: "C123",
      rootThreadTs: "111.222",
      text: "still working",
      kind: "progress"
    });

    expect(postThreadMessage).toHaveBeenCalledTimes(1);
    expect(setLastSlackReplyAt).toHaveBeenCalledTimes(1);
    expect(recordTurnSignal).not.toHaveBeenCalled();
    expect(setActiveTurnId).not.toHaveBeenCalled();

    await service.stop();
  });
});
