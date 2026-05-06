import http from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { SlackSocketModeClient } from "../src/services/slack/socket-mode-client.js";

interface TestSocketServer {
  readonly url: string;
  readonly connected: Promise<WebSocket>;
  readonly close: () => Promise<void>;
}

async function createSocketServer(): Promise<TestSocketServer> {
  const server = http.createServer();
  const wsServer = new WebSocketServer({ server });
  const connections = new Set<WebSocket>();
  let resolveConnected!: (socket: WebSocket) => void;
  const connected = new Promise<WebSocket>((resolve) => {
    resolveConnected = resolve;
  });

  wsServer.on("connection", (socket) => {
    connections.add(socket);
    socket.on("close", () => {
      connections.delete(socket);
    });
    resolveConnected(socket);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind test websocket server");
  }

  return {
    url: `ws://127.0.0.1:${address.port}`,
    connected,
    close: async () => {
      for (const connection of connections) {
        connection.close();
      }
      await new Promise<void>((done) => {
        wsServer.close(() => {
          server.close(() => done());
        });
      });
    }
  };
}

describe("SlackSocketModeClient", () => {
  const servers: TestSocketServer[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("retries after a failed socket-open request without crashing start()", async () => {
    vi.useFakeTimers();
    const api = {
      openSocketConnection: vi.fn().mockRejectedValue(new Error("fetch failed"))
    };
    const client = new SlackSocketModeClient({
      api: api as never,
      socketOpenPath: "apps.connections.open"
    });

    await expect(client.start()).resolves.toBeUndefined();
    expect(api.openSocketConnection).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.openSocketConnection).toHaveBeenCalledTimes(2);

    await client.stop();
  });

  it("emits interactive payloads from Socket Mode envelopes", async () => {
    const server = await createSocketServer();
    servers.push(server);
    const client = new SlackSocketModeClient({
      api: {
        openSocketConnection: async () => server.url
      } as any,
      socketOpenPath: "apps.connections.open"
    });
    const interactivePromise = new Promise<Record<string, unknown>>((resolve) => {
      client.on("interactive", (payload) => {
        resolve(payload as Record<string, unknown>);
      });
    });

    await client.start();
    const socket = await server.connected;
    socket.send(JSON.stringify({
      envelope_id: "env-1",
      type: "interactive",
      payload: {
        type: "block_actions",
        trigger_id: "trigger-1"
      }
    }));

    await expect(interactivePromise).resolves.toMatchObject({
      type: "block_actions",
      trigger_id: "trigger-1"
    });
    await client.stop();
  });

  it("acks Slack events only after async listeners accept them", async () => {
    const server = await createSocketServer();
    servers.push(server);
    const client = new SlackSocketModeClient({
      api: {
        openSocketConnection: async () => server.url
      } as any,
      socketOpenPath: "apps.connections.open"
    });
    const accepted: string[] = [];
    const ackedAfterAccepted = new Promise<boolean>((resolve) => {
      void server.connected.then((socket) => {
        socket.on("message", (data) => {
          const ack = JSON.parse(data.toString()) as { envelope_id?: string };
          resolve(ack.envelope_id === "env-1" && accepted.includes("Ev1"));
        });
      });
    });

    client.on("events_api", async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      accepted.push("Ev1");
    });

    await client.start();
    const socket = await server.connected;
    socket.send(JSON.stringify({
      envelope_id: "env-1",
      type: "events_api",
      payload: {
        event_id: "Ev1",
        event: {
          type: "message",
          channel: "C123",
          thread_ts: "111.222",
          ts: "111.223",
          user: "U123",
          text: "hello"
        }
      }
    }));

    await expect(ackedAfterAccepted).resolves.toBe(true);
    await client.stop();
  });
});
