# Broker Agent Runtime Protocol

## Goal

The broker owns the agent runtime contract. It does not implement ACP, expose ACP,
or model ACP as a future compatibility target. ACP's turn model is not the source
of truth for this product because Slack thread input must be deliverable into an
already-running agent turn immediately.

The contract is split into commands and events:

```text
Broker -> AgentRuntime: commands
AgentRuntime -> Broker: events
AgentRuntimeEvent -> AgentTraceRecorder -> DB
Admin -> DB queries only
```

The admin must not depend on runtime transport details, Codex app-server event
names, JSONL files, or any in-memory runtime state.

## Required Command Contract

The broker runtime interface must expose at least:

```ts
interface AgentRuntime {
  getCapabilities(): AgentRuntimeCapabilities;
  ensureSession(input: EnsureAgentSessionInput): Promise<AgentSession>;
  submitInput(input: SubmitAgentInput): Promise<AgentSubmitInputResult>;
  interrupt(input: InterruptAgentTurnInput): Promise<void>;
  readTurn(input: ReadAgentTurnInput): Promise<AgentTurnSnapshot | null>;
  readSession(input: ReadAgentSessionInput): Promise<AgentSessionSnapshot | null>;
  on(event: "event", handler: (event: AgentRuntimeEvent) => void): void;
  off(event: "event", handler: (event: AgentRuntimeEvent) => void): void;
}
```

`submitInput` is the only broker-level input delivery command. It has strict
semantics:

- If the session is idle, the runtime starts a new turn.
- If the session is active, the runtime injects the input into the current turn.
- The runtime must not wait for the active turn to complete.
- The runtime must not cancel and recreate the turn.
- The runtime must not silently queue the input.

The receipt is diagnostic and trace data, not a separate business branch:

```ts
interface AgentInputReceipt {
  readonly agentSessionId: string;
  readonly turnId: string;
  readonly inputId: string;
  readonly delivery: "started_turn" | "joined_active_turn";
  readonly deliveredAt: string;
}
```

`AgentSubmitInputResult` wraps the receipt and includes a completion promise only
when the input started a new turn:

```ts
interface AgentSubmitInputResult {
  readonly receipt: AgentInputReceipt;
  readonly completion?: Promise<AgentTurnResult>;
}
```

## Required Capabilities

```ts
interface AgentRuntimeCapabilities {
  readonly submitWhileActive: true;
  readonly interrupt: boolean;
  readonly readTurn: boolean;
  readonly readSession: boolean;
  readonly rawEvents: boolean;
  readonly tokenUsage: "exact" | "estimated" | "none";
  readonly toolCalls: boolean;
  readonly systemPromptEcho: boolean;
}
```

`submitWhileActive` is not optional. A runtime without it is not valid for this
broker.

## Required Event Contract

The broker consumes only normalized agent runtime events. Slack services must not
parse Codex app-server private notifications directly.

```ts
type AgentRuntimeEvent =
  | AgentSessionEvent
  | AgentInputEvent
  | AgentTurnEvent
  | AgentMessageEvent
  | AgentToolEvent
  | AgentUsageEvent
  | AgentErrorEvent;
```

Required event shapes:

```ts
type AgentSessionEvent =
  | {
      type: "agent.session.started";
      agentSessionId: string;
      brokerSessionKey: string;
      systemPrompt?: string;
      memory?: string;
      at: string;
    }
  | {
      type: "agent.session.resumed";
      agentSessionId: string;
      brokerSessionKey: string;
      at: string;
    };

type AgentInputEvent =
  | {
      type: "agent.input.received";
      inputId: string;
      agentSessionId: string;
      brokerSessionKey: string;
      textPreview: string;
      at: string;
    }
  | {
      type: "agent.input.delivered";
      inputId: string;
      agentSessionId: string;
      turnId: string;
      brokerSessionKey: string;
      delivery: "started_turn" | "joined_active_turn";
      at: string;
    };

type AgentTurnEvent =
  | {
      type: "agent.turn.started";
      agentSessionId: string;
      turnId: string;
      brokerSessionKey: string;
      at: string;
    }
  | {
      type: "agent.turn.completed";
      agentSessionId: string;
      turnId: string;
      brokerSessionKey: string;
      status: "completed" | "interrupted" | "failed";
      at: string;
    };

type AgentMessageEvent =
  | {
      type: "agent.message.delta";
      agentSessionId: string;
      turnId: string;
      messageId: string;
      role: "assistant";
      delta: string;
      at: string;
    }
  | {
      type: "agent.message.completed";
      agentSessionId: string;
      turnId: string;
      messageId: string;
      role: "assistant" | "user" | "system";
      text: string;
      at: string;
    };

type AgentToolEvent =
  | {
      type: "agent.tool.started";
      agentSessionId: string;
      turnId: string;
      brokerSessionKey: string;
      callId: string;
      name: string;
      input?: unknown;
      at: string;
    }
  | {
      type: "agent.tool.completed";
      agentSessionId: string;
      turnId: string;
      brokerSessionKey: string;
      callId: string;
      name?: string;
      output?: unknown;
      status: "completed" | "failed";
      at: string;
    };

type AgentUsageEvent = {
  type: "agent.usage.updated";
  agentSessionId: string;
  turnId?: string;
  brokerSessionKey: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  source: "exact" | "estimated";
  model?: string;
  effort?: string;
  at: string;
};

type AgentErrorEvent = {
  type: "agent.error";
  agentSessionId?: string;
  turnId?: string;
  brokerSessionKey?: string;
  code: string;
  message: string;
  recoverable: boolean;
  at: string;
};
```

## Implementation Boundary

Codex app-server is an adapter implementation, not the domain model. Codex method
names such as `turn/start`, `turn/steer`, `codex/event/token_count`, and
`item/agentMessage/delta` must be contained inside the Codex adapter.

Slack services may depend on `AgentRuntime`, `AgentRuntimeEvent`, and
`AgentTraceRecorder`. They must not depend on `CodexBroker`, `CodexInputItem`,
`CodexTurnResult`, or Codex notification names.

## Data Model

Broker/domain naming must use `agent_*`.

- Session records store `agentSessionId`, not `codexThreadId`.
- Usage records live in `agent_turn_usage`, not `codex_turn_usage`.
- Trace records live in `agent_trace_events`.

The admin API reads persisted data only. It does not read runtime state, JSONL, or
Codex app-server snapshots for timeline rendering.

## Acceptance Criteria

1. Slack services have one input-delivery command: `agentRuntime.submitInput()`.
2. Slack services do not call or reference `startTurn`, `steer`, or Codex private
   notification names outside the Codex adapter directory.
3. Runtime events are normalized before Slack services consume them.
4. `agent_trace_events` contains:
   - `agent_input_received`
   - `agent_input_delivered`
   - `agent_turn_started`
   - `agent_assistant_message`
   - `agent_tool_call`
   - `agent_tool_result`
   - `agent_token_count`
   - `agent_turn_completed`
5. Idle input produces `agent.input.delivered` with `delivery=started_turn`.
6. Active user input produces `agent.input.delivered` with
   `delivery=joined_active_turn`.
7. Active input must not wait for turn completion, interrupt/cancel the turn,
   start a new runtime session, or remain pending.
8. Admin timeline reads DB data only and does not display JSONL, rollout paths,
   workspace paths, or internal identifiers.
9. Validation must include `pnpm build`, `pnpm test`, and browser verification of
    the admin timeline.
