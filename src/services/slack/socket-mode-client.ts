import { EventEmitter } from "node:events";

import WebSocket from "ws";

import { logger } from "../../logger.js";
import { SlackApi } from "./slack-api.js";

export interface SlackSocketEnvelope {
  readonly envelope_id: string;
  readonly type: string;
  readonly payload?: {
    readonly event?: Record<string, any>;
    readonly event_id?: string;
    readonly type?: string;
    readonly [key: string]: unknown;
  };
}

export class SlackSocketModeClient extends EventEmitter {
  readonly #api: SlackApi;
  readonly #socketOpenPath: string;
  #socket: WebSocket | undefined;
  #running = false;
  #connectInFlight: Promise<void> | undefined;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #awaitingPong = false;

  constructor(options: {
    readonly api: SlackApi;
    readonly socketOpenPath: string;
  }) {
    super();
    this.#api = options.api;
    this.#socketOpenPath = options.socketOpenPath;
  }

  async start(): Promise<void> {
    this.#running = true;
    await this.#connectOrRetry();
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#clearReconnectTimer();
    this.#clearHeartbeat();

    if (!this.#socket) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.#socket?.once("close", () => resolve());
      this.#socket?.close();
    });
  }

  async #connectOrRetry(): Promise<void> {
    if (!this.#running || this.#connectInFlight) {
      return;
    }

    this.#connectInFlight = this.#connect()
      .catch((error) => {
        if (!this.#running) {
          return;
        }

        logger.warn("Slack Socket Mode connection failed, retrying", {
          error: error instanceof Error ? error.message : String(error)
        });
        this.#scheduleReconnect();
      })
      .finally(() => {
        this.#connectInFlight = undefined;
      });

    await this.#connectInFlight;
  }

  async #connect(): Promise<void> {
    const socketUrl = await this.#api.openSocketConnection(this.#socketOpenPath);
    const socket = new WebSocket(socketUrl);
    this.#socket = socket;

    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });

    logger.info("Connected to Slack Socket Mode");
    this.#startHeartbeat(socket);
    socket.on("message", (buffer) => {
      void this.#handleMessage(buffer.toString()).catch((error) => {
        logger.error("Failed to handle Slack Socket Mode message", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    });
    socket.on("pong", () => {
      this.#awaitingPong = false;
      logger.debug("Slack websocket heartbeat acknowledged");
    });
    socket.on("error", (error) => {
      logger.warn("Slack websocket error", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
    socket.on("close", () => {
      if (this.#socket === socket) {
        this.#socket = undefined;
      }
      this.#clearHeartbeat();

      if (!this.#running) {
        return;
      }

      logger.warn("Slack websocket closed, reconnecting");
      this.#scheduleReconnect();
    });
  }

  #scheduleReconnect(delayMs = 1_000): void {
    if (!this.#running || this.#reconnectTimer) {
      return;
    }

    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.#connectOrRetry();
    }, delayMs);
  }

  #clearReconnectTimer(): void {
    if (!this.#reconnectTimer) {
      return;
    }

    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
  }

  #startHeartbeat(socket: WebSocket, intervalMs = 30_000): void {
    this.#clearHeartbeat();
    this.#awaitingPong = false;

    this.#heartbeatTimer = setInterval(() => {
      if (!this.#running || this.#socket !== socket) {
        this.#clearHeartbeat();
        return;
      }

      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }

      if (this.#awaitingPong) {
        logger.warn("Slack websocket heartbeat timed out, terminating socket");
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

  async #handleMessage(raw: string): Promise<void> {
    const envelope = JSON.parse(raw) as SlackSocketEnvelope;
    logger.raw("slack-events", envelope, buildSlackEnvelopeMeta(envelope));

    if (envelope.type === "hello") {
      this.emit("ready");
      if (envelope.envelope_id) {
        await this.#ack(envelope.envelope_id);
      }
      return;
    }

    if (envelope.type === "disconnect") {
      logger.warn("Slack requested disconnect", {
        payload: envelope.payload
      });
      if (envelope.envelope_id) {
        await this.#ack(envelope.envelope_id);
      }
      this.#socket?.close();
      return;
    }

    if (envelope.type === "events_api" && envelope.payload) {
      await this.#emitAsync("events_api", envelope.payload);
      if (envelope.envelope_id) {
        await this.#ack(envelope.envelope_id);
      }
      return;
    }

    if (envelope.type === "interactive" && envelope.payload) {
      await this.#emitAsync("interactive", envelope.payload);
    }

    if (envelope.envelope_id) {
      await this.#ack(envelope.envelope_id);
    }
  }

  async #ack(envelopeId: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#socket?.send(JSON.stringify({ envelope_id: envelopeId }), (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  async #emitAsync(eventName: "events_api" | "interactive", payload: unknown): Promise<void> {
    for (const listener of this.listeners(eventName)) {
      await (listener as (payload: unknown) => void | Promise<void>)(payload);
    }
  }
}

function buildSlackEnvelopeMeta(envelope: SlackSocketEnvelope): Record<string, unknown> | undefined {
  const event = envelope.payload?.event;
  const channelId = typeof event?.channel === "string" ? event.channel : undefined;
  const rootThreadTs = typeof event?.thread_ts === "string"
    ? event.thread_ts
    : typeof event?.ts === "string"
      ? event.ts
      : undefined;

  return {
    envelopeId: envelope.envelope_id,
    envelopeType: envelope.type,
    eventId: envelope.payload?.event_id,
    eventType: event?.type ?? envelope.payload?.type,
    channelId,
    rootThreadTs
  };
}
