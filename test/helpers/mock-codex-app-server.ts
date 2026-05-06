import http from "node:http";
import { randomUUID } from "node:crypto";

import { WebSocketServer, type WebSocket } from "ws";

import type { CodexInputItem } from "../../src/services/codex/app-server-client.js";

interface MockTurnRecord {
  readonly threadId: string;
  readonly turnId: string;
  readonly cwd: string;
  readonly input: readonly CodexInputItem[];
  status: "inProgress" | "completed" | "interrupted" | "failed";
  finalMessage: string;
  errorMessage?: string | undefined;
}

interface MockThreadRecord {
  readonly id: string;
  cwd: string;
  baseInstructions?: string | null | undefined;
  readonly turns: MockTurnRecord[];
  activeTurnId?: string | undefined;
}

export interface MockTurnContext {
  readonly threadId: string;
  readonly turnId: string;
  readonly cwd: string;
  readonly input: readonly CodexInputItem[];
  readonly thread: MockThreadRecord;
  complete: (message?: string) => void;
  interrupt: (message?: string) => void;
}

export class MockCodexAppServer {
  readonly #server = http.createServer();
  readonly #wsServer = new WebSocketServer({ server: this.#server });
  readonly #connections = new Set<WebSocket>();
  readonly #threads = new Map<string, MockThreadRecord>();
  readonly turnsStarted: MockTurnRecord[] = [];
  readonly steers: Array<{
    readonly threadId: string;
    readonly turnId: string;
    readonly input: readonly CodexInputItem[];
  }> = [];
  readonly onTurnStart: ((context: MockTurnContext) => Promise<void> | void) | undefined;
  readonly onTurnSteer: ((context: MockTurnContext) => Promise<void> | void) | undefined;

  constructor(options?: {
    readonly onTurnStart?: (context: MockTurnContext) => Promise<void> | void;
    readonly onTurnSteer?: (context: MockTurnContext) => Promise<void> | void;
  }) {
    this.onTurnStart = options?.onTurnStart;
    this.onTurnSteer = options?.onTurnSteer;

    this.#wsServer.on("connection", (socket) => {
      this.#connections.add(socket);
      socket.on("close", () => {
        this.#connections.delete(socket);
      });
      socket.on("message", (data) => {
        void this.#handleMessage(socket, JSON.parse(data.toString()) as {
          readonly id?: string;
          readonly method?: string;
          readonly params?: Record<string, unknown>;
        });
      });
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => {
      this.#server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = this.#server.address();
    if (!address || typeof address === "string") {
      throw new Error("Mock Codex app-server failed to bind");
    }

    return `ws://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    for (const connection of this.#connections) {
      connection.close();
    }

    await new Promise<void>((resolve) => {
      this.#wsServer.close(() => {
        this.#server.close(() => resolve());
      });
    });
  }

  findLatestTurn(predicate: (turn: MockTurnRecord) => boolean): MockTurnRecord | undefined {
    return [...this.turnsStarted].reverse().find(predicate);
  }

  getThread(threadId: string): MockThreadRecord | undefined {
    return this.#threads.get(threadId);
  }

  async #handleMessage(
    socket: WebSocket,
    message: {
      readonly id?: string;
      readonly method?: string;
      readonly params?: Record<string, unknown>;
    }
  ): Promise<void> {
    const method = message.method;
    const params = message.params ?? {};

    switch (method) {
      case "initialize":
        this.#respond(socket, message.id, { ok: true });
        return;
      case "account/read":
        this.#respond(socket, message.id, {
          account: { type: "apiKey" },
          requiresOpenaiAuth: false
        });
        return;
      case "account/rateLimits/read":
        this.#respond(socket, message.id, {
          rateLimits: {
            limitId: "codex",
            limitName: "Codex",
            primary: {
              usedPercent: 12,
              windowDurationMins: 300,
              resetsAt: 1_777_777_777
            },
            secondary: {
              usedPercent: 3,
              windowDurationMins: 10_080,
              resetsAt: 1_778_888_888
            },
            credits: {
              hasCredits: true,
              unlimited: false,
              balance: "42.5"
            },
            planType: "team"
          },
          rateLimitsByLimitId: {
            codex: {
              limitId: "codex",
              limitName: "Codex",
              primary: {
                usedPercent: 12,
                windowDurationMins: 300,
                resetsAt: 1_777_777_777
              },
              secondary: {
                usedPercent: 3,
                windowDurationMins: 10_080,
                resetsAt: 1_778_888_888
              },
              credits: {
                hasCredits: true,
                unlimited: false,
                balance: "42.5"
              },
              planType: "team"
            }
          }
        });
        return;
      case "thread/start": {
        const threadId = randomUUID();
        this.#threads.set(threadId, {
          id: threadId,
          cwd: String(params.cwd ?? ""),
          baseInstructions: typeof params.baseInstructions === "string" ? params.baseInstructions : null,
          turns: []
        });
        this.#respond(socket, message.id, {
          thread: { id: threadId }
        });
        return;
      }
      case "thread/resume": {
        const threadId = String(params.threadId ?? "");
        const thread = this.#threads.get(threadId);
        if (!thread) {
          this.#respond(socket, message.id, {
            thread: { id: threadId }
          });
          return;
        }

        thread.cwd = String(params.cwd ?? thread.cwd);
        this.#respond(socket, message.id, {
          thread: { id: threadId }
        });
        return;
      }
      case "turn/start": {
        const threadId = String(params.threadId ?? "");
        const thread = this.#requireThread(threadId);
        const turnId = randomUUID();
        const turn: MockTurnRecord = {
          threadId,
          turnId,
          cwd: String(params.cwd ?? thread.cwd),
          input: normalizeInput(params.input),
          status: "inProgress",
          finalMessage: ""
        };
        thread.turns.push(turn);
        thread.activeTurnId = turnId;
        this.turnsStarted.push(turn);
        this.#respond(socket, message.id, {
          turn: { id: turnId }
        });

        const context = this.#createTurnContext(socket, thread, turn);
        setTimeout(() => {
          void this.#runTurnStart(context, turn);
        }, 10);
        return;
      }
      case "turn/steer": {
        const threadId = String(params.threadId ?? "");
        const expectedTurnId = String(params.expectedTurnId ?? "");
        const thread = this.#requireThread(threadId);

        if (!thread.activeTurnId) {
          this.#error(socket, message.id, "no active turn to steer");
          return;
        }

        if (thread.activeTurnId !== expectedTurnId) {
          this.#error(
            socket,
            message.id,
            `expected active turn id \`${expectedTurnId}\` but found \`${thread.activeTurnId}\``
          );
          return;
        }

        const turn = this.#requireTurn(thread, expectedTurnId);
        const input = normalizeInput(params.input);
        this.steers.push({
          threadId,
          turnId: expectedTurnId,
          input
        });
        this.#respond(socket, message.id, { ok: true });

        const context = this.#createTurnContext(socket, thread, turn);
        setTimeout(() => {
          void this.onTurnSteer?.(context);
        }, 10);
        return;
      }
      case "turn/interrupt": {
        const threadId = String(params.threadId ?? "");
        const turnId = String(params.turnId ?? "");
        const thread = this.#requireThread(threadId);
        const turn = this.#requireTurn(thread, turnId);
        this.#respond(socket, message.id, { ok: true });
        this.#interruptTurn(socket, thread, turn, "interrupted");
        return;
      }
      case "thread/read": {
        const threadId = String(params.threadId ?? "");
        const thread = this.#requireThread(threadId);
        this.#respond(socket, message.id, {
          thread: {
            turns: thread.turns.map((turn) => ({
              id: turn.turnId,
              status: turn.status,
              error: turn.errorMessage ? { message: turn.errorMessage } : null,
              items: turn.finalMessage
                ? [
                  {
                    type: "agentMessage",
                    text: turn.finalMessage
                  }
                ]
                : []
            }))
          }
        });
        return;
      }
      default:
        this.#error(socket, message.id, `unsupported method: ${method ?? "unknown"}`);
    }
  }

  #createTurnContext(socket: WebSocket, thread: MockThreadRecord, turn: MockTurnRecord): MockTurnContext {
    return {
      threadId: thread.id,
      turnId: turn.turnId,
      cwd: turn.cwd,
      input: turn.input,
      thread,
      complete: (message = "") => {
        if (turn.status !== "inProgress") {
          return;
        }

        turn.status = "completed";
        turn.finalMessage = message;
        thread.activeTurnId = undefined;
        if (message) {
          socket.send(JSON.stringify({
            method: "item/agentMessage/delta",
            params: {
              turnId: turn.turnId,
              delta: message
            }
          }));
        }
        socket.send(JSON.stringify({
          method: "turn/completed",
          params: {
            turn: {
              id: turn.turnId
            }
          }
        }));
      },
      interrupt: (message = "") => {
        this.#interruptTurn(socket, thread, turn, message);
      }
    };
  }

  async #runTurnStart(context: MockTurnContext, turn: MockTurnRecord): Promise<void> {
    try {
      await this.onTurnStart?.(context);
    } finally {
      if (turn.status === "inProgress") {
        context.complete("");
      }
    }
  }

  #interruptTurn(socket: WebSocket, thread: MockThreadRecord, turn: MockTurnRecord, message: string): void {
    if (turn.status !== "inProgress") {
      return;
    }

    turn.status = "interrupted";
    turn.finalMessage = message;
    thread.activeTurnId = undefined;
    socket.send(JSON.stringify({
      method: "codex/event/turn_aborted",
      params: {
        msg: {
          turn_id: turn.turnId
        }
      }
    }));
  }

  #requireThread(threadId: string): MockThreadRecord {
    const thread = this.#threads.get(threadId);
    if (!thread) {
      throw new Error(`Unknown thread ${threadId}`);
    }
    return thread;
  }

  #requireTurn(thread: MockThreadRecord, turnId: string): MockTurnRecord {
    const turn = thread.turns.find((entry) => entry.turnId === turnId);
    if (!turn) {
      throw new Error(`Unknown turn ${turnId}`);
    }
    return turn;
  }

  #respond(socket: WebSocket, id: string | undefined, result: Record<string, unknown>): void {
    socket.send(JSON.stringify({
      id,
      result
    }));
  }

  #error(socket: WebSocket, id: string | undefined, message: string): void {
    socket.send(JSON.stringify({
      id,
      error: {
        message
      }
    }));
  }
}

function normalizeInput(value: unknown): readonly CodexInputItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value as readonly CodexInputItem[];
}
