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
});
