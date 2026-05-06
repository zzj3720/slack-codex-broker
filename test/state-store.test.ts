import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { STATE_DATABASE_FILENAME, StateStore } from "../src/store/state-store.js";

describe("StateStore", () => {
  it("persists sessions and processed events in the SQLite database", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-state-"));
    const sessionsRoot = path.join(stateDir, "sessions");
    const store = new StateStore(stateDir, sessionsRoot);
    await store.load();

    await Promise.all([
      store.markProcessedEvent("EvA"),
      store.markProcessedEvent("EvB"),
      store.upsertSession({
        key: "C123:111.222",
        channelId: "C123",
        rootThreadTs: "111.222",
        workspacePath: "/tmp/sessions/C123-111.222/workspace",
        createdAt: "2026-03-15T00:00:00.000Z",
        updatedAt: "2026-03-15T00:00:00.000Z"
      })
    ]);
    store.close();

    await expect(fs.access(path.join(stateDir, STATE_DATABASE_FILENAME))).resolves.toBeUndefined();

    const reloaded = new StateStore(stateDir, sessionsRoot);
    await reloaded.load();
    expect(reloaded.hasProcessedEvent("EvA")).toBe(true);
    expect(reloaded.hasProcessedEvent("EvB")).toBe(true);
    expect(reloaded.getSession("C123:111.222")).toEqual(expect.objectContaining({
      key: "C123:111.222"
    }));
    reloaded.close();
  });

  it("persists pending Slack events until they are processed", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-state-"));
    const sessionsRoot = path.join(stateDir, "sessions");
    const store = new StateStore(stateDir, sessionsRoot);
    await store.load();

    await store.enqueueSlackEvent("EvA", {
      event_id: "EvA",
      event: {
        type: "message",
        channel: "C123",
        thread_ts: "111.222",
        ts: "111.223",
        user: "U123",
        text: "hello"
      }
    });

    expect(store.listPendingSlackEvents()).toEqual([
      expect.objectContaining({
        eventId: "EvA",
        status: "pending",
        payload: expect.objectContaining({
          event_id: "EvA"
        })
      })
    ]);

    store.close();
    const reloaded = new StateStore(stateDir, sessionsRoot);
    await reloaded.load();
    expect(reloaded.listPendingSlackEvents()).toHaveLength(1);

    await reloaded.markSlackEventProcessed("EvA");
    expect(reloaded.hasProcessedEvent("EvA")).toBe(true);
    expect(reloaded.listPendingSlackEvents()).toHaveLength(0);
    reloaded.close();
  });

  it("deletes session state transactionally with inbound messages and background jobs", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-state-"));
    const sessionsRoot = path.join(stateDir, "sessions");
    const store = new StateStore(stateDir, sessionsRoot);
    await store.load();
    await store.upsertSession({
      key: "C123:111.222",
      channelId: "C123",
      rootThreadTs: "111.222",
      workspacePath: "/tmp/sessions/C123-111.222/workspace",
      createdAt: "2026-03-15T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:00.000Z"
    });
    await store.upsertInboundMessage({
      key: "inbound-1",
      sessionKey: "C123:111.222",
      channelId: "C123",
      rootThreadTs: "111.222",
      messageTs: "111.223",
      source: "thread_reply",
      userId: "U123",
      text: "follow up",
      status: "pending",
      createdAt: "2026-03-15T00:00:01.000Z",
      updatedAt: "2026-03-15T00:00:01.000Z"
    });
    await store.upsertBackgroundJob({
      id: "job-1",
      token: "token-1",
      sessionKey: "C123:111.222",
      channelId: "C123",
      rootThreadTs: "111.222",
      kind: "watch_ci",
      shell: "sh",
      cwd: "/tmp/sessions/C123-111.222/workspace",
      scriptPath: "/tmp/jobs/job-1/run.sh",
      restartOnBoot: true,
      status: "running",
      createdAt: "2026-03-15T00:00:02.000Z",
      updatedAt: "2026-03-15T00:00:02.000Z"
    });

    await expect(store.deleteSession("C123:111.222")).resolves.toBe(true);

    expect(store.getSession("C123:111.222")).toBeUndefined();
    expect(store.listInboundMessages({ sessionKey: "C123:111.222" })).toHaveLength(0);
    expect(store.listBackgroundJobs({ sessionKey: "C123:111.222" })).toHaveLength(0);
    store.close();
  });
});
