import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { SlackConversationService } from "../src/services/slack/slack-conversation-service.js";
import type { SlackSessionRecord } from "../src/types.js";

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
});
