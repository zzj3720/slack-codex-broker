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
});
