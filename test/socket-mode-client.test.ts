import { once } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import { SlackSocketModeClient } from "../src/services/slack/socket-mode-client.js";

describe("SlackSocketModeClient", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to start websocket server");
    }

    const interactivePromise = new Promise<Record<string, unknown>>((resolve) => {
      const api = {
        openSocketConnection: vi.fn().mockResolvedValue(`ws://127.0.0.1:${address.port}`)
      };
      const client = new SlackSocketModeClient({
        api: api as never,
        socketOpenPath: "apps.connections.open"
      });
      client.on("interactive", (payload) => {
        resolve(payload as Record<string, unknown>);
        void client.stop();
      });

      void client.start();
    });

    const [socket] = await once(server, "connection") as [WebSocket];
    await new Promise((resolve) => setTimeout(resolve, 20));
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

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });
});
