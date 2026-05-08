import type { EventEmitter } from "node:events";

import type {
  AgentTurnTokenUsage,
  GeneratedImageArtifact,
  SlackSessionRecord,
  SlackUserIdentity
} from "../../types.js";

export interface AgentTextInputItem {
  readonly type: "text";
  readonly text: string;
  readonly text_elements: readonly [];
}

export interface AgentImageInputItem {
  readonly type: "image";
  readonly url: string;
}

export type AgentInputItem = AgentTextInputItem | AgentImageInputItem;

export interface AgentRuntimeCapabilities {
  readonly submitWhileActive: true;
  readonly interrupt: boolean;
  readonly readTurn: boolean;
  readonly readSession: boolean;
  readonly rawEvents: boolean;
  readonly tokenUsage: "exact" | "estimated" | "none";
  readonly toolCalls: boolean;
  readonly systemPromptEcho: boolean;
}

export interface AgentSession {
  readonly id: string;
  readonly brokerSessionKey: string;
  readonly runtime: string;
  readonly createdAt: string;
}

export interface SubmitAgentInput {
  readonly session: SlackSessionRecord;
  readonly input: readonly AgentInputItem[];
  readonly inputId: string;
  readonly source: "slack_user" | "runtime_reminder" | "broker_recovery" | "background_job";
}

export interface AgentInputReceipt {
  readonly agentSessionId: string;
  readonly turnId: string;
  readonly inputId: string;
  readonly delivery: "started_turn" | "joined_active_turn";
  readonly deliveredAt: string;
}

export interface AgentSubmitInputResult {
  readonly receipt: AgentInputReceipt;
  readonly completion?: Promise<AgentTurnResult> | undefined;
}

export interface AgentTurnResult {
  readonly agentSessionId: string;
  readonly turnId: string;
  readonly finalMessage: string;
  readonly aborted: boolean;
  readonly generatedImages?: readonly GeneratedImageArtifact[] | undefined;
  readonly usage?: AgentTurnTokenUsage | undefined;
}

export interface ReadAgentTurnOptions {
  readonly syncActiveTurn?: boolean | undefined;
  readonly treatMissingAsStale?: boolean | undefined;
}

export interface AgentTurnSnapshot {
  readonly status: "completed" | "failed" | "interrupted" | "inProgress" | "unknown";
  readonly finalMessage: string;
  readonly errorMessage?: string | undefined;
  readonly generatedImages: readonly GeneratedImageArtifact[];
  readonly usage?: AgentTurnTokenUsage | undefined;
}

export interface AgentSessionSnapshot {
  readonly agentSessionId: string;
}

export type AgentRuntimeEvent =
  | AgentSessionStartedEvent
  | AgentSessionResumedEvent
  | AgentInputReceivedEvent
  | AgentInputDeliveredEvent
  | AgentTurnStartedEvent
  | AgentTurnCompletedEvent
  | AgentMessageDeltaEvent
  | AgentMessageCompletedEvent
  | AgentToolStartedEvent
  | AgentToolCompletedEvent
  | AgentUsageUpdatedEvent
  | AgentErrorEvent;

export interface AgentSessionStartedEvent {
  readonly type: "agent.session.started";
  readonly agentSessionId: string;
  readonly brokerSessionKey: string;
  readonly systemPrompt?: string | undefined;
  readonly memory?: string | undefined;
  readonly at: string;
}

export interface AgentSessionResumedEvent {
  readonly type: "agent.session.resumed";
  readonly agentSessionId: string;
  readonly brokerSessionKey: string;
  readonly at: string;
}

export interface AgentInputReceivedEvent {
  readonly type: "agent.input.received";
  readonly inputId: string;
  readonly agentSessionId: string;
  readonly brokerSessionKey: string;
  readonly text: string;
  readonly textPreview: string;
  readonly source: SubmitAgentInput["source"];
  readonly at: string;
}

export interface AgentInputDeliveredEvent {
  readonly type: "agent.input.delivered";
  readonly inputId: string;
  readonly agentSessionId: string;
  readonly turnId: string;
  readonly brokerSessionKey: string;
  readonly delivery: AgentInputReceipt["delivery"];
  readonly at: string;
}

export interface AgentTurnStartedEvent {
  readonly type: "agent.turn.started";
  readonly agentSessionId: string;
  readonly turnId: string;
  readonly brokerSessionKey: string;
  readonly at: string;
}

export interface AgentTurnCompletedEvent {
  readonly type: "agent.turn.completed";
  readonly agentSessionId: string;
  readonly turnId: string;
  readonly brokerSessionKey: string;
  readonly status: "completed" | "interrupted" | "failed";
  readonly finalMessage?: string | undefined;
  readonly at: string;
}

export interface AgentMessageDeltaEvent {
  readonly type: "agent.message.delta";
  readonly agentSessionId: string;
  readonly turnId: string;
  readonly brokerSessionKey?: string | undefined;
  readonly messageId: string;
  readonly role: "assistant";
  readonly delta: string;
  readonly at: string;
}

export interface AgentMessageCompletedEvent {
  readonly type: "agent.message.completed";
  readonly agentSessionId: string;
  readonly turnId: string;
  readonly brokerSessionKey?: string | undefined;
  readonly messageId: string;
  readonly role: "assistant" | "user" | "system";
  readonly text: string;
  readonly at: string;
}

export interface AgentToolStartedEvent {
  readonly type: "agent.tool.started";
  readonly agentSessionId: string;
  readonly turnId: string;
  readonly brokerSessionKey: string;
  readonly callId: string;
  readonly name: string;
  readonly input?: unknown;
  readonly at: string;
}

export interface AgentToolCompletedEvent {
  readonly type: "agent.tool.completed";
  readonly agentSessionId: string;
  readonly turnId: string;
  readonly brokerSessionKey: string;
  readonly callId: string;
  readonly name?: string | undefined;
  readonly output?: unknown;
  readonly status: "completed" | "failed";
  readonly at: string;
}

export interface AgentUsageUpdatedEvent {
  readonly type: "agent.usage.updated";
  readonly agentSessionId: string;
  readonly turnId?: string | undefined;
  readonly brokerSessionKey: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  readonly source: "exact" | "estimated";
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly rawUsage?: unknown;
  readonly at: string;
}

export interface AgentErrorEvent {
  readonly type: "agent.error";
  readonly agentSessionId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly brokerSessionKey?: string | undefined;
  readonly code: string;
  readonly message: string;
  readonly recoverable: boolean;
  readonly at: string;
}

export interface AgentRuntime extends EventEmitter {
  getCapabilities(): AgentRuntimeCapabilities;
  start(): Promise<void>;
  stop(): Promise<void>;
  setSlackBotIdentity(identity: SlackUserIdentity | null): void;
  ensureSession(session: SlackSessionRecord): Promise<AgentSession>;
  submitInput(input: SubmitAgentInput): Promise<AgentSubmitInputResult>;
  interrupt(session: SlackSessionRecord): Promise<void>;
  readSession(session: SlackSessionRecord): Promise<AgentSessionSnapshot | null>;
  readTurn(
    session: SlackSessionRecord,
    turnId: string,
    options?: ReadAgentTurnOptions
  ): Promise<AgentTurnSnapshot | null>;
  on(event: "event", handler: (event: AgentRuntimeEvent) => void): this;
  off(event: "event", handler: (event: AgentRuntimeEvent) => void): this;
}
