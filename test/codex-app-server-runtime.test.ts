import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { CodexAppServerRuntime } from "../src/services/agent-runtime/codex-app-server-runtime.js";
import type { AgentRuntimeEvent } from "../src/services/agent-runtime/types.js";
import type { SlackSessionRecord } from "../src/types.js";

const TEST_SESSION: SlackSessionRecord = {
  key: "C123:111.222",
  channelId: "C123",
  rootThreadTs: "111.222",
  workspacePath: "/tmp/workspace",
  agentSessionId: "thread-1",
  activeTurnId: "turn-1",
  createdAt: "2026-05-09T00:00:00.000Z",
  updatedAt: "2026-05-09T00:00:00.000Z"
};

describe("CodexAppServerRuntime", () => {
  it("records app-server commandExecution items as tool calls and results", () => {
    const { codex, events } = createRuntimeFixture();

    codex.emit("notification", "item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "commandExecution",
        id: "call-1",
        command: "/bin/zsh -lc \"pnpm test\"",
        cwd: "/repo",
        processId: "123",
        source: "unifiedExecStartup",
        status: "inProgress",
        commandActions: [{ type: "keyboard", key: "ctrl-c" }],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null
      }
    });
    codex.emit("notification", "item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "commandExecution",
        id: "call-1",
        command: "/bin/zsh -lc \"pnpm test\"",
        cwd: "/repo",
        processId: "123",
        source: "unifiedExecStartup",
        status: "completed",
        aggregatedOutput: "PASS test",
        exitCode: 0,
        durationMs: 240
      }
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "agent.tool.started",
      agentSessionId: "thread-1",
      brokerSessionKey: TEST_SESSION.key,
      turnId: "turn-1",
      callId: "call-1",
      name: "exec_command",
      input: {
        type: "commandExecution",
        id: "call-1",
        command: "/bin/zsh -lc \"pnpm test\"",
        cwd: "/repo",
        processId: "123",
        source: "unifiedExecStartup",
        status: "inProgress",
        commandActions: [{ type: "keyboard", key: "ctrl-c" }]
      }
    });
    expect(events[1]).toMatchObject({
      type: "agent.tool.completed",
      agentSessionId: "thread-1",
      brokerSessionKey: TEST_SESSION.key,
      turnId: "turn-1",
      callId: "call-1",
      name: "exec_command",
      status: "completed",
      output: {
        type: "commandExecution",
        id: "call-1",
        command: "/bin/zsh -lc \"pnpm test\"",
        cwd: "/repo",
        processId: "123",
        source: "unifiedExecStartup",
        status: "completed",
        aggregatedOutput: "PASS test",
        exitCode: 0,
        durationMs: 240
      }
    });
  });

  it("marks failed commandExecution completions as failed tool results", () => {
    const { codex, events } = createRuntimeFixture();

    codex.emit("notification", "item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "commandExecution",
        id: "call-2",
        command: "/bin/zsh -lc \"pnpm lint\"",
        status: "completed",
        aggregatedOutput: "lint failed",
        exitCode: 1
      }
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "agent.tool.completed",
        callId: "call-2",
        name: "exec_command",
        status: "failed",
        output: expect.objectContaining({
          command: "/bin/zsh -lc \"pnpm lint\"",
          exitCode: 1,
          aggregatedOutput: "lint failed"
        })
      })
    ]);
  });
});

function createRuntimeFixture(): {
  readonly codex: EventEmitter;
  readonly events: AgentRuntimeEvent[];
} {
  const codex = Object.assign(new EventEmitter(), {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    setSlackBotIdentity: vi.fn(),
    ensureThread: vi.fn(async () => "thread-1"),
    steer: vi.fn(async () => undefined),
    startTurn: vi.fn(async () => ({
      turnId: "turn-1",
      completion: Promise.resolve({
        threadId: "thread-1",
        turnId: "turn-1",
        finalMessage: "",
        aborted: false
      })
    })),
    interrupt: vi.fn(async () => undefined),
    readTurnResult: vi.fn(async () => null)
  });
  const runtime = new CodexAppServerRuntime({
    codex: codex as never,
    sessions: {
      findSessionByWorkspace: vi.fn(() => undefined),
      listSessions: vi.fn(() => [TEST_SESSION])
    } as never
  });
  const events: AgentRuntimeEvent[] = [];
  runtime.on("event", (event: AgentRuntimeEvent) => {
    events.push(event);
  });
  return { codex, events };
}
