import { EventEmitter } from "node:events";
import fs from "node:fs/promises";

import WebSocket from "ws";

import { logger } from "../../logger.js";
import type { CodexTurnResult, SlackUserIdentity } from "../../types.js";
import { buildSlackThreadBaseInstructions } from "./slack-thread-base-instructions.js";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface RawRateLimitWindow {
  readonly usedPercent?: number;
  readonly windowDurationMins?: number | null;
  readonly resetsAt?: number | null;
}

interface RawCreditsSnapshot {
  readonly hasCredits?: boolean;
  readonly unlimited?: boolean;
  readonly balance?: string | null;
}

interface RawRateLimitSnapshot {
  readonly limitId?: string | null;
  readonly limitName?: string | null;
  readonly primary?: RawRateLimitWindow | null;
  readonly secondary?: RawRateLimitWindow | null;
  readonly credits?: RawCreditsSnapshot | null;
  readonly planType?: string | null;
}

interface PendingRequest {
  readonly resolve: (value: any) => void;
  readonly reject: (error: Error) => void;
}

interface ActiveTurn {
  readonly threadId: string;
  readonly turnId: string;
  text: string;
  resolve: (result: CodexTurnResult) => void;
  reject: (error: Error) => void;
}

interface BufferedTurnEvents {
  text: string;
  terminalState: "completed" | "aborted" | null;
}

export interface StartedTurn {
  readonly turnId: string;
  readonly completion: Promise<CodexTurnResult>;
}

export interface CodexTextInputItem {
  readonly type: "text";
  readonly text: string;
  readonly text_elements: readonly [];
}

export interface CodexImageInputItem {
  readonly type: "image";
  readonly url: string;
}

export type CodexInputItem = CodexTextInputItem | CodexImageInputItem;

export interface SteerTurnOptions {
  readonly threadId: string;
  readonly turnId: string;
  readonly input: readonly CodexInputItem[];
}

export interface ReadTurnResult {
  readonly status: "completed" | "failed" | "interrupted" | "inProgress" | "unknown";
  readonly finalMessage: string;
  readonly errorMessage?: string | undefined;
}

export interface ReadTurnResultOptions {
  readonly syncActiveTurn?: boolean | undefined;
  readonly treatMissingAsStale?: boolean | undefined;
}

export interface AppServerAccountSummary {
  readonly account?: JsonValue | undefined;
  readonly quota?: JsonValue | undefined;
  readonly usage?: JsonValue | undefined;
  readonly requiresOpenaiAuth?: boolean | undefined;
}

export interface AppServerRateLimitWindow {
  readonly usedPercent: number;
  readonly windowDurationMins: number | null;
  readonly resetsAt: number | null;
}

export interface AppServerCreditsSnapshot {
  readonly hasCredits: boolean;
  readonly unlimited: boolean;
  readonly balance: string | null;
}

export type AppServerPlanType = "free" | "go" | "plus" | "pro" | "team" | "business" | "enterprise" | "edu" | "unknown" | string;

export interface AppServerRateLimitSnapshot {
  readonly limitId: string | null;
  readonly limitName: string | null;
  readonly primary: AppServerRateLimitWindow | null;
  readonly secondary: AppServerRateLimitWindow | null;
  readonly credits: AppServerCreditsSnapshot | null;
  readonly planType: AppServerPlanType | null;
}

export interface AppServerRateLimitsResponse {
  readonly rateLimits: AppServerRateLimitSnapshot;
  readonly rateLimitsByLimitId: Record<string, AppServerRateLimitSnapshot> | null;
}

export class AppServerClient extends EventEmitter {
  #socket: WebSocket | undefined;
  #requestCounter = 0;
  readonly #pendingRequests = new Map<string, PendingRequest>();
  readonly #activeTurns = new Map<string, ActiveTurn>();
  readonly #bufferedTurnEvents = new Map<string, BufferedTurnEvents>();
  #connected = false;
  #disconnectHandled = false;
  #slackBotIdentity: SlackUserIdentity | null = null;
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #awaitingPong = false;

  constructor(
    private readonly options: {
      readonly url: string;
      readonly serviceName: string;
      readonly brokerHttpBaseUrl: string;
      readonly reposRoot: string;
      readonly openAiApiKey?: string | undefined;
      readonly personalMemoryFilePath?: string | undefined;
      readonly heartbeatIntervalMs?: number | undefined;
    }
  ) {
    super();
  }

  async connect(): Promise<void> {
    this.#disconnectHandled = false;
    this.#socket = new WebSocket(this.options.url);

    await new Promise<void>((resolve, reject) => {
      this.#socket?.once("open", () => resolve());
      this.#socket?.once("error", reject);
    });

    this.#socket.on("message", (data) => {
      this.#handleMessage(data.toString());
    });
    this.#socket.on("pong", () => {
      this.#awaitingPong = false;
      logger.debug("Codex app-server websocket heartbeat acknowledged");
    });
    this.#socket.on("error", (error) => {
      logger.warn("Codex app-server websocket error", {
        error: error instanceof Error ? error.message : String(error)
      });
      this.#handleDisconnect(error instanceof Error ? error : new Error(String(error)));
    });
    this.#socket.on("close", () => {
      this.#handleDisconnect(new Error("Codex app-server websocket closed"));
    });

    await this.request("initialize", {
      clientInfo: {
        name: this.options.serviceName,
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });

    this.#connected = true;
    this.#startHeartbeat(this.#socket, this.options.heartbeatIntervalMs);
  }

  isConnected(): boolean {
    return this.#connected;
  }

  setSlackBotIdentity(identity: SlackUserIdentity | null): void {
    this.#slackBotIdentity = identity;
  }

  async close(): Promise<void> {
    if (!this.#socket) {
      this.#handleDisconnect(new Error("Codex app-server websocket closed"));
      return;
    }

    if (this.#socket.readyState === WebSocket.CLOSED) {
      this.#handleDisconnect(new Error("Codex app-server websocket closed"));
      return;
    }

    await new Promise<void>((resolve) => {
      this.#socket?.once("close", () => resolve());
      this.#socket?.close();
    });
  }

  async ensureAuthenticated(): Promise<void> {
    logger.debug("Checking Codex authentication");
    const response = await this.request("account/read", { refreshToken: false }) as {
      account: { type: string } | null;
      requiresOpenaiAuth: boolean;
    };

    if (response.account) {
      return;
    }

    if (!this.options.openAiApiKey) {
      throw new Error(
        "Codex app-server is not authenticated. Mount auth.json into CODEX_HOME or provide OPENAI_API_KEY."
      );
    }

    await this.request("account/login/start", {
      type: "apiKey",
      apiKey: this.options.openAiApiKey
    });
  }

  async readAccountSummary(refreshToken = false): Promise<AppServerAccountSummary> {
    const response = await this.request("account/read", { refreshToken }) as {
      account?: JsonValue;
      quota?: JsonValue;
      usage?: JsonValue;
      requiresOpenaiAuth?: boolean;
    };

    return {
      account: response.account,
      quota: response.quota,
      usage: response.usage,
      requiresOpenaiAuth: response.requiresOpenaiAuth
    };
  }

  async readAccountRateLimits(): Promise<AppServerRateLimitsResponse> {
    const response = await this.request("account/rateLimits/read") as {
      rateLimits?: RawRateLimitSnapshot;
      rateLimitsByLimitId?: Record<string, RawRateLimitSnapshot> | null;
    };

    if (!response.rateLimits) {
      throw new Error("Codex app-server did not return rate limits");
    }

    return {
      rateLimits: normalizeRateLimitSnapshot(response.rateLimits),
      rateLimitsByLimitId: normalizeRateLimitSnapshotMap(response.rateLimitsByLimitId)
    };
  }

  async ensureThread(session: {
    readonly codexThreadId?: string | undefined;
    readonly workspacePath: string;
    readonly channelId: string;
    readonly rootThreadTs: string;
  }): Promise<string> {
    if (session.codexThreadId) {
      logger.debug("Resuming Codex thread", {
        threadId: session.codexThreadId,
        cwd: session.workspacePath
      });
      const result = await this.request("thread/resume", {
        threadId: session.codexThreadId,
        cwd: session.workspacePath,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        model: null,
        modelProvider: null,
        config: null,
        baseInstructions: null,
        developerInstructions: null,
        personality: null,
        persistExtendedHistory: true
      }) as {
        thread: { id: string };
      };

      return result.thread.id;
    }

    const baseInstructions = await this.#buildBaseInstructions(session);
    const result = await this.request("thread/start", {
      cwd: session.workspacePath,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      model: null,
      modelProvider: null,
      config: null,
      serviceName: this.options.serviceName,
      baseInstructions,
      developerInstructions: null,
      personality: null,
      ephemeral: false,
      experimentalRawEvents: false,
      persistExtendedHistory: true
    }) as {
      thread: { id: string };
    };
    logger.debug("Started Codex thread", {
      threadId: result.thread.id,
      cwd: session.workspacePath
    });

    return result.thread.id;
  }

  async startTurn(
    threadId: string,
    cwd: string,
    input: readonly CodexInputItem[]
  ): Promise<StartedTurn> {
    logger.debug("Starting Codex turn", {
      threadId,
      cwd,
      inputItemCount: input.length
    });
    const requestInput = [...input];
    const result = await this.request("turn/start", {
      threadId,
      input: requestInput,
      cwd,
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "dangerFullAccess"
      },
      collaborationMode: null,
      outputSchema: null,
      model: null,
      effort: null,
      summary: "auto",
      personality: null
    } as unknown as JsonValue) as {
      turn: { id: string };
    };

    const completion = new Promise<CodexTurnResult>((resolve, reject) => {
      this.#activeTurns.set(result.turn.id, {
        threadId,
        turnId: result.turn.id,
        text: "",
        resolve,
        reject
      });
    });
    this.#applyBufferedTurnEvents(result.turn.id);
    // A websocket disconnect can reject the turn before the caller gets to `await completion`.
    // Keep a no-op rejection handler attached so Node does not treat that window as unhandled.
    void completion.catch(() => {});

    return {
      turnId: result.turn.id,
      completion
    };
  }

  async steerTurn(options: SteerTurnOptions): Promise<void> {
    const maxAttempts = 8;
    const requestInput = [...options.input];

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.request("turn/steer", {
          threadId: options.threadId,
          expectedTurnId: options.turnId,
          input: requestInput
        } as unknown as JsonValue);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const shouldRetry =
          /no active turn to steer/i.test(message) ||
          /expectedTurnId/i.test(message);

        if (!shouldRetry || attempt === maxAttempts) {
          throw error;
        }

        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", {
      threadId,
      turnId
    });
  }

  async #buildBaseInstructions(session: {
    readonly channelId: string;
    readonly rootThreadTs: string;
    readonly workspacePath: string;
  }): Promise<string> {
    const personalMemory = await this.#readPersonalMemory();
    return await buildSlackThreadBaseInstructions({
      brokerHttpBaseUrl: this.options.brokerHttpBaseUrl,
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs,
      workspacePath: session.workspacePath,
      reposRoot: this.options.reposRoot,
      slackBotIdentity: this.#slackBotIdentity,
      personalMemory
    });
  }

  async #readPersonalMemory(): Promise<string | undefined> {
    if (!this.options.personalMemoryFilePath) {
      return undefined;
    }

    const content = await fs.readFile(this.options.personalMemoryFilePath, "utf8").catch(() => "");
    const normalized = content.trim();
    return normalized ? normalized : undefined;
  }

  async readTurnResult(
    threadId: string,
    turnId: string,
    options?: ReadTurnResultOptions
  ): Promise<ReadTurnResult | null> {
    const result = await this.request("thread/read", {
      threadId,
      includeTurns: true
    }) as {
      thread?: {
        turns?: Array<{
          id?: string;
          status?: string;
          error?: {
            message?: string;
            additionalDetails?: string | null;
          } | null;
          items?: Array<{
            type?: string;
            text?: string;
          }>;
        }>;
      };
    };

    const turn = result.thread?.turns?.find((entry) => entry.id === turnId);

    if (!turn) {
      if (options?.syncActiveTurn && options.treatMissingAsStale) {
        this.#settleMissingActiveTurn(turnId);
      }
      return null;
    }

    const agentMessages = (turn.items ?? []).filter((item) => item.type === "agentMessage");
    const lastAgentMessage = agentMessages.at(-1);
    const status = normalizeTurnStatus(turn.status);

    const normalizedResult = {
      status,
      finalMessage: String(lastAgentMessage?.text ?? "").trim(),
      errorMessage:
        turn.error?.additionalDetails ??
        turn.error?.message ??
        undefined
    };

    if (options?.syncActiveTurn) {
      this.#syncActiveTurn(turnId, normalizedResult);
    }

    return normalizedResult;
  }

  async request(method: string, params?: JsonValue): Promise<JsonValue> {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server websocket is not connected");
    }

    const requestId = String(++this.#requestCounter);
    logger.debug("App-server request", {
      method,
      requestId
    });
    logger.raw("codex-rpc", {
      direction: "request",
      id: requestId,
      method,
      params
    }, {
      requestId,
      method
    });
    const payload = JSON.stringify(
      params === undefined
        ? {
            id: requestId,
            method
          }
        : {
            id: requestId,
            method,
            params
          }
    );

    return await new Promise<JsonValue>((resolve, reject) => {
      this.#pendingRequests.set(requestId, { resolve, reject });
      this.#socket?.send(payload, (error) => {
        if (error) {
          this.#pendingRequests.delete(requestId);
          reject(error);
        }
      });
    });
  }

  #handleMessage(raw: string): void {
    const message = JSON.parse(raw) as {
      readonly id?: string;
      readonly result?: JsonValue;
      readonly error?: { readonly message: string };
      readonly method?: string;
      readonly params?: Record<string, any>;
    };
    logger.raw("codex-rpc", {
      direction: "response",
      message
    }, {
      requestId: message.id,
      method: message.method
    });

    if (message.id) {
      const pending = this.#pendingRequests.get(message.id);
      if (!pending) {
        return;
      }

      this.#pendingRequests.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
        return;
      }

      pending.resolve(message.result ?? null);
      logger.debug("App-server response", {
        requestId: message.id
      });
      return;
    }

    if (!message.method) {
      return;
    }

    this.emit("notification", message.method, message.params);
    this.#handleTurnEvent(message.method, message.params ?? {});
  }

  #handleTurnEvent(method: string, params: Record<string, any>): void {
    if (method === "item/agentMessage/delta") {
      const turnId = params.turnId as string | undefined;
      if (!turnId) {
        return;
      }

      const delta = String(params.delta ?? "");
      const turn = this.#activeTurns.get(turnId);
      if (turn) {
        turn.text += delta;
      } else if (delta) {
        this.#bufferTurnText(turnId, delta);
      }
      return;
    }

    if (method === "turn/completed") {
      const turnId = params.turn?.id as string | undefined;
      if (!turnId) {
        return;
      }

      const turn = this.#activeTurns.get(turnId);
      if (!turn) {
        this.#bufferTurnTerminalState(turnId, "completed");
        return;
      }

      this.#resolveActiveTurn(turn, false);
      return;
    }

    if (method === "codex/event/turn_aborted") {
      const turnId = params.msg?.turn_id as string | undefined;
      if (!turnId) {
        return;
      }

      const turn = this.#activeTurns.get(turnId);
      if (!turn) {
        this.#bufferTurnTerminalState(turnId, "aborted");
        return;
      }

      this.#resolveActiveTurn(turn, true);
    }
  }

  #handleDisconnect(error: Error): void {
    if (this.#disconnectHandled) {
      return;
    }

    this.#disconnectHandled = true;
    this.#connected = false;
    this.#clearHeartbeat();
    this.#socket = undefined;

    for (const [requestId, pending] of this.#pendingRequests) {
      this.#pendingRequests.delete(requestId);
      pending.reject(error);
    }

    for (const [turnId, turn] of this.#activeTurns) {
      this.#activeTurns.delete(turnId);
      turn.reject(error);
    }
    this.#bufferedTurnEvents.clear();

    this.emit("disconnected", error);
  }

  #syncActiveTurn(turnId: string, result: ReadTurnResult): void {
    const turn = this.#activeTurns.get(turnId);
    if (!turn) {
      return;
    }

    if (result.status === "inProgress" || result.status === "unknown") {
      return;
    }

    this.#activeTurns.delete(turnId);
    this.#bufferedTurnEvents.delete(turnId);

    if (result.status === "completed") {
      turn.resolve({
        threadId: turn.threadId,
        turnId,
        finalMessage: result.finalMessage,
        aborted: false
      });
      return;
    }

    if (result.status === "interrupted") {
      turn.resolve({
        threadId: turn.threadId,
        turnId,
        finalMessage: result.finalMessage,
        aborted: true
      });
      return;
    }

    turn.reject(new Error(result.errorMessage ?? "Codex turn failed"));
  }

  #settleMissingActiveTurn(turnId: string): void {
    const turn = this.#activeTurns.get(turnId);
    if (!turn) {
      return;
    }

    this.#activeTurns.delete(turnId);
    this.#bufferedTurnEvents.delete(turnId);
    turn.reject(new Error("Codex turn missing from thread snapshot"));
  }

  #bufferTurnText(turnId: string, delta: string): void {
    const buffered = this.#bufferedTurnEvents.get(turnId) ?? {
      text: "",
      terminalState: null
    };
    buffered.text += delta;
    this.#bufferedTurnEvents.set(turnId, buffered);
  }

  #bufferTurnTerminalState(turnId: string, terminalState: "completed" | "aborted"): void {
    const buffered = this.#bufferedTurnEvents.get(turnId) ?? {
      text: "",
      terminalState: null
    };
    buffered.terminalState = terminalState;
    this.#bufferedTurnEvents.set(turnId, buffered);
  }

  #applyBufferedTurnEvents(turnId: string): void {
    const turn = this.#activeTurns.get(turnId);
    if (!turn) {
      return;
    }

    const buffered = this.#bufferedTurnEvents.get(turnId);
    if (!buffered) {
      return;
    }

    this.#bufferedTurnEvents.delete(turnId);
    if (buffered.text) {
      turn.text += buffered.text;
    }

    if (buffered.terminalState === "completed") {
      this.#resolveActiveTurn(turn, false);
      return;
    }

    if (buffered.terminalState === "aborted") {
      this.#resolveActiveTurn(turn, true);
    }
  }

  #resolveActiveTurn(turn: ActiveTurn, aborted: boolean): void {
    this.#activeTurns.delete(turn.turnId);
    this.#bufferedTurnEvents.delete(turn.turnId);
    turn.resolve({
      threadId: turn.threadId,
      turnId: turn.turnId,
      finalMessage: turn.text.trim(),
      aborted
    });
  }

  #startHeartbeat(socket: WebSocket, intervalMs = 30_000): void {
    this.#clearHeartbeat();
    this.#awaitingPong = false;

    this.#heartbeatTimer = setInterval(() => {
      if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN) {
        this.#clearHeartbeat();
        return;
      }

      if (this.#awaitingPong) {
        logger.warn("Codex app-server websocket heartbeat timed out, terminating socket");
        socket.terminate();
        return;
      }

      this.#awaitingPong = true;
      socket.ping();
    }, intervalMs);
  }

  #clearHeartbeat(): void {
    this.#awaitingPong = false;

    if (!this.#heartbeatTimer) {
      return;
    }

    clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
  }
}

function normalizeTurnStatus(status: unknown): ReadTurnResult["status"] {
  if (status === "completed" || status === "failed" || status === "interrupted" || status === "inProgress") {
    return status;
  }

  return "unknown";
}

function normalizeRateLimitSnapshot(snapshot: RawRateLimitSnapshot): AppServerRateLimitSnapshot {
  return {
    limitId: snapshot.limitId ?? null,
    limitName: snapshot.limitName ?? null,
    primary: normalizeRateLimitWindow(snapshot.primary),
    secondary: normalizeRateLimitWindow(snapshot.secondary),
    credits: normalizeCreditsSnapshot(snapshot.credits),
    planType: snapshot.planType ?? null
  };
}

function normalizeRateLimitSnapshotMap(
  snapshots: Record<string, RawRateLimitSnapshot> | null | undefined
): Readonly<Record<string, AppServerRateLimitSnapshot>> | null {
  if (!snapshots) {
    return null;
  }

  return Object.fromEntries(
    Object.entries(snapshots).map(([limitId, snapshot]) => [limitId, normalizeRateLimitSnapshot(snapshot)])
  );
}

function normalizeRateLimitWindow(window: RawRateLimitWindow | null | undefined): AppServerRateLimitWindow | null {
  if (!window) {
    return null;
  }

  return {
    usedPercent: Number(window.usedPercent ?? 0),
    windowDurationMins: window.windowDurationMins ?? null,
    resetsAt: window.resetsAt ?? null
  };
}

function normalizeCreditsSnapshot(credits: RawCreditsSnapshot | null | undefined): AppServerCreditsSnapshot | null {
  if (!credits) {
    return null;
  }

  return {
    hasCredits: Boolean(credits.hasCredits),
    unlimited: Boolean(credits.unlimited),
    balance: credits.balance ?? null
  };
}
