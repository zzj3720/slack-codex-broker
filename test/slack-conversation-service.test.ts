import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { SlackConversationService } from "../src/services/slack/slack-conversation-service.js";
import type { PersistedAgentTraceEvent, PersistedInboundMessage, SlackSessionRecord } from "../src/types.js";

const TEST_SESSION: SlackSessionRecord = {
  key: "C123:111.222",
  channelId: "C123",
  rootThreadTs: "111.222",
  workspacePath: "/tmp/workspace",
  agentSessionId: "thread-1",
  activeTurnId: "turn-1",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

const TEST_CONFIG = {
  slackInitialThreadHistoryCount: 8,
  slackHistoryApiMaxLimit: 50,
  slackActiveTurnReconcileIntervalMs: 15_000,
  slackMissedThreadRecoveryIntervalMs: 15_000
} as AppConfig;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SlackConversationService", () => {
  it("removes the agent runtime event listener on stop", async () => {
    const agentRuntime = new EventEmitter();
    const getSessionByKey = vi.fn(() => TEST_SESSION);
    const setAssistantThreadStatus = vi.fn(async () => undefined);

    const service = new SlackConversationService({
      config: TEST_CONFIG,
      sessions: {
        getSessionByKey,
        upsertAgentTraceEvent: vi.fn()
      } as never,
      agentRuntime: agentRuntime as never,
      slackApi: {
        setAssistantThreadStatus,
        addReaction: vi.fn(),
        removeReaction: vi.fn()
      } as never,
      selfMessageFilter: {} as never
    });

    expect(agentRuntime.listenerCount("event")).toBe(1);

    agentRuntime.emit("event", {
      type: "agent.tool.started",
      agentSessionId: TEST_SESSION.agentSessionId,
      brokerSessionKey: TEST_SESSION.key,
      turnId: TEST_SESSION.activeTurnId,
      callId: "call-1",
      name: "exec_command",
      at: new Date().toISOString()
    });

    await vi.waitFor(() => {
      expect(setAssistantThreadStatus).toHaveBeenCalledTimes(1);
    });

    await service.stop();

    expect(agentRuntime.listenerCount("event")).toBe(0);
    expect(setAssistantThreadStatus).toHaveBeenCalledTimes(2);

    agentRuntime.emit("event", {
      type: "agent.tool.started",
      agentSessionId: TEST_SESSION.agentSessionId,
      brokerSessionKey: TEST_SESSION.key,
      turnId: TEST_SESSION.activeTurnId,
      callId: "call-2",
      name: "exec_command",
      at: new Date().toISOString()
    });

    await Promise.resolve();
    expect(setAssistantThreadStatus).toHaveBeenCalledTimes(2);
  });

  it("skips runtime events without a broker session key", async () => {
    const agentRuntime = new EventEmitter();
    const getSessionByKey = vi.fn(() => TEST_SESSION);
    const setAssistantThreadStatus = vi.fn(async () => undefined);

    const service = new SlackConversationService({
      config: TEST_CONFIG,
      sessions: {
        getSessionByKey,
        upsertAgentTraceEvent: vi.fn()
      } as never,
      agentRuntime: agentRuntime as never,
      slackApi: {
        setAssistantThreadStatus,
        addReaction: vi.fn(),
        removeReaction: vi.fn()
      } as never,
      selfMessageFilter: {} as never
    });

    agentRuntime.emit("event", {
      type: "agent.error",
      code: "runtime_error",
      message: "missing session",
      recoverable: false,
      at: new Date().toISOString()
    });

    await Promise.resolve();

    expect(getSessionByKey).not.toHaveBeenCalled();
    expect(setAssistantThreadStatus).not.toHaveBeenCalled();

    await service.stop();
  });

  it("persists normalized agent runtime events as agent trace events", async () => {
    const agentRuntime = new EventEmitter();
    const records: PersistedAgentTraceEvent[] = [];
    const upsertAgentTraceEvent = vi.fn(async (record: PersistedAgentTraceEvent) => {
      records.push(record);
    });

    const service = new SlackConversationService({
      config: TEST_CONFIG,
      sessions: {
        getSessionByKey: vi.fn(() => TEST_SESSION),
        upsertAgentTraceEvent
      } as never,
      agentRuntime: agentRuntime as never,
      slackApi: {
        setAssistantThreadStatus: vi.fn(),
        addReaction: vi.fn(),
        removeReaction: vi.fn()
      } as never,
      selfMessageFilter: {} as never
    });

    agentRuntime.emit("event", {
      type: "agent.session.started",
      agentSessionId: TEST_SESSION.agentSessionId,
      brokerSessionKey: TEST_SESSION.key,
      systemPrompt: [
        "System instruction",
        "",
        "Personal long-lived memory from ~/.codex/AGENT.md:",
        "- remember the admin language",
        "",
        "Slack thread message model:",
        "live thread"
      ].join("\n"),
      memory: "- remember the admin language",
      at: new Date().toISOString()
    });
    agentRuntime.emit("event", {
      type: "agent.tool.started",
      agentSessionId: TEST_SESSION.agentSessionId,
      brokerSessionKey: TEST_SESSION.key,
      turnId: TEST_SESSION.activeTurnId,
      callId: "call-1",
      name: "exec_command",
      at: new Date().toISOString()
    });

    await vi.waitFor(() => {
      expect(upsertAgentTraceEvent).toHaveBeenCalledTimes(3);
    });
    expect(records.map((record) => record.type)).toEqual(expect.arrayContaining([
      "agent_system_prompt",
      "agent_memory",
      "agent_tool_call"
    ]));
    expect(records.find((record) => record.type === "agent_tool_call")).toEqual(expect.objectContaining({
      source: "agent_runtime",
      toolName: "exec_command"
    }));

    await service.stop();
  });

  it("converts file upload initial comments from markdownish to mrkdwn", async () => {
    const agentRuntime = new EventEmitter();
    const uploadThreadFile = vi.fn(async () => ({
      fileId: "F123"
    }));
    const setLastSlackReplyAt = vi.fn(async () => TEST_SESSION);

    const service = new SlackConversationService({
      config: TEST_CONFIG,
      sessions: {
        setLastSlackReplyAt
      } as never,
      agentRuntime: agentRuntime as never,
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

  it("records a silent stop state without owning active turn completion", async () => {
    const agentRuntime = new EventEmitter();
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
      agentRuntime: agentRuntime as never,
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
    expect(setActiveTurnId).not.toHaveBeenCalled();
    expect(listInboundMessages).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "C123",
      rootThreadTs: "111.222",
      status: "inflight",
      batchId: "turn-1"
    }));

    await service.stop();
  });

  it("records a visible final Slack message without owning active turn completion", async () => {
    const agentRuntime = new EventEmitter();
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
      agentRuntime: agentRuntime as never,
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
    expect(setActiveTurnId).not.toHaveBeenCalled();

    await service.stop();
  });
});
