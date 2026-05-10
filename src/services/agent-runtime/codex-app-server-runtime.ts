import { EventEmitter } from "node:events";

import type {
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentRuntimeEvent,
  AgentInputItem,
  AgentSession,
  AgentSessionSnapshot,
  AgentSubmitInputResult,
  AgentTurnResult,
  ReadAgentTurnOptions,
  AgentTurnSnapshot,
  SubmitAgentInput
} from "./types.js";
import { CodexBroker } from "../codex/codex-broker.js";
import { SessionManager } from "../session-manager.js";
import type { SlackSessionRecord, SlackUserIdentity } from "../../types.js";

export class CodexAppServerRuntime extends EventEmitter implements AgentRuntime {
  readonly #codex: CodexBroker;
  readonly #sessions: SessionManager;
  readonly #notificationHandler: (method: string, params: Record<string, unknown> | undefined) => void;

  constructor(options: {
    readonly codex: CodexBroker;
    readonly sessions: SessionManager;
  }) {
    super();
    this.#codex = options.codex;
    this.#sessions = options.sessions;
    this.#notificationHandler = (method, params) => {
      this.#handleCodexNotification(method, params ?? {});
    };
    this.#codex.on("notification", this.#notificationHandler);
  }

  getCapabilities(): AgentRuntimeCapabilities {
    return {
      submitWhileActive: true,
      interrupt: true,
      readTurn: true,
      readSession: true,
      rawEvents: true,
      tokenUsage: "exact",
      toolCalls: true,
      systemPromptEcho: true
    };
  }

  async start(): Promise<void> {
    await this.#codex.start();
  }

  async stop(): Promise<void> {
    this.#codex.off("notification", this.#notificationHandler);
    await this.#codex.stop();
  }

  setSlackBotIdentity(identity: SlackUserIdentity | null): void {
    this.#codex.setSlackBotIdentity(identity);
  }

  async ensureSession(session: SlackSessionRecord): Promise<AgentSession> {
    const agentSessionId = await this.#codex.ensureThread(session);
    return {
      id: agentSessionId,
      brokerSessionKey: session.key,
      runtime: "codex-app-server",
      createdAt: new Date().toISOString()
    };
  }

  async submitInput(input: SubmitAgentInput): Promise<AgentSubmitInputResult> {
    const agentSession = await this.ensureSession(input.session);
    const at = new Date().toISOString();
    const text = collectInputText(input.input);
    this.#emitRuntimeEvent({
      type: "agent.input.received",
      inputId: input.inputId,
      agentSessionId: agentSession.id,
      brokerSessionKey: input.session.key,
      text,
      textPreview: summarizeText(text),
      source: input.source,
      at
    });

    if (input.session.activeTurnId && input.session.agentSessionId) {
      try {
        await this.#codex.steer(input.session, input.input);
      } catch (error) {
        throw normalizeActiveInputError(error);
      }
      const deliveredAt = new Date().toISOString();
      const receipt = {
        agentSessionId: agentSession.id,
        turnId: input.session.activeTurnId,
        inputId: input.inputId,
        delivery: "joined_active_turn" as const,
        deliveredAt
      };
      this.#emitRuntimeEvent({
        type: "agent.input.delivered",
        ...receipt,
        brokerSessionKey: input.session.key,
        at: deliveredAt
      });
      return {
        receipt
      };
    }

    const started = await this.#codex.startTurn(input.session, input.input);
    const deliveredAt = new Date().toISOString();
    const receipt = {
      agentSessionId: agentSession.id,
      turnId: started.turnId,
      inputId: input.inputId,
      delivery: "started_turn" as const,
      deliveredAt
    };
    this.#emitRuntimeEvent({
      type: "agent.turn.started",
      agentSessionId: agentSession.id,
      turnId: started.turnId,
      brokerSessionKey: input.session.key,
      at: deliveredAt
    });
    this.#emitRuntimeEvent({
      type: "agent.input.delivered",
      ...receipt,
      brokerSessionKey: input.session.key,
      at: deliveredAt
    });

    return {
      receipt,
      completion: started.completion.then((result): AgentTurnResult => ({
        agentSessionId: result.threadId || agentSession.id,
        turnId: result.turnId,
        finalMessage: result.finalMessage,
        aborted: result.aborted,
        generatedImages: result.generatedImages,
        usage: result.usage
      })).then((result) => {
        this.#emitRuntimeEvent({
          type: "agent.turn.completed",
          agentSessionId: result.agentSessionId,
          turnId: result.turnId,
          brokerSessionKey: input.session.key,
          status: result.aborted ? "interrupted" : "completed",
          finalMessage: result.finalMessage,
          at: new Date().toISOString()
        });
        if (result.finalMessage.trim()) {
          this.#emitRuntimeEvent({
            type: "agent.message.completed",
            agentSessionId: result.agentSessionId,
            turnId: result.turnId,
            brokerSessionKey: input.session.key,
            messageId: `${result.turnId}:assistant:final`,
            role: "assistant",
            text: result.finalMessage,
            at: new Date().toISOString()
          });
        }
        return result;
      })
    };
  }

  async interrupt(session: SlackSessionRecord): Promise<void> {
    await this.#codex.interrupt(session);
  }

  async readSession(session: SlackSessionRecord): Promise<AgentSessionSnapshot | null> {
    return session.agentSessionId
      ? {
          agentSessionId: session.agentSessionId
        }
      : null;
  }

  async readTurn(
    session: SlackSessionRecord,
    turnId: string,
    options?: ReadAgentTurnOptions
  ): Promise<AgentTurnSnapshot | null> {
    return await this.#codex.readTurnResult(session, turnId, options);
  }

  #handleCodexNotification(method: string, params: Record<string, unknown>): void {
    const session = this.#findSessionForCodexNotification(params);
    if (!session) {
      return;
    }

    for (const event of codexNotificationToAgentEvents(session, method, params)) {
      this.#emitRuntimeEvent(event);
    }
  }

  #findSessionForCodexNotification(params: Record<string, unknown>): SlackSessionRecord | undefined {
    const turnId = normalizeCodexTurnId(params);
    const agentSessionId = normalizeCodexThreadId(params);
    const cwd = normalizeNonEmptyString(params.cwd ?? (asRecord(params.msg)?.cwd) ?? (asRecord(params.event)?.cwd));

    if (cwd) {
      const byWorkspace = this.#sessions.findSessionByWorkspace(cwd);
      if (byWorkspace) {
        return byWorkspace;
      }
    }

    if (!turnId && !agentSessionId) {
      return undefined;
    }

    const byAgentActivity = this.#sessions.findSessionByAgentActivity({
      agentSessionId,
      turnId
    });
    if (byAgentActivity) {
      return byAgentActivity;
    }

    for (const session of this.#sessions.listSessions()) {
      if (turnId && session.activeTurnId === turnId) {
        return session;
      }
      if (agentSessionId && session.agentSessionId === agentSessionId) {
        return session;
      }
    }

    return undefined;
  }

  #emitRuntimeEvent(event: AgentRuntimeEvent): void {
    this.emit("event", event);
  }
}

function codexNotificationToAgentEvents(
  session: SlackSessionRecord,
  method: string,
  params: Record<string, unknown>
): AgentRuntimeEvent[] {
  const agentSessionId = normalizeCodexThreadId(params) ?? session.agentSessionId ?? "";
  const baseInstructions = normalizeNonEmptyString(params.baseInstructions);
  if (method === "broker/system_prompt" && baseInstructions) {
    return [{
      type: "agent.session.started",
      agentSessionId,
      brokerSessionKey: session.key,
      systemPrompt: baseInstructions,
      memory: extractPersonalMemory(baseInstructions) || undefined,
      at: notificationAt(params)
    }];
  }

  const raw = rawCodexEventRecord(params);
  if (raw) {
    return rawCodexEventToAgentEvents(session, method, params, raw);
  }

  const at = notificationAt(params);
  const turnId = normalizeCodexTurnId(params) ?? session.activeTurnId ?? "";
  const item = asRecord(params.item);
  if (method === "item/started" && turnId && item?.type === "commandExecution") {
    return [{
      type: "agent.tool.started",
      agentSessionId,
      turnId,
      brokerSessionKey: session.key,
      callId: normalizeNonEmptyString(item.id) ?? `${turnId}:command:${at}`,
      name: "exec_command",
      input: commandExecutionTracePayload(item),
      at
    }];
  }
  if (method === "item/completed" && turnId && item?.type === "commandExecution") {
    return [{
      type: "agent.tool.completed",
      agentSessionId,
      turnId,
      brokerSessionKey: session.key,
      callId: normalizeNonEmptyString(item.id) ?? `${turnId}:command:${at}`,
      name: "exec_command",
      output: commandExecutionTracePayload(item),
      status: commandExecutionFailed(item) ? "failed" : "completed",
      at
    }];
  }
  if ((method === "tool_start" || method === "codex/event/tool_start") && turnId) {
    return [{
      type: "agent.tool.started",
      agentSessionId,
      turnId,
      brokerSessionKey: session.key,
      callId: normalizeNonEmptyString(params.callId ?? params.call_id ?? params.id) ?? `${turnId}:tool`,
      name: normalizeNonEmptyString(params.name ?? params.toolName ?? params.tool_name ?? params.tool) ?? "tool",
      input: params,
      at
    }];
  }
  if ((method === "tool_end" || method === "codex/event/tool_end") && turnId) {
    return [{
      type: "agent.tool.completed",
      agentSessionId,
      turnId,
      brokerSessionKey: session.key,
      callId: normalizeNonEmptyString(params.callId ?? params.call_id ?? params.id) ?? `${turnId}:tool`,
      name: normalizeNonEmptyString(params.name ?? params.toolName ?? params.tool_name ?? params.tool),
      output: params,
      status: toolFailed(params) ? "failed" : "completed",
      at
    }];
  }
  if (method === "codex/event/token_count") {
    const usage = normalizeTokenUsage(params);
    if (!usage) {
      return [];
    }
    return [{
      type: "agent.usage.updated",
      agentSessionId,
      turnId: turnId || undefined,
      brokerSessionKey: session.key,
      ...usage,
      at
    }];
  }
  if (method === "thread/tokenUsage/updated") {
    const usage = normalizeTokenUsage(params);
    if (!usage) {
      return [];
    }
    return [{
      type: "agent.usage.updated",
      agentSessionId,
      turnId: turnId || undefined,
      brokerSessionKey: session.key,
      ...usage,
      at
    }];
  }
  if (method === "turn/completed" && turnId) {
    return [{
      type: "agent.turn.completed",
      agentSessionId,
      turnId,
      brokerSessionKey: session.key,
      status: "completed",
      at
    }];
  }
  if (method === "codex/event/turn_aborted" && turnId) {
    return [{
      type: "agent.turn.completed",
      agentSessionId,
      turnId,
      brokerSessionKey: session.key,
      status: "interrupted",
      at
    }];
  }
  if (method === "error" || method === "codex/event/error") {
    return [{
      type: "agent.error",
      agentSessionId: agentSessionId || undefined,
      turnId: turnId || undefined,
      brokerSessionKey: session.key,
      code: method,
      message: normalizeNonEmptyString(params.message) ?? normalizeNonEmptyString(params.error) ?? "runtime error",
      recoverable: false,
      at
    }];
  }

  return [];
}

function normalizeActiveInputError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/no active turn to steer/i.test(message)) {
    return new Error(message.replace(/no active turn to steer/ig, "no active turn to deliver input"));
  }
  return error instanceof Error ? error : new Error(message);
}

function rawCodexEventToAgentEvents(
  session: SlackSessionRecord,
  method: string,
  params: Record<string, unknown>,
  raw: Record<string, unknown>
): AgentRuntimeEvent[] {
  const agentSessionId = normalizeCodexThreadId(params) ?? session.agentSessionId ?? "";
  const turnId = normalizeCodexTurnId(params) ?? normalizeNonEmptyString(raw.turn_id) ?? session.activeTurnId ?? "";
  const at = normalizeNonEmptyString(raw.timestamp ?? raw.at ?? raw.created_at) ?? notificationAt(params);
  const rawType = normalizeNonEmptyString(raw.type) ?? method;
  const payload = asRecord(raw.payload) ?? raw;
  const payloadType = normalizeNonEmptyString(payload.type) ?? rawType;

  if (rawType === "session_meta") {
    const baseInstructions = nestedString(payload, ["base_instructions", "text"]) || normalizeNonEmptyString(payload.base_instructions);
    return baseInstructions
      ? [{
          type: "agent.session.started",
          agentSessionId,
          brokerSessionKey: session.key,
          systemPrompt: baseInstructions,
          memory: extractPersonalMemory(baseInstructions) || undefined,
          at
        }]
      : [];
  }

  if (rawType === "response_item" && payloadType === "message" && turnId) {
    const role = normalizeNonEmptyString(payload.role);
    const text = extractContentText(payload.content);
    if (role === "assistant" && text.trim()) {
      return [{
        type: "agent.message.completed",
        agentSessionId,
        turnId,
        brokerSessionKey: session.key,
        messageId: normalizeNonEmptyString(payload.id) ?? `${turnId}:assistant:${at}`,
        role: "assistant",
        text,
        at
      }];
    }
    return [];
  }

  if (rawType === "response_item" && payloadType === "function_call" && turnId) {
    return [{
      type: "agent.tool.started",
      agentSessionId,
      turnId,
      brokerSessionKey: session.key,
      callId: normalizeNonEmptyString(payload.call_id) ?? `${turnId}:tool:${at}`,
      name: normalizeNonEmptyString(payload.name) ?? "tool",
      input: normalizeNonEmptyString(payload.arguments) ?? payload,
      at
    }];
  }

  if (rawType === "response_item" && payloadType === "function_call_output" && turnId) {
    return [{
      type: "agent.tool.completed",
      agentSessionId,
      turnId,
      brokerSessionKey: session.key,
      callId: normalizeNonEmptyString(payload.call_id) ?? `${turnId}:tool:${at}`,
      output: normalizeNonEmptyString(payload.output) ?? payload,
      status: "completed",
      at
    }];
  }

  if (rawType === "token_count" || payloadType === "token_count") {
    const usage = normalizeTokenUsage(raw) ?? normalizeTokenUsage(payload);
    return usage
      ? [{
          type: "agent.usage.updated",
          agentSessionId,
          turnId: turnId || undefined,
          brokerSessionKey: session.key,
          ...usage,
          at
        }]
      : [];
  }

  return [];
}

function normalizeTokenUsage(value: Record<string, unknown>): Omit<Extract<AgentRuntimeEvent, { type: "agent.usage.updated" }>, "type" | "agentSessionId" | "turnId" | "brokerSessionKey" | "at"> | undefined {
  const record = asRecord(value.msg) ?? value;
  const info = asRecord(record.info) ?? record;
  const tokenUsage = asRecord(info.tokenUsage) ?? asRecord(info.token_usage) ?? info;
  const lastUsage =
    asRecord(tokenUsage.last) ??
    asRecord(tokenUsage.last_token_usage) ??
    asRecord(tokenUsage.lastTokenUsage) ??
    asRecord(info.last_token_usage) ??
    asRecord(info.lastTokenUsage);
  const totalUsage =
    asRecord(tokenUsage.total) ??
    asRecord(tokenUsage.total_token_usage) ??
    asRecord(tokenUsage.totalTokenUsage) ??
    asRecord(info.total_token_usage) ??
    asRecord(info.totalTokenUsage);
  const usage = lastUsage ?? tokenUsage;
  const totalTokens = normalizeFiniteNumber(
    usage.total_tokens ??
      usage.totalTokens ??
      info.total_tokens ??
      info.totalTokens ??
      totalUsage?.total_tokens ??
      totalUsage?.totalTokens
  );
  if (totalTokens === undefined) {
    return undefined;
  }
  return {
    inputTokens: normalizeFiniteNumber(usage.input_tokens ?? usage.inputTokens ?? info.input_tokens ?? info.inputTokens) ?? 0,
    cachedInputTokens: normalizeFiniteNumber(usage.cached_input_tokens ?? usage.cachedInputTokens ?? info.cached_input_tokens ?? info.cachedInputTokens) ?? 0,
    outputTokens: normalizeFiniteNumber(usage.output_tokens ?? usage.outputTokens ?? info.output_tokens ?? info.outputTokens) ?? 0,
    reasoningTokens: normalizeFiniteNumber(
      usage.reasoning_tokens ??
        usage.reasoningTokens ??
        usage.reasoning_output_tokens ??
        usage.reasoningOutputTokens ??
        info.reasoning_tokens ??
        info.reasoningTokens ??
        info.reasoning_output_tokens ??
        info.reasoningOutputTokens
    ) ?? 0,
    totalTokens,
    source: "exact",
    model: normalizeNonEmptyString(usage.model) ?? normalizeNonEmptyString(info.model),
    effort: normalizeNonEmptyString(usage.effort) ?? normalizeNonEmptyString(info.effort),
    rawUsage: value
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function rawCodexEventRecord(params: Record<string, unknown>): Record<string, unknown> | undefined {
  const candidates = [
    asRecord(params.msg),
    asRecord(params.event),
    asRecord(params.record),
    asRecord(params.payload)
  ];
  for (const candidate of candidates) {
    if (candidate && (candidate.type || candidate.payload)) {
      return candidate;
    }
  }
  if (params.type || params.payload) {
    return params;
  }
  return undefined;
}

function normalizeCodexTurnId(params: Record<string, unknown>): string | undefined {
  return normalizeNonEmptyString(
    params.turnId ??
      params.turn_id ??
      (asRecord(params.turn)?.id) ??
      (asRecord(params.msg)?.turn_id) ??
      (asRecord(params.state)?.turn_id)
  );
}

function normalizeCodexThreadId(params: Record<string, unknown>): string | undefined {
  return normalizeNonEmptyString(
    params.threadId ??
      params.thread_id ??
      (asRecord(params.thread)?.id) ??
      (asRecord(params.msg)?.thread_id) ??
      (asRecord(params.state)?.thread_id)
  );
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function notificationAt(params: Record<string, unknown>): string {
  return normalizeNonEmptyString(
    params.timestamp ??
      params.at ??
      params.created_at ??
      (asRecord(params.msg)?.timestamp) ??
      (asRecord(params.event)?.timestamp)
  ) ?? new Date().toISOString();
}

function extractPersonalMemory(baseInstructions: string): string {
  const marker = "Personal long-lived memory from ~/.codex/AGENT.md:";
  const start = baseInstructions.indexOf(marker);
  if (start < 0) {
    return "";
  }
  const afterMarker = baseInstructions.slice(start + marker.length);
  const endMarkers = [
    "\n\nSlack thread message model:",
    "\n\nIdentity and instruction boundaries",
    "\n\n# Tools",
    "\n\n# Desired"
  ];
  const end = endMarkers
    .map((candidate) => afterMarker.indexOf(candidate))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  return (end === undefined ? afterMarker : afterMarker.slice(0, end)).trim();
}

function extractContentText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      const record = asRecord(item);
      return record ? normalizeNonEmptyString(record.text) ?? normalizeNonEmptyString(record.content) ?? "" : "";
    })
    .filter(Boolean)
    .join("\n");
}

function nestedString(record: Record<string, unknown>, keys: readonly string[]): string {
  const value = nestedUnknown(record, keys);
  return normalizeNonEmptyString(value) ?? "";
}

function nestedUnknown(record: Record<string, unknown>, keys: readonly string[]): unknown {
  let current: unknown = record;
  for (const key of keys) {
    const currentRecord = asRecord(current);
    if (!currentRecord) {
      return undefined;
    }
    current = currentRecord[key];
  }
  return current;
}

function normalizeFiniteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function collectInputText(input: readonly AgentInputItem[]): string {
  return input
    .filter((item): item is Extract<AgentInputItem, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function summarizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 220);
}

function commandExecutionTracePayload(item: Record<string, unknown>): Record<string, unknown> {
  return compactRecord({
    type: item.type,
    id: item.id,
    command: item.command,
    cwd: item.cwd,
    source: item.source,
    processId: item.processId,
    status: item.status,
    exitCode: item.exitCode,
    durationMs: item.durationMs,
    commandActions: item.commandActions,
    aggregatedOutput: item.aggregatedOutput,
    error: item.error
  });
}

function commandExecutionFailed(item: Record<string, unknown>): boolean {
  const exitCode = normalizeFiniteNumber(item.exitCode);
  return toolFailed(item) || (exitCode !== undefined && exitCode !== 0);
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined && value !== null)
  );
}

function toolFailed(params: Record<string, unknown>): boolean {
  const status = normalizeNonEmptyString(params.status)?.toLowerCase();
  return status === "failed" || status === "error" || params.error !== undefined;
}
