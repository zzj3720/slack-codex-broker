import { describe, expect, it } from "vitest";

import {
  createSlackFailureFingerprint,
  formatSlackRunFailureMessage,
  isMissingCodexThreadError,
  isMissingActiveTurnSteerError,
  parseActiveTurnMismatch,
  shouldAutoRecoverSession,
  shouldPostSlackRunFailure,
  shouldNotifySlackFailure
} from "../src/services/slack/slack-conversation-utils.js";

describe("slack conversation utils", () => {
  it("detects a missing active turn steer error", () => {
    expect(isMissingActiveTurnSteerError(new Error("no active turn to steer"))).toBe(true);
  });

  it("detects an active turn mismatch steer error", () => {
    expect(
      isMissingActiveTurnSteerError(
        new Error("expected active turn id `turn-old` but found `turn-new`")
      )
    ).toBe(true);
  });

  it("parses the actual active turn id from a mismatch error", () => {
    expect(
      parseActiveTurnMismatch(
        new Error("expected active turn id `turn-old` but found `turn-new`")
      )
    ).toEqual({
      expectedTurnId: "turn-old",
      actualTurnId: "turn-new"
    });
  });

  it("returns null for unrelated errors", () => {
    expect(parseActiveTurnMismatch(new Error("socket hang up"))).toBeNull();
  });

  it("formats recoverable websocket failures for Slack users", () => {
    expect(formatSlackRunFailureMessage(new Error("Codex app-server websocket closed"))).toBe(
      "I lost my connection while working on this thread. I will resume as soon as the connection comes back."
    );
  });

  it("suppresses visible Slack notifications for recoverable websocket failures", () => {
    expect(shouldPostSlackRunFailure(new Error("Codex app-server websocket closed"))).toBe(false);
  });

  it("formats active turn mismatches for Slack users", () => {
    expect(
      formatSlackRunFailureMessage(
        new Error("expected active turn id `turn-old` but found `turn-new`")
      )
    ).toBe(
      "I lost track of the current run while reconnecting. I am resyncing and will continue from the latest state."
    );
  });

  it("detects missing codex thread errors", () => {
    expect(isMissingCodexThreadError(new Error("no rollout found for thread id 019cf4fd"))).toBe(true);
  });

  it("formats missing codex thread errors for Slack users", () => {
    expect(
      formatSlackRunFailureMessage(new Error("no rollout found for thread id 019cf4fd"))
    ).toBe(
      "I lost my previous runtime state for this thread. I am resetting the session and will continue from the latest state."
    );
  });

  it("formats generic failures for Slack users", () => {
    expect(formatSlackRunFailureMessage(new Error("something unexpected happened"))).toBe(
      "I hit an internal issue while working on this thread. Send a quick follow-up and I will continue from the latest state."
    );
  });

  it("suppresses duplicate failure notifications within the cooldown window", () => {
    const error = new Error("no rollout found for thread id 019cf4fd");
    const fingerprint = createSlackFailureFingerprint(error);

    expect(
      shouldNotifySlackFailure({
        previousFingerprint: fingerprint,
        previousNotifiedAtMs: 10_000,
        error,
        nowMs: 10_100
      })
    ).toBe(false);
  });

  it("only auto-recovers sessions updated within the last day", () => {
    const nowMs = Date.parse("2026-04-08T12:00:00.000Z");
    const baseSession = {
      key: "C123:1.23",
      channelId: "C123",
      rootThreadTs: "1.23",
      workspacePath: "/tmp/workspace",
      createdAt: "2026-04-07T00:00:00.000Z",
      updatedAt: "2026-04-08T00:00:01.000Z",
      lastObservedMessageTs: "1775621831.247979"
    };

    expect(shouldAutoRecoverSession(baseSession, nowMs)).toBe(true);
    expect(
      shouldAutoRecoverSession(
        {
          ...baseSession,
          updatedAt: "2026-04-07T11:59:59.000Z"
        },
        nowMs
      )
    ).toBe(false);
  });

});
