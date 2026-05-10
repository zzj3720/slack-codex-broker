import { createHash } from "node:crypto";

import { summarizeInputTraceDisplay } from "../../input-trace-summary.js";
import { logger } from "../../logger.js";
import { summarizeToolTraceDisplay } from "../../tool-trace-summary.js";
import type {
  AgentRuntimeEvent
} from "./types.js";
import { SessionManager } from "../session-manager.js";
import type {
  JsonLike,
  PersistedAgentTraceEvent,
  PersistedAgentTurnUsage,
  SlackSessionRecord
} from "../../types.js";

const TRACE_DETAIL_LIMIT = 50_000;

export class AgentTraceRecorder {
  readonly #sessions: SessionManager;

  constructor(options: {
    readonly sessions: SessionManager;
  }) {
    this.#sessions = options.sessions;
  }

  async record(event: AgentRuntimeEvent): Promise<void> {
    const session = this.#resolveSession(event);
    if (!session) {
      logger.debug("Skipping agent trace event without broker session", {
        type: event.type
      });
      return;
    }

    for (const traceEvent of this.#toTraceEvents(session, event)) {
      await this.#sessions.upsertAgentTraceEvent(traceEvent);
    }

    if (event.type === "agent.usage.updated") {
      await this.#recordUsage(session, event);
    }
  }

  #resolveSession(event: AgentRuntimeEvent): SlackSessionRecord | undefined {
    const brokerSessionKey = "brokerSessionKey" in event ? event.brokerSessionKey : undefined;
    const byBrokerSessionKey = brokerSessionKey ? this.#sessions.getSessionByKey(brokerSessionKey) : undefined;
    if (byBrokerSessionKey) {
      return byBrokerSessionKey;
    }

    const agentSessionId = "agentSessionId" in event ? event.agentSessionId : undefined;
    const turnId = "turnId" in event ? event.turnId : undefined;
    if (!agentSessionId && !turnId) {
      return undefined;
    }

    const byAgentActivity = this.#sessions.findSessionByAgentActivity({
      agentSessionId,
      turnId
    });
    if (byAgentActivity) {
      return byAgentActivity;
    }

    return this.#sessions.listSessions().find((session) =>
      Boolean(agentSessionId && session.agentSessionId === agentSessionId) ||
      Boolean(turnId && session.activeTurnId === turnId)
    );
  }

  #toTraceEvents(session: SlackSessionRecord, event: AgentRuntimeEvent): PersistedAgentTraceEvent[] {
    const now = new Date().toISOString();
    switch (event.type) {
      case "agent.session.started": {
        const events = [
          this.#trace(session, event, {
            type: "agent_system_prompt",
            title: "系统 Prompt",
            summary: "Agent session 启动指令",
            detail: event.systemPrompt,
            status: "loaded",
            role: "system",
            sequenceOffset: 0
          }, now)
        ];
        if (event.memory) {
          events.push(this.#trace(session, event, {
            type: "agent_memory",
            title: "记忆",
            summary: summarizeTraceText(event.memory),
            detail: event.memory,
            status: "loaded",
            role: "system",
            sequenceOffset: 1
          }, now));
        }
        return events;
      }
      case "agent.session.resumed":
        return [this.#trace(session, event, {
          type: "agent_session_resumed",
          title: "Session 恢复",
          summary: "Agent session 已恢复",
          status: "completed"
        }, now)];
      case "agent.input.received":
        {
          const inputSummary = summarizeInputTraceDisplay({
            source: event.source,
            text: event.text,
            fallbackTitle: inputTitle(event.source),
            fallbackSummary: event.textPreview
          });
          return [this.#trace(session, event, {
            type: "agent_input_received",
            title: inputSummary?.title ?? inputTitle(event.source),
            summary: inputSummary?.summary ?? event.textPreview,
            detail: event.text,
            status: "received",
            role: event.source === "runtime_reminder" ? "system" : "user",
            metadata: {
              inputId: event.inputId,
              source: event.source,
              ...(inputSummary?.metadata ?? {})
            }
          }, now)];
        }
      case "agent.input.delivered":
        return [this.#trace(session, event, {
          type: "agent_input_delivered",
          title: "输入已送达",
          summary: event.delivery === "started_turn" ? "启动新回合" : "进入当前回合",
          status: event.delivery,
          turnId: event.turnId,
          metadata: {
            inputId: event.inputId,
            delivery: event.delivery
          }
        }, now)];
      case "agent.turn.started":
        return [this.#trace(session, event, {
          type: "agent_turn_started",
          title: "回合开始",
          summary: "开始处理输入",
          status: "running",
          turnId: event.turnId
        }, now)];
      case "agent.turn.completed":
        return [this.#trace(session, event, {
          type: "agent_turn_completed",
          title: event.status === "failed" ? "回合失败" : "回合结束",
          summary: event.status === "completed" ? "回合已完成" : event.status,
          detail: event.finalMessage,
          status: event.status,
          turnId: event.turnId
        }, now)];
      case "agent.message.completed":
        {
          const text = event.text.trim();
          if (!text) {
            return [];
          }
        return [this.#trace(session, event, {
          type: event.role === "assistant" ? "agent_assistant_message" : "agent_user_message",
          title: event.role === "assistant" ? "Assistant 消息" : "用户消息",
          summary: summarizeTraceText(text),
          detail: text,
          status: "completed",
          role: event.role,
          turnId: event.turnId,
          metadata: {
            messageId: event.messageId
          }
        }, now)];
        }
      case "agent.tool.started":
        {
          const toolSummary = summarizeToolTrace(event.name, "agent_tool_call", "running", event.input);
          return [this.#trace(session, event, {
            type: "agent_tool_call",
            title: toolSummary?.title ?? "工具调用",
            summary: toolSummary?.summary ?? event.name,
            detail: stableJson(event.input),
            status: "running",
            role: "assistant",
            toolName: event.name,
            callId: event.callId,
            turnId: event.turnId,
            metadata: toolSummary?.metadata
          }, now)];
        }
      case "agent.tool.completed":
        {
          const toolSummary = summarizeToolTrace(event.name, "agent_tool_result", event.status, event.output);
          return [this.#trace(session, event, {
            type: "agent_tool_result",
            title: toolSummary?.title ?? "工具结果",
            summary: toolSummary?.summary ?? event.name ?? event.callId,
            detail: stableJson(event.output),
            status: event.status,
            role: "tool",
            toolName: event.name,
            callId: event.callId,
            turnId: event.turnId,
            metadata: toolSummary?.metadata
          }, now)];
        }
      case "agent.usage.updated":
        return [this.#trace(session, event, {
          type: "agent_token_count",
          title: "Token 用量",
          summary: `${event.totalTokens} tokens`,
          detail: stableJson(event.rawUsage),
          status: "completed",
          turnId: event.turnId,
          metadata: {
            totalTokens: event.totalTokens,
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            reasoningTokens: event.reasoningTokens,
            source: event.source
          }
        }, now)];
      case "agent.error":
        return [this.#trace(session, event, {
          type: "agent_runtime_error",
          title: "Runtime 错误",
          summary: event.message,
          status: "failed",
          turnId: event.turnId,
          metadata: {
            code: event.code,
            recoverable: event.recoverable
          }
        }, now)];
      case "agent.message.delta":
        return [];
      default:
        return [];
    }
  }

  #trace(
    session: SlackSessionRecord,
    event: AgentRuntimeEvent,
    values: {
      readonly type: string;
      readonly title: string;
      readonly summary: string;
      readonly detail?: string | undefined;
      readonly status?: string | undefined;
      readonly role?: string | undefined;
      readonly toolName?: string | undefined;
      readonly callId?: string | undefined;
      readonly turnId?: string | undefined;
      readonly metadata?: JsonLike | undefined;
      readonly sequenceOffset?: number | undefined;
    },
    now: string
  ): PersistedAgentTraceEvent {
    const detail = values.detail === undefined ? undefined : truncateTraceDetail(values.detail);
    return {
      id: traceEventId(session.key, event, values.type, values.sequenceOffset ?? 0),
      sessionKey: session.key,
      source: agentTraceSource(event),
      type: values.type,
      at: "at" in event ? event.at : now,
      sequence: traceSequence("at" in event ? event.at : now) + (values.sequenceOffset ?? 0),
      title: values.title,
      summary: values.summary,
      detail: detail?.text,
      status: values.status,
      role: values.role,
      toolName: values.toolName,
      callId: values.callId,
      turnId: values.turnId,
      detailTruncated: detail?.truncated,
      detailOriginalChars: detail?.originalChars,
      metadata: values.metadata,
      createdAt: now,
      updatedAt: now
    };
  }

  async #recordUsage(
    session: SlackSessionRecord,
    event: Extract<AgentRuntimeEvent, { type: "agent.usage.updated" }>
  ): Promise<void> {
    if (!event.turnId) {
      return;
    }
    const now = new Date().toISOString();
    await this.#sessions.upsertAgentTurnUsage({
      turnId: event.turnId,
      sessionKey: session.key,
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs,
      agentSessionId: event.agentSessionId,
      status: "completed",
      source: event.source,
      model: event.model,
      effort: event.effort,
      inputTokens: event.inputTokens,
      cachedInputTokens: event.cachedInputTokens,
      outputTokens: event.outputTokens,
      reasoningTokens: event.reasoningTokens,
      totalTokens: event.totalTokens,
      rawUsage: event.rawUsage as PersistedAgentTurnUsage["rawUsage"],
      completedAt: event.at,
      createdAt: event.at,
      updatedAt: now
    });
  }
}

function agentTraceSource(event: AgentRuntimeEvent): PersistedAgentTraceEvent["source"] {
  return event.type.startsWith("agent.input.") ? "broker" : "agent_runtime";
}

function inputTitle(source: string): string {
  if (source === "runtime_reminder") {
    return "Runtime 提醒";
  }
  if (source === "background_job") {
    return "后台任务事件";
  }
  if (source === "broker_recovery") {
    return "恢复消息";
  }
  return "用户消息";
}

function traceEventId(sessionKey: string, event: AgentRuntimeEvent, type: string, offset: number): string {
  const stable = JSON.stringify({
    type,
    offset,
    event
  });
  const digest = createHash("sha256").update(stable).digest("hex").slice(0, 20);
  return `${sessionKey}:agent:${type}:${digest}`;
}

function traceSequence(at: string): number {
  const parsed = Date.parse(at);
  return (Number.isFinite(parsed) ? parsed : Date.now()) * 1000;
}

function summarizeTraceText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 220);
}

function summarizeToolTrace(
  toolName: string | undefined,
  eventType: "agent_tool_call" | "agent_tool_result",
  status: string,
  payload: unknown
): {
  readonly title: string;
  readonly summary: string;
  readonly metadata: JsonLike;
} | undefined {
  return summarizeToolTraceDisplay({
    eventType,
    toolName,
    status,
    payload,
    fallbackSummary: toolName
  });
}

function truncateTraceDetail(text: string): {
  readonly text: string;
  readonly truncated: boolean;
  readonly originalChars: number;
} {
  if (text.length <= TRACE_DETAIL_LIMIT) {
    return {
      text,
      truncated: false,
      originalChars: text.length
    };
  }
  return {
    text: text.slice(0, TRACE_DETAIL_LIMIT),
    truncated: true,
    originalChars: text.length
  };
}

function stableJson(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? String(entry) : entry, 2) ?? "null";
}
