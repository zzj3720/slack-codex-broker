import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AgentTraceRecorder } from "../src/services/agent-runtime/agent-trace-recorder.js";
import { SessionManager } from "../src/services/session-manager.js";
import { StateStore } from "../src/store/state-store.js";

describe("AgentTraceRecorder", () => {
  it("records assistant messages that only carry the agent session id", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-trace-recorder-"));
    const sessionsRoot = path.join(stateDir, "sessions");
    const stateStore = new StateStore(stateDir, sessionsRoot);
    const sessions = new SessionManager({
      stateStore,
      sessionsRoot
    });

    await sessions.load();
    let session = await sessions.ensureSession("C123", "111.222");
    session = await sessions.setAgentSessionId(session.channelId, session.rootThreadTs, "thread-1");
    session = await sessions.setActiveTurnId(session.channelId, session.rootThreadTs, "turn-1");

    const recorder = new AgentTraceRecorder({
      sessions
    });
    await recorder.record({
      type: "agent.message.completed",
      agentSessionId: "thread-1",
      turnId: "turn-1",
      messageId: "message-1",
      role: "assistant",
      text: "我会先检查状态。",
      at: "2026-03-19T00:00:03.000Z"
    });

    expect(sessions.listAgentTraceEvents(session.key)).toEqual([
      expect.objectContaining({
        type: "agent_assistant_message",
        title: "Assistant 消息",
        summary: "我会先检查状态。",
        detail: "我会先检查状态。",
        turnId: "turn-1"
      })
    ]);

    stateStore.close();
    await fs.rm(stateDir, {
      force: true,
      recursive: true
    });
  });

  it("records late events from an old agent turn after the session switches runtime ids", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-trace-recorder-late-event-"));
    const sessionsRoot = path.join(stateDir, "sessions");
    const stateStore = new StateStore(stateDir, sessionsRoot);
    const sessions = new SessionManager({
      stateStore,
      sessionsRoot
    });

    await sessions.load();
    let session = await sessions.ensureSession("C123", "111.222");
    session = await sessions.setAgentSessionId(session.channelId, session.rootThreadTs, "thread-old");
    session = await sessions.setActiveTurnId(session.channelId, session.rootThreadTs, "turn-old");
    session = await sessions.setAgentSessionId(session.channelId, session.rootThreadTs, "thread-new");
    session = await sessions.setActiveTurnId(session.channelId, session.rootThreadTs, "turn-new");

    const recorder = new AgentTraceRecorder({
      sessions
    });
    await recorder.record({
      type: "agent.message.completed",
      agentSessionId: "thread-old",
      turnId: "turn-old",
      messageId: "message-late",
      role: "assistant",
      text: "旧 session 的迟到事件不能断链。",
      at: "2026-03-19T00:00:03.000Z"
    });

    expect(sessions.listAgentTraceEvents(session.key)).toEqual([
      expect.objectContaining({
        type: "agent_assistant_message",
        summary: "旧 session 的迟到事件不能断链。",
        detail: "旧 session 的迟到事件不能断链。",
        turnId: "turn-old"
      })
    ]);

    stateStore.close();
    await fs.rm(stateDir, {
      force: true,
      recursive: true
    });
  });

  it("does not record empty assistant message trace events", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-trace-recorder-empty-message-"));
    const sessionsRoot = path.join(stateDir, "sessions");
    const stateStore = new StateStore(stateDir, sessionsRoot);
    const sessions = new SessionManager({
      stateStore,
      sessionsRoot
    });

    await sessions.load();
    let session = await sessions.ensureSession("C123", "111.222");
    session = await sessions.setAgentSessionId(session.channelId, session.rootThreadTs, "thread-1");
    session = await sessions.setActiveTurnId(session.channelId, session.rootThreadTs, "turn-1");

    const recorder = new AgentTraceRecorder({
      sessions
    });
    await recorder.record({
      type: "agent.message.completed",
      agentSessionId: "thread-1",
      turnId: "turn-1",
      messageId: "message-empty",
      role: "assistant",
      text: "   \n  ",
      at: "2026-03-19T00:00:03.000Z"
    });

    expect(sessions.listAgentTraceEvents(session.key)).toEqual([]);

    stateStore.close();
    await fs.rm(stateDir, {
      force: true,
      recursive: true
    });
  });

  it("records exec_command trace events with command and result summaries", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-trace-recorder-tool-"));
    const sessionsRoot = path.join(stateDir, "sessions");
    const stateStore = new StateStore(stateDir, sessionsRoot);
    const sessions = new SessionManager({
      stateStore,
      sessionsRoot
    });

    await sessions.load();
    let session = await sessions.ensureSession("C123", "111.222");
    session = await sessions.setAgentSessionId(session.channelId, session.rootThreadTs, "thread-1");
    session = await sessions.setActiveTurnId(session.channelId, session.rootThreadTs, "turn-1");

    const recorder = new AgentTraceRecorder({
      sessions
    });
    await recorder.record({
      type: "agent.tool.started",
      agentSessionId: "thread-1",
      brokerSessionKey: session.key,
      turnId: "turn-1",
      callId: "call-1",
      name: "exec_command",
      input: {
        command: "/bin/zsh -lc \"cd /tmp/workspace/app && pnpm test\"",
        cwd: "/tmp/workspace",
        commandActions: [
          {
            type: "test",
            name: "unit"
          }
        ]
      },
      at: "2026-03-19T00:00:03.000Z"
    });
    await recorder.record({
      type: "agent.tool.completed",
      agentSessionId: "thread-1",
      brokerSessionKey: session.key,
      turnId: "turn-1",
      callId: "call-1",
      name: "exec_command",
      output: {
        command: "/bin/zsh -lc \"cd /tmp/workspace/app && pnpm test\"",
        cwd: "/tmp/workspace",
        exitCode: 0,
        durationMs: 1200,
        aggregatedOutput: "PASS unit tests"
      },
      status: "completed",
      at: "2026-03-19T00:00:04.000Z"
    });

    expect(sessions.listAgentTraceEvents(session.key)).toEqual([
      expect.objectContaining({
        type: "agent_tool_call",
        title: "pnpm test",
        summary: "测试 unit · cwd app · 运行中",
        metadata: expect.objectContaining({
          commandPreview: "pnpm test",
          cwdLabel: "app",
          actionSummary: "测试 unit"
        })
      }),
      expect.objectContaining({
        type: "agent_tool_result",
        title: "pnpm test",
        summary: "exit 0 · 1.2s · 输出 PASS unit tests",
        metadata: expect.objectContaining({
          exitCode: 0,
          durationMs: 1200,
          outputPreview: "PASS unit tests"
        })
      })
    ]);

    stateStore.close();
    await fs.rm(stateDir, {
      force: true,
      recursive: true
    });
  });

  it("records Slack input trace events with the user message instead of the broker wrapper", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-trace-recorder-input-"));
    const sessionsRoot = path.join(stateDir, "sessions");
    const stateStore = new StateStore(stateDir, sessionsRoot);
    const sessions = new SessionManager({
      stateStore,
      sessionsRoot
    });

    await sessions.load();
    let session = await sessions.ensureSession("C123", "111.222");
    session = await sessions.setAgentSessionId(session.channelId, session.rootThreadTs, "thread-1");
    session = await sessions.setActiveTurnId(session.channelId, session.rootThreadTs, "turn-1");

    const recorder = new AgentTraceRecorder({
      sessions
    });
    await recorder.record({
      type: "agent.input.received",
      inputId: "input-1",
      agentSessionId: "thread-1",
      brokerSessionKey: session.key,
      source: "slack_user",
      textPreview: "A newer Slack message arrived while the current turn is still active. Treat it as the latest instruction...",
      text: [
        "A newer Slack message arrived while the current turn is still active.",
        "Treat it as the latest instruction and adjust the ongoing work accordingly.",
        "",
        "A new message arrived in the active Slack thread. Carefully judge whether it requires a reply or action from you.",
        "structured_message_json:",
        "```json",
        JSON.stringify({
          source: "app_mention",
          message_ts: "1778316208.809479",
          sender: {
            kind: "user",
            user_id: "U123",
            mention: "<@U123>",
            display_name: "Jc"
          },
          text: "<@U0ALY77RMJL> 结合 willow repo，分析图中问题",
          text_with_resolved_mentions: "@codex-3720 结合 willow repo，分析图中问题",
          images: []
        }, null, 2),
        "```"
      ].join("\n"),
      at: "2026-03-19T00:00:03.000Z"
    });

    expect(sessions.listAgentTraceEvents(session.key)).toEqual([
      expect.objectContaining({
        type: "agent_input_received",
        title: "@codex-3720 结合 willow repo，分析图中问题",
        summary: "Jc · 提及",
        metadata: expect.objectContaining({
          inputId: "input-1",
          source: "app_mention",
          sender: "Jc",
          messageTs: "1778316208.809479"
        })
      })
    ]);

    stateStore.close();
    await fs.rm(stateDir, {
      force: true,
      recursive: true
    });
  });
});
