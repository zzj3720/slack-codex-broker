import { describe, expect, it } from "vitest";

import { planCompletedTurnDisposition } from "../src/services/slack/slack-turn-disposition.js";
import type { PersistedInboundMessage, SlackSessionRecord } from "../src/types.js";

describe("planCompletedTurnDisposition", () => {
  it("nudges a completed turn that did not declare final, block, or wait", () => {
    const disposition = planCompletedTurnDisposition({
      latestSession: session({}),
      turnId: "turn-1",
      dispatchMessages: [message({ source: "thread_reply" })],
      aborted: false,
      hasRunningBackgroundJob: false,
      hasPendingUnexpectedStopNudge: false
    });

    expect(disposition).toMatchObject({
      kind: "unexpected_stop",
      reason: expect.stringContaining("explicit final, block, or wait state")
    });
  });

  it("does not nudge wait turns backed by a broker-managed async job", () => {
    const disposition = planCompletedTurnDisposition({
      latestSession: session({
        lastTurnSignalTurnId: "turn-1",
        lastTurnSignalKind: "wait"
      }),
      turnId: "turn-1",
      dispatchMessages: [message({ source: "thread_reply" })],
      aborted: false,
      hasRunningBackgroundJob: true,
      hasPendingUnexpectedStopNudge: false
    });

    expect(disposition).toEqual({ kind: "none" });
  });

  it("nudges wait turns when the async job is missing", () => {
    const disposition = planCompletedTurnDisposition({
      latestSession: session({
        lastTurnSignalTurnId: "turn-1",
        lastTurnSignalKind: "wait"
      }),
      turnId: "turn-1",
      dispatchMessages: [message({ source: "thread_reply" })],
      aborted: false,
      hasRunningBackgroundJob: false,
      hasPendingUnexpectedStopNudge: false
    });

    expect(disposition).toMatchObject({
      kind: "unexpected_stop",
      reason: expect.stringContaining("there is no running broker-managed async job")
    });
  });
});

function session(patch: Partial<SlackSessionRecord>): SlackSessionRecord {
  return {
    key: "C123:111.222",
    channelId: "C123",
    rootThreadTs: "111.222",
    workspacePath: "/tmp/session",
    createdAt: "2026-03-19T00:00:00.000Z",
    updatedAt: "2026-03-19T00:00:00.000Z",
    ...patch
  };
}

function message(patch: Partial<PersistedInboundMessage>): PersistedInboundMessage {
  return {
    key: "message-1",
    sessionKey: "C123:111.222",
    channelId: "C123",
    rootThreadTs: "111.222",
    messageTs: "111.223",
    source: "thread_reply",
    userId: "U123",
    text: "hello",
    status: "done",
    createdAt: "2026-03-19T00:00:00.000Z",
    updatedAt: "2026-03-19T00:00:00.000Z",
    ...patch
  };
}
