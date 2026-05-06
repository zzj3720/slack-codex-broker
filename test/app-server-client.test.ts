import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { AppServerClient } from "../src/services/codex/app-server-client.js";

interface TestServer {
  readonly url: string;
  readonly close: () => Promise<void>;
}

async function createServer(
  onMessage: (socket: WebSocket, message: { id?: string; method?: string; params?: Record<string, unknown> }) => void
): Promise<TestServer> {
  const server = http.createServer();
  const wsServer = new WebSocketServer({ server });
  const connections = new Set<WebSocket>();

  wsServer.on("connection", (socket) => {
    connections.add(socket);
    socket.on("close", () => {
      connections.delete(socket);
    });
    socket.on("message", (data) => {
      onMessage(socket, JSON.parse(data.toString()) as { id?: string; method?: string; params?: Record<string, unknown> });
    });
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

describe("AppServerClient disconnect handling", () => {
  const servers: TestServer[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(
      tempDirs.splice(0).map((directory) =>
        fs.rm(directory, {
          force: true,
          recursive: true
        })
      )
    );
  });

  it("rejects pending requests when the websocket closes", async () => {
    const server = await createServer((socket, message) => {
      if (message.method === "initialize") {
        socket.send(JSON.stringify({
          id: message.id,
          result: { ok: true }
        }));
        return;
      }

      if (message.method === "thread/start") {
        socket.close();
      }
    });
    servers.push(server);

    const client = new AppServerClient({
      url: server.url,
      serviceName: "test",
      brokerHttpBaseUrl: "http://127.0.0.1:3000",
      reposRoot: "/tmp/repos"
    });

    await client.connect();

    await expect(client.request("thread/start", {})).rejects.toThrow(/closed/i);
  });

  it("rejects active turn completions when the websocket closes", async () => {
    const server = await createServer((socket, message) => {
      if (message.method === "initialize") {
        socket.send(JSON.stringify({
          id: message.id,
          result: { ok: true }
        }));
        return;
      }

      if (message.method === "turn/start") {
        socket.send(JSON.stringify({
          id: message.id,
          result: {
            turn: {
              id: "turn-1"
            }
          }
        }));
        setTimeout(() => {
          socket.close();
        }, 10);
      }
    });
    servers.push(server);

    const client = new AppServerClient({
      url: server.url,
      serviceName: "test",
      brokerHttpBaseUrl: "http://127.0.0.1:3000",
      reposRoot: "/tmp/repos"
    });

    await client.connect();
    const started = await client.startTurn("thread-1", "/tmp", [
      {
        type: "text",
        text: "hello",
        text_elements: []
      }
    ]);

    await expect(started.completion).rejects.toThrow(/closed/i);
  });

  it("buffers turn events that arrive before startTurn finishes registering the turn", async () => {
    const server = await createServer((socket, message) => {
      if (message.method === "initialize") {
        socket.send(JSON.stringify({
          id: message.id,
          result: { ok: true }
        }));
        return;
      }

      if (message.method === "turn/start") {
        socket.send(JSON.stringify({
          id: message.id,
          result: {
            turn: {
              id: "turn-1"
            }
          }
        }));
        socket.send(JSON.stringify({
          method: "item/agentMessage/delta",
          params: {
            turnId: "turn-1",
            delta: "done"
          }
        }));
        socket.send(JSON.stringify({
          method: "turn/completed",
          params: {
            turn: {
              id: "turn-1"
            }
          }
        }));
      }
    });
    servers.push(server);

    const client = new AppServerClient({
      url: server.url,
      serviceName: "test",
      brokerHttpBaseUrl: "http://127.0.0.1:3000",
      reposRoot: "/tmp/repos"
    });

    await client.connect();
    const started = await client.startTurn("thread-1", "/tmp", [
      {
        type: "text",
        text: "hello",
        text_elements: []
      }
    ]);

    await expect(started.completion).resolves.toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      finalMessage: "done",
      aborted: false,
      generatedImages: []
    });
  });

  it("does not emit an unhandled rejection when a turn disconnects before completion is awaited", async () => {
    const server = await createServer((socket, message) => {
      if (message.method === "initialize") {
        socket.send(JSON.stringify({
          id: message.id,
          result: { ok: true }
        }));
        return;
      }

      if (message.method === "turn/start") {
        socket.send(JSON.stringify({
          id: message.id,
          result: {
            turn: {
              id: "turn-early-close"
            }
          }
        }));
        setTimeout(() => {
          socket.close();
        }, 0);
      }
    });
    servers.push(server);

    const client = new AppServerClient({
      url: server.url,
      serviceName: "test",
      brokerHttpBaseUrl: "http://127.0.0.1:3000",
      reposRoot: "/tmp/repos"
    });

    await client.connect();
    const started = await client.startTurn("thread-1", "/tmp", [
      {
        type: "text",
        text: "hello",
        text_elements: []
      }
    ]);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await expect(started.completion).rejects.toThrow(/closed/i);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("can recover a completed turn result from thread/read", async () => {
    const server = await createServer((socket, message) => {
      if (message.method === "initialize") {
        socket.send(JSON.stringify({
          id: message.id,
          result: { ok: true }
        }));
        return;
      }

      if (message.method === "thread/read") {
        socket.send(JSON.stringify({
          id: message.id,
          result: {
            thread: {
              turns: [
                {
                  id: "turn-1",
                  status: "completed",
                  items: [
                    {
                      type: "agentMessage",
                      text: "done"
                    }
                  ]
                }
              ]
            }
          }
        }));
      }
    });
    servers.push(server);

    const client = new AppServerClient({
      url: server.url,
      serviceName: "test",
      brokerHttpBaseUrl: "http://127.0.0.1:3000",
      reposRoot: "/tmp/repos"
    });

    await client.connect();
    await expect(client.readTurnResult("thread-1", "turn-1")).resolves.toEqual({
      status: "completed",
      finalMessage: "done",
      errorMessage: undefined,
      generatedImages: []
    });
  });

  it("parses generated images from thread/read results", async () => {
    const server = await createServer((socket, message) => {
      if (message.method === "initialize") {
        socket.send(JSON.stringify({
          id: message.id,
          result: { ok: true }
        }));
        return;
      }

      if (message.method === "thread/read") {
        socket.send(JSON.stringify({
          id: message.id,
          result: {
            thread: {
              turns: [
                {
                  id: "turn-1",
                  status: "completed",
                  items: [
                    {
                      type: "agentMessage",
                      text: "done"
                    },
                    {
                      type: "image_generation_call",
                      id: "ig-1",
                      revised_prompt: "blue cat",
                      result: "QUJDREVGRw==",
                      saved_path: "/tmp/ig-1.png"
                    }
                  ]
                }
              ]
            }
          }
        }));
      }
    });
    servers.push(server);

    const client = new AppServerClient({
      url: server.url,
      serviceName: "test",
      brokerHttpBaseUrl: "http://127.0.0.1:3000",
      reposRoot: "/tmp/repos"
    });

    await client.connect();
    await expect(client.readTurnResult("thread-1", "turn-1")).resolves.toEqual({
      status: "completed",
      finalMessage: "done",
      errorMessage: undefined,
      generatedImages: [
        {
          id: "ig-1",
          contentBase64: "QUJDREVGRw==",
          contentType: "image/png",
          savedPath: "/tmp/ig-1.png",
          revisedPrompt: "blue cat"
        }
      ]
    });
  });

  it("captures image generation results from live turn notifications", async () => {
    const server = await createServer((socket, message) => {
      if (message.method === "initialize") {
        socket.send(JSON.stringify({
          id: message.id,
          result: { ok: true }
        }));
        return;
      }

      if (message.method === "turn/start") {
        socket.send(JSON.stringify({
          id: message.id,
          result: {
            turn: {
              id: "turn-1"
            }
          }
        }));
        socket.send(JSON.stringify({
          method: "item/completed",
          params: {
            turnId: "turn-1",
            item: {
              type: "imageGeneration",
              id: "ig-1",
              revisedPrompt: "blue cat",
              result: "QUJDREVGRw==",
              savedPath: "/tmp/ig-1.png"
            }
          }
        }));
        socket.send(JSON.stringify({
          method: "turn/completed",
          params: {
            turn: {
              id: "turn-1"
            }
          }
        }));
      }
    });
    servers.push(server);

    const client = new AppServerClient({
      url: server.url,
      serviceName: "test",
      brokerHttpBaseUrl: "http://127.0.0.1:3000",
      reposRoot: "/tmp/repos"
    });

    await client.connect();
    const started = await client.startTurn("thread-1", "/tmp", [
      {
        type: "text",
        text: "hello",
        text_elements: []
      }
    ]);

    await expect(started.completion).resolves.toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      finalMessage: "",
      aborted: false,
      generatedImages: [
        {
          id: "ig-1",
          contentBase64: "QUJDREVGRw==",
          contentType: "image/png",
          savedPath: "/tmp/ig-1.png",
          revisedPrompt: "blue cat"
        }
      ]
    });
  });

  it("reads account rate limits through account/rateLimits/read", async () => {
    const server = await createServer((socket, message) => {
      if (message.method === "initialize") {
        socket.send(JSON.stringify({
          id: message.id,
          result: { ok: true }
        }));
        return;
      }

      if (message.method === "account/rateLimits/read") {
        expect(message.params).toBeUndefined();
        socket.send(JSON.stringify({
          id: message.id,
          result: {
            rateLimits: {
              limitId: "codex",
              limitName: "Codex",
              primary: {
                usedPercent: 42,
                windowDurationMins: 300,
                resetsAt: 1_735_692_000
              },
              secondary: {
                usedPercent: 7,
                windowDurationMins: 10_080,
                resetsAt: 1_735_999_999
              },
              credits: {
                hasCredits: true,
                unlimited: false,
                balance: "18.75"
              },
              planType: "pro"
            },
            rateLimitsByLimitId: {
              codex: {
                limitId: "codex",
                limitName: "Codex",
                primary: {
                  usedPercent: 42,
                  windowDurationMins: 300,
                  resetsAt: 1_735_692_000
                },
                secondary: {
                  usedPercent: 7,
                  windowDurationMins: 10_080,
                  resetsAt: 1_735_999_999
                },
                credits: {
                  hasCredits: true,
                  unlimited: false,
                  balance: "18.75"
                },
                planType: "pro"
              }
            }
          }
        }));
      }
    });
    servers.push(server);

    const client = new AppServerClient({
      url: server.url,
      serviceName: "test",
      brokerHttpBaseUrl: "http://127.0.0.1:3000",
      reposRoot: "/tmp/repos"
    });

    await client.connect();
    await expect(client.readAccountRateLimits()).resolves.toEqual({
      rateLimits: {
        limitId: "codex",
        limitName: "Codex",
        primary: {
          usedPercent: 42,
          windowDurationMins: 300,
          resetsAt: 1_735_692_000
        },
        secondary: {
          usedPercent: 7,
          windowDurationMins: 10_080,
          resetsAt: 1_735_999_999
        },
        credits: {
          hasCredits: true,
          unlimited: false,
          balance: "18.75"
        },
        planType: "pro"
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          limitName: "Codex",
          primary: {
            usedPercent: 42,
            windowDurationMins: 300,
            resetsAt: 1_735_692_000
          },
          secondary: {
            usedPercent: 7,
            windowDurationMins: 10_080,
            resetsAt: 1_735_999_999
          },
          credits: {
            hasCredits: true,
            unlimited: false,
            balance: "18.75"
          },
          planType: "pro"
        }
      }
    });
  });

  it("syncs an active turn completion from thread/read", async () => {
    const server = await createServer((socket, message) => {
      if (message.method === "initialize") {
        socket.send(JSON.stringify({
          id: message.id,
          result: { ok: true }
        }));
        return;
      }

      if (message.method === "turn/start") {
        socket.send(JSON.stringify({
          id: message.id,
          result: {
            turn: {
              id: "turn-1"
            }
          }
        }));
        return;
      }

      if (message.method === "thread/read") {
        socket.send(JSON.stringify({
          id: message.id,
          result: {
            thread: {
              turns: [
                {
                  id: "turn-1",
                  status: "completed",
                  items: [
                    {
                      type: "agentMessage",
                      text: "done"
                    }
                  ]
                }
              ]
            }
          }
        }));
      }
    });
    servers.push(server);

    const client = new AppServerClient({
      url: server.url,
      serviceName: "test",
      brokerHttpBaseUrl: "http://127.0.0.1:3000",
      reposRoot: "/tmp/repos"
    });

    await client.connect();
    const started = await client.startTurn("thread-1", "/tmp", [
      {
        type: "text",
        text: "hello",
        text_elements: []
      }
    ]);

    await expect(
      client.readTurnResult("thread-1", "turn-1", {
        syncActiveTurn: true
      })
    ).resolves.toEqual({
      status: "completed",
      finalMessage: "done",
      errorMessage: undefined,
      generatedImages: []
    });
    await expect(started.completion).resolves.toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      finalMessage: "done",
      aborted: false,
      generatedImages: []
    });
  });

  it("rejects an active turn when thread/read shows it is missing", async () => {
    const server = await createServer((socket, message) => {
      if (message.method === "initialize") {
        socket.send(JSON.stringify({
          id: message.id,
          result: { ok: true }
        }));
        return;
      }

      if (message.method === "turn/start") {
        socket.send(JSON.stringify({
          id: message.id,
          result: {
            turn: {
              id: "turn-1"
            }
          }
        }));
        return;
      }

      if (message.method === "thread/read") {
        socket.send(JSON.stringify({
          id: message.id,
          result: {
            thread: {
              turns: []
            }
          }
        }));
      }
    });
    servers.push(server);

    const client = new AppServerClient({
      url: server.url,
      serviceName: "test",
      brokerHttpBaseUrl: "http://127.0.0.1:3000",
      reposRoot: "/tmp/repos"
    });

    await client.connect();
    const started = await client.startTurn("thread-1", "/tmp", [
      {
        type: "text",
        text: "hello",
        text_elements: []
      }
    ]);

    await expect(
      client.readTurnResult("thread-1", "turn-1", {
        syncActiveTurn: true,
        treatMissingAsStale: true
      })
    ).resolves.toBeNull();
    await expect(started.completion).rejects.toThrow(/missing from thread snapshot/i);
  });

  it("sends turn/steer with expectedTurnId and input text", async () => {
    let capturedParams: Record<string, unknown> | undefined;
    const server = await createServer((socket, message) => {
      if (message.method === "initialize") {
        socket.send(JSON.stringify({
          id: message.id,
          result: { ok: true }
        }));
        return;
      }

      if (message.method === "turn/steer") {
        capturedParams = (message as { params?: Record<string, unknown> }).params;
        socket.send(JSON.stringify({
          id: message.id,
          result: { ok: true }
        }));
      }
    });
    servers.push(server);

    const client = new AppServerClient({
      url: server.url,
      serviceName: "test",
      brokerHttpBaseUrl: "http://127.0.0.1:3000",
      reposRoot: "/tmp/repos"
    });

    await client.connect();
    await client.steerTurn({
      threadId: "thread-1",
      turnId: "turn-1",
      input: [
        {
          type: "text",
          text: "latest instruction",
          text_elements: []
        },
        {
          type: "image",
          url: "data:image/png;base64,abc123"
        }
      ]
    });

    expect(capturedParams).toMatchObject({
      threadId: "thread-1",
      expectedTurnId: "turn-1"
    });
    expect(capturedParams?.input).toEqual([
      {
        type: "text",
        text: "latest instruction",
        text_elements: []
      },
      {
        type: "image",
        url: "data:image/png;base64,abc123"
      }
    ]);
  });

  it("keeps the app-server websocket alive with heartbeat pings", async () => {
    let pingCount = 0;
    const server = await createServer((socket, message) => {
      socket.on("ping", () => {
        pingCount += 1;
      });

      if (message.method === "initialize") {
        socket.send(JSON.stringify({
          id: message.id,
          result: { ok: true }
        }));
      }
    });
    servers.push(server);

    const client = new AppServerClient({
      url: server.url,
      serviceName: "test",
      brokerHttpBaseUrl: "http://127.0.0.1:3000",
      reposRoot: "/tmp/repos",
      heartbeatIntervalMs: 20
    });

    await client.connect();
    await new Promise((resolve) => setTimeout(resolve, 75));
    await client.close();

    expect(pingCount).toBeGreaterThan(0);
  });

  it("injects personal memory into thread/start base instructions only once", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "app-server-client-"));
    tempDirs.push(tempRoot);
    const personalMemoryFilePath = path.join(tempRoot, "AGENT.md");
    await fs.writeFile(personalMemoryFilePath, "remember this\n");

    let threadStartParams: Record<string, unknown> | undefined;
    let threadResumeParams: Record<string, unknown> | undefined;
    const server = await createServer((socket, message) => {
      if (message.method === "initialize") {
        socket.send(JSON.stringify({
          id: message.id,
          result: { ok: true }
        }));
        return;
      }

      if (message.method === "thread/start") {
        threadStartParams = (message as { params?: Record<string, unknown> }).params;
        socket.send(JSON.stringify({
          id: message.id,
          result: {
            thread: {
              id: "thread-1"
            }
          }
        }));
        return;
      }

      if (message.method === "thread/resume") {
        threadResumeParams = (message as { params?: Record<string, unknown> }).params;
        socket.send(JSON.stringify({
          id: message.id,
          result: {
            thread: {
              id: "thread-1"
            }
          }
        }));
      }
    });
    servers.push(server);

    const client = new AppServerClient({
      url: server.url,
      serviceName: "test",
      brokerHttpBaseUrl: "http://127.0.0.1:3000",
      reposRoot: "/tmp/repos",
      personalMemoryFilePath
    });
    client.setSlackBotIdentity({
      userId: "U999",
      mention: "<@U999>",
      displayName: "codex-3720",
      username: "codexdmbot",
      realName: "codex-3720"
    });

    await client.connect();
    await expect(client.ensureThread({
      channelId: "C123",
      rootThreadTs: "111.222",
      workspacePath: "/tmp/workspace"
    })).resolves.toBe("thread-1");
    await expect(client.ensureThread({
      channelId: "C123",
      rootThreadTs: "111.222",
      codexThreadId: "thread-1",
      workspacePath: "/tmp/workspace"
    })).resolves.toBe("thread-1");

    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("channel_id: C123"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("thread_ts: 111.222"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("session_workspace: /tmp/workspace"));
    expect(threadStartParams?.baseInstructions).toEqual(
      expect.stringContaining(`runtime_platform: ${process.platform}`)
    );
    expect(threadStartParams?.baseInstructions).toEqual(
      expect.stringContaining(`runtime_hostname: ${os.hostname()}`)
    );
    expect(threadStartParams?.baseInstructions).toEqual(
      expect.stringContaining("runtime_containerized:")
    );
    expect(threadStartParams?.baseInstructions).toEqual(
      expect.stringContaining("Verify platform-specific app/runtime behavior from the runtime you can actually observe")
    );
    expect(threadStartParams?.baseInstructions).not.toEqual(
      expect.stringContaining("You are running inside the broker's Linux Docker container, not on a macOS host.")
    );
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("~/.codex/AGENT.md"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("remember this"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("bot_user_id: U999"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("bot_mention: <@U999>"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("bot_display_name: codex-3720"));
    expect(threadStartParams?.baseInstructions).toEqual(
      expect.stringContaining("Base URL: http://127.0.0.1:3000")
    );
    expect(threadStartParams?.baseInstructions).toEqual(
      expect.stringContaining("/slack/post-message")
    );
    expect(threadStartParams?.baseInstructions).toEqual(
      expect.stringContaining("/slack/post-state")
    );
    expect(threadStartParams?.baseInstructions).toEqual(
      expect.stringContaining("/slack/post-file")
    );
    expect(threadStartParams?.baseInstructions).toEqual(
      expect.stringContaining("/jobs/register")
    );
    expect(threadStartParams?.baseInstructions).toEqual(
      expect.stringContaining("BROKER_JOB_HELPER")
    );
    expect(threadStartParams?.baseInstructions).toEqual(
      expect.stringContaining("/integrations/mcp-tools?server=linear|notion")
    );
    expect(threadStartParams?.baseInstructions).toEqual(
      expect.stringContaining("/integrations/mcp-call")
    );
    expect(threadStartParams?.baseInstructions).toEqual(
      expect.stringContaining("UI work:")
    );
    expect(threadStartParams?.baseInstructions).toEqual(
      expect.stringContaining("kimi --work-dir /absolute/project/path")
    );
    expect(threadStartParams?.baseInstructions).toEqual(
      expect.stringContaining("Keep APIs/data contracts unchanged")
    );
    expect(threadStartParams?.baseInstructions).toEqual(
      expect.stringContaining("Turn stopping contract")
    );
    expect(threadStartParams?.baseInstructions).toEqual(
      expect.stringContaining("wait only for broker-managed async jobs")
    );
    expect(threadStartParams?.baseInstructions).toEqual(
      expect.stringContaining("/slack/post-state")
    );
    expect(threadStartParams?.baseInstructions).toEqual(
      expect.stringContaining("Do not send duplicate state-only replies")
    );
    expect(threadStartParams?.baseInstructions).toEqual(
      expect.stringContaining("forwarded message only means the thread changed")
    );
    expect(threadStartParams?.baseInstructions).toEqual(
      expect.stringContaining("Direct status/follow-up questions")
    );
    expect(threadStartParams?.baseInstructions).toEqual(
      expect.stringContaining("Only speak when watcher updates are materially useful")
    );
    expect(threadStartParams?.baseInstructions).toEqual(
      expect.stringContaining("shared_repos_root: /tmp/repos")
    );
    expect(threadStartParams?.baseInstructions).toEqual(
      expect.stringContaining("Git/co-authors")
    );
    expect(threadStartParams?.baseInstructions).toEqual(
      expect.stringContaining("do not bypass hooks")
    );
    expect(threadStartParams?.baseInstructions).toEqual(
      expect.stringContaining("Co-authored-by")
    );
    expect(threadStartParams?.baseInstructions).toEqual(
      expect.stringContaining("Instruction boundaries")
    );
    expect(String(threadStartParams?.baseInstructions)).not.toContain("replace_with_linear_tool_name");
    expect(String(threadStartParams?.baseInstructions)).not.toContain("curl -sS -X POST");
    expect(String(threadStartParams?.baseInstructions)).not.toContain("{{");
    expect(threadResumeParams?.baseInstructions).toBeNull();
  });
});
