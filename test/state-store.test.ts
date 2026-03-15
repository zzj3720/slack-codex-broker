import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { StateStore } from "../src/store/state-store.js";

describe("StateStore", () => {
  it("serializes concurrent saves without losing the final state", async () => {
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

    const processedEventIds = JSON.parse(
      await fs.readFile(path.join(stateDir, "processed-event-ids.json"), "utf8")
    ) as string[];
    const persistedSession = JSON.parse(
      await fs.readFile(
        path.join(stateDir, "sessions", Buffer.from("C123:111.222", "utf8").toString("base64url") + ".json"),
        "utf8"
      )
    ) as { readonly key: string };

    expect(processedEventIds).toEqual(expect.arrayContaining(["EvA", "EvB"]));
    expect(persistedSession).toEqual(expect.objectContaining({ key: "C123:111.222" }));
  });
});
