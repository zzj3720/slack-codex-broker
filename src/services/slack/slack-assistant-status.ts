import { logger } from "../../logger.js";
import { SlackApi } from "./slack-api.js";

const ASSISTANT_STATUS_MIN_INTERVAL_MS = 2_000;
const FALLBACK_REACTION_NAME = "eyes";

const TOOL_STATUS_LABELS = new Map<string, string>([
  ["read", "Reading files..."],
  ["list", "Reading files..."],
  ["ls", "Reading files..."],
  ["glob", "Reading files..."],
  ["grep", "Reading files..."],
  ["stat", "Checking files..."],
  ["write", "Updating files..."],
  ["edit", "Updating files..."],
  ["apply_patch", "Updating files..."],
  ["copy", "Updating files..."],
  ["delete", "Updating files..."],
  ["exec", "Running in environment..."],
  ["bash", "Running in workspace..."],
  ["exec_command", "Running in workspace..."],
  ["python", "Running Python..."],
  ["webbrowse", "Browsing the web..."],
  ["search_query", "Searching the web..."],
  ["image_query", "Searching the web..."],
  ["memoryget", "Reading memory..."],
  ["memorysearch", "Searching memory..."],
  ["memorywrite", "Updating memory..."],
  ["waitfor", "Waiting on external work..."],
  ["slackpostmessage", "Updating Slack..."],
  ["slackeditmessage", "Updating Slack..."],
  ["slackuploadfile", "Uploading to Slack..."],
  ["slackgetthread", "Checking Slack..."],
  ["slackgetchannelhistory", "Checking Slack..."],
  ["slackgetuserinfo", "Checking Slack..."],
  ["slackaddreaction", "Checking Slack..."]
]);

interface AssistantStateLike {
  readonly phase?: unknown;
  readonly tools?: unknown;
}

export class SlackAssistantStatusController {
  readonly #slackApi: SlackApi;
  readonly #channelId: string;
  readonly #threadTs: string;

  #lastStatus = "";
  #lastCallAtMs = 0;
  #pendingStatus: string | undefined;
  #timer: NodeJS.Timeout | undefined;
  #sendChain: Promise<void> = Promise.resolve();
  #stopped = false;
  #fallbackOnly = false;
  #reactionActive = false;
  readonly #activeToolCalls = new Map<string, string>();
  readonly #activeToolOrder: string[] = [];

  constructor(options: {
    readonly slackApi: SlackApi;
    readonly channelId: string;
    readonly threadTs: string;
  }) {
    this.#slackApi = options.slackApi;
    this.#channelId = options.channelId;
    this.#threadTs = options.threadTs;
  }

  setThinking(): void {
    this.#scheduleStatus("Thinking...");
  }

  clear(): void {
    this.#scheduleStatus("");
  }

  handleAssistantState(state: Record<string, unknown> | null | undefined): void {
    if (!state) {
      return;
    }

    const status = statusForAssistantState(state);
    if (status === null) {
      return;
    }

    this.#scheduleStatus(status);
  }

  handleToolStart(params: Record<string, unknown> | null | undefined): void {
    const callId = extractCallId(params);
    const toolName = extractToolName(params);
    if (callId && toolName) {
      this.#recordToolStart(callId, toolName);
    }

    this.#scheduleStatus(this.#currentToolStatus() || "Working on it...");
  }

  handleToolEnd(params: Record<string, unknown> | null | undefined): void {
    const callId = extractCallId(params);
    if (callId) {
      this.#recordToolEnd(callId);
    }

    const toolStatus = this.#currentToolStatus();
    if (toolStatus) {
      this.#scheduleStatus(toolStatus);
      return;
    }

    this.#scheduleStatus("Thinking...");
  }

  handleTerminalStatus(status: string | null | undefined): void {
    if (clearsAssistantStatusForTerminal(status)) {
      this.clear();
    }
  }

  async stop(): Promise<void> {
    if (this.#stopped) {
      await this.#sendChain;
      return;
    }

    this.#stopped = true;
    this.#pendingStatus = undefined;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }

    await this.#enqueueSend("");
  }

  #recordToolStart(callId: string, toolName: string): void {
    if (!this.#activeToolCalls.has(callId)) {
      this.#activeToolOrder.push(callId);
    }
    this.#activeToolCalls.set(callId, toolName);
  }

  #recordToolEnd(callId: string): void {
    this.#activeToolCalls.delete(callId);
    const index = this.#activeToolOrder.lastIndexOf(callId);
    if (index >= 0) {
      this.#activeToolOrder.splice(index, 1);
    }
  }

  #currentToolStatus(): string {
    for (let index = this.#activeToolOrder.length - 1; index >= 0; index -= 1) {
      const toolName = this.#activeToolCalls.get(this.#activeToolOrder[index]!);
      if (!toolName) {
        continue;
      }
      return statusForTool(toolName);
    }

    return "";
  }

  #scheduleStatus(status: string): void {
    if (this.#stopped && status !== "") {
      return;
    }

    if (status === this.#lastStatus) {
      this.#clearPendingStatus();
      return;
    }

    if (status === "") {
      this.#clearPendingStatus();
      void this.#enqueueSend(status);
      return;
    }

    const elapsedMs = Date.now() - this.#lastCallAtMs;
    if (elapsedMs < ASSISTANT_STATUS_MIN_INTERVAL_MS) {
      this.#pendingStatus = status;
      if (!this.#timer) {
        this.#timer = setTimeout(() => {
          this.#timer = undefined;
          this.#flushPendingStatus();
        }, ASSISTANT_STATUS_MIN_INTERVAL_MS - elapsedMs);
      }
      return;
    }

    void this.#enqueueSend(status);
  }

  #flushPendingStatus(): void {
    const pendingStatus = this.#pendingStatus;
    this.#pendingStatus = undefined;

    if (!pendingStatus || pendingStatus === this.#lastStatus) {
      return;
    }

    void this.#enqueueSend(pendingStatus);
  }

  #clearPendingStatus(): void {
    this.#pendingStatus = undefined;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  #enqueueSend(status: string): Promise<void> {
    this.#lastStatus = status;
    this.#lastCallAtMs = Date.now();
    this.#sendChain = this.#sendChain
      .catch(() => undefined)
      .then(async () => {
        await this.#send(status);
      });
    return this.#sendChain;
  }

  async #send(status: string): Promise<void> {
    if (this.#fallbackOnly) {
      await this.#applyFallbackReaction(status);
      return;
    }

    try {
      await this.#slackApi.setAssistantThreadStatus({
        channelId: this.#channelId,
        threadTs: this.#threadTs,
        status
      });
      await this.#clearFallbackReactionIfNeeded();
    } catch (error) {
      if (shouldFallbackAssistantStatus(error)) {
        this.#fallbackOnly = true;
        await this.#applyFallbackReaction(status);
        return;
      }

      logger.warn("Failed to update Slack assistant thread status", {
        channelId: this.#channelId,
        threadTs: this.#threadTs,
        status,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async #applyFallbackReaction(status: string): Promise<void> {
    const shouldBeActive = status.trim() !== "";

    if (shouldBeActive && !this.#reactionActive) {
      try {
        await this.#slackApi.addReaction({
          channelId: this.#channelId,
          timestamp: this.#threadTs,
          name: FALLBACK_REACTION_NAME
        });
        this.#reactionActive = true;
      } catch (error) {
        if (!isSlackApiError(error, "already_reacted")) {
          logger.warn("Failed to add Slack assistant fallback reaction", {
            channelId: this.#channelId,
            threadTs: this.#threadTs,
            error: error instanceof Error ? error.message : String(error)
          });
          return;
        }
        this.#reactionActive = true;
      }
    }

    if (!shouldBeActive && this.#reactionActive) {
      try {
        await this.#slackApi.removeReaction({
          channelId: this.#channelId,
          timestamp: this.#threadTs,
          name: FALLBACK_REACTION_NAME
        });
      } catch (error) {
        if (!isSlackApiError(error, "no_reaction")) {
          logger.warn("Failed to remove Slack assistant fallback reaction", {
            channelId: this.#channelId,
            threadTs: this.#threadTs,
            error: error instanceof Error ? error.message : String(error)
          });
          return;
        }
      }
      this.#reactionActive = false;
    }
  }

  async #clearFallbackReactionIfNeeded(): Promise<void> {
    if (!this.#reactionActive) {
      return;
    }

    try {
      await this.#slackApi.removeReaction({
        channelId: this.#channelId,
        timestamp: this.#threadTs,
        name: FALLBACK_REACTION_NAME
      });
    } catch (error) {
      if (!isSlackApiError(error, "no_reaction")) {
        logger.warn("Failed to clear Slack assistant fallback reaction", {
          channelId: this.#channelId,
          threadTs: this.#threadTs,
          error: error instanceof Error ? error.message : String(error)
        });
        return;
      }
    }

    this.#reactionActive = false;
  }
}

function statusForAssistantState(state: Record<string, unknown>): string | null {
  const phase = normalizeString((state as AssistantStateLike).phase);

  switch (phase) {
    case "thinking":
      return "Thinking...";
    case "execution":
      return statusForExecutionState(state);
    case "messaging":
    case "idle":
      return "";
    default:
      return null;
  }
}

function statusForExecutionState(state: Record<string, unknown>): string {
  const toolName = latestAssistantToolName((state as AssistantStateLike).tools);
  if (!toolName) {
    return "Working on it...";
  }

  return statusForTool(toolName);
}

function latestAssistantToolName(tools: unknown): string | undefined {
  if (!Array.isArray(tools)) {
    return undefined;
  }

  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const entry = tools[index];
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const toolName = normalizeString(
      (entry as { readonly tool_name?: unknown; readonly toolName?: unknown }).tool_name ??
      (entry as { readonly toolName?: unknown }).toolName
    );
    if (toolName) {
      return toolName;
    }
  }

  return undefined;
}

function statusForTool(toolName: string): string {
  const normalized = normalizeToolName(toolName);
  if (!normalized) {
    return "Working on it...";
  }

  return TOOL_STATUS_LABELS.get(normalized) ?? "Working on it...";
}

function normalizeToolName(toolName: string | null | undefined): string {
  return normalizeString(toolName)?.replace(/[^a-z0-9]+/g, "") ?? "";
}

function extractCallId(params: Record<string, unknown> | null | undefined): string | undefined {
  if (!params) {
    return undefined;
  }

  return normalizeString(
    params.callId ??
      params.call_id ??
      params.toolCallId ??
      params.tool_call_id ??
      params.id
  );
}

function extractToolName(params: Record<string, unknown> | null | undefined): string | undefined {
  if (!params) {
    return undefined;
  }

  if (typeof params.tool === "object" && params.tool) {
    const toolName = normalizeString((params.tool as { readonly name?: unknown }).name);
    if (toolName) {
      return toolName;
    }
  }

  return normalizeString(
    params.toolName ??
      params.tool_name ??
      params.name
  );
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.toLowerCase() : undefined;
}

function clearsAssistantStatusForTerminal(status: string | null | undefined): boolean {
  switch (normalizeString(status)) {
    case "paused":
    case "waiting":
    case "failed":
    case "completed":
    case "cancelled":
    case "interrupted":
      return true;
    default:
      return false;
  }
}

function shouldFallbackAssistantStatus(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    "missing_scope",
    "unknown_method",
    "not_allowed_token_type",
    "feature_not_enabled",
    "method_not_supported_for_channel_type"
  ].some((token) => message.includes(token));
}

function isSlackApiError(error: unknown, code: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(`: ${code}`) || message.endsWith(code);
}
