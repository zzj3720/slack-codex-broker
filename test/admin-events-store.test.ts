import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { StateStore } from "../src/store/state-store.js";

describe("admin realtime event store", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("persists ordered admin events alongside state mutations", async () => {
    const { store } = await createStore();
    await store.upsertSession({
      key: "C123:111.222",
      channelId: "C123",
      channelName: "ops",
      rootThreadTs: "111.222",
      workspacePath: "/tmp/workspace",
      createdAt: "2026-05-09T00:00:00.000Z",
      updatedAt: "2026-05-09T00:00:00.000Z"
    });
    await store.upsertAgentTraceEvent({
      id: "trace-1",
      sessionKey: "C123:111.222",
      source: "agent_runtime",
      type: "agent_tool_call",
      at: "2026-05-09T00:00:01.000Z",
      sequence: 1,
      title: "工具调用",
      summary: "exec_command",
      detail: "{\"cmd\":\"pnpm test\"}",
      status: "running",
      role: "assistant",
      toolName: "exec_command",
      callId: "call-1",
      turnId: "turn-1",
      createdAt: "2026-05-09T00:00:01.000Z",
      updatedAt: "2026-05-09T00:00:01.000Z"
    });

    const events = store.listAdminEvents({ afterSequence: 0, limit: 10 });
    expect(events.map((event) => event.kind)).toEqual([
      "session.upsert",
      "trace.append"
    ]);
    expect(events[0]).toMatchObject({
      sequence: 1,
      scope: "session",
      sessionKey: "C123:111.222",
      entityId: "C123:111.222",
      payload: expect.objectContaining({
        key: "C123:111.222",
        channelName: "ops"
      })
    });
    expect(events[1]).toMatchObject({
      sequence: 2,
      scope: "session",
      sessionKey: "C123:111.222",
      entityId: "trace-1",
      payload: expect.objectContaining({
        type: "agent_tool_call",
        summary: "exec_command"
      })
    });
    expect(store.getLatestAdminEventSequence()).toBe(2);
    expect(store.listAdminEvents({ afterSequence: 1, limit: 10 }).map((event) => event.sequence)).toEqual([2]);
  });

  async function createStore(): Promise<{ readonly store: StateStore }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "admin-events-store-"));
    cleanups.push(async () => {
      await fs.rm(root, { force: true, recursive: true });
    });
    const store = new StateStore(path.join(root, "state"), path.join(root, "sessions"));
    await store.load();
    cleanups.push(async () => {
      store.close();
    });
    return { store };
  }
});
