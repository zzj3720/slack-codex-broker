import { describe, expect, it, vi } from "vitest";

import { SlackTurnReconciler } from "../src/services/slack/slack-turn-reconciler.js";
import type { SlackSessionRecord } from "../src/types.js";

describe("SlackTurnReconciler", () => {
  it("retains an active turn when thread/read temporarily omits it", async () => {
    const session: SlackSessionRecord = {
      key: "C123:111.222",
      channelId: "C123",
      rootThreadTs: "111.222",
      workspacePath: "/tmp/workspace",
      codexThreadId: "thread-1",
      activeTurnId: "turn-1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const setActiveTurnId = vi.fn();
    const resetTurnBatchToPending = vi.fn();
    const readTurnSnapshot = vi.fn(async () => null);
    const ensureCodexThread = vi.fn(async () => session);

    const reconciler = new SlackTurnReconciler({
      sessions: {
        setActiveTurnId
      } as never,
      inboundStore: {
        resetTurnBatchToPending
      } as never,
      turnRunner: {
        ensureCodexThread,
        readTurnSnapshot
      } as never
    });

    await expect(reconciler.reconcileSingleActiveTurn(session)).resolves.toBe("retained");
    expect(ensureCodexThread).toHaveBeenCalledWith(session);
    expect(readTurnSnapshot).toHaveBeenCalledWith(session, "turn-1", {
      syncActiveTurn: true,
      treatMissingAsStale: false
    });
    expect(resetTurnBatchToPending).not.toHaveBeenCalled();
    expect(setActiveTurnId).not.toHaveBeenCalled();
  });

  it("clears an active turn when startup reconciliation treats a missing snapshot turn as stale", async () => {
    const session: SlackSessionRecord = {
      key: "C123:111.222",
      channelId: "C123",
      rootThreadTs: "111.222",
      workspacePath: "/tmp/workspace",
      codexThreadId: "thread-1",
      activeTurnId: "turn-1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const setActiveTurnId = vi.fn(async () => session);
    const resetTurnBatchToPending = vi.fn();
    const readTurnSnapshot = vi.fn(async () => null);
    const ensureCodexThread = vi.fn(async () => session);

    const reconciler = new SlackTurnReconciler({
      sessions: {
        setActiveTurnId
      } as never,
      inboundStore: {
        resetTurnBatchToPending
      } as never,
      turnRunner: {
        ensureCodexThread,
        readTurnSnapshot
      } as never
    });

    await expect(reconciler.reconcileSingleActiveTurn(session, {
      treatMissingAsStale: true
    })).resolves.toBe("cleared");
    expect(readTurnSnapshot).toHaveBeenCalledWith(session, "turn-1", {
      syncActiveTurn: true,
      treatMissingAsStale: true
    });
    expect(resetTurnBatchToPending).toHaveBeenCalledWith(session, "turn-1");
    expect(setActiveTurnId).toHaveBeenCalledWith("C123", "111.222", undefined);
  });
});
