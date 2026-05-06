import type { PersistedInboundMessage, SlackSessionRecord } from "../../types.js";
import {
  isStopExplainingTurnSignalKind,
  isUnexpectedTurnStopMessage
} from "./slack-conversation-utils.js";

export type CompletedTurnDisposition =
  | {
      readonly kind: "none";
    }
  | {
      readonly kind: "unexpected_stop";
      readonly reason: string;
    };

export function planCompletedTurnDisposition(options: {
  readonly latestSession: SlackSessionRecord;
  readonly turnId: string;
  readonly dispatchMessages: readonly PersistedInboundMessage[];
  readonly aborted: boolean;
  readonly hasRunningBackgroundJob: boolean;
  readonly hasPendingUnexpectedStopNudge: boolean;
}): CompletedTurnDisposition {
  if (options.aborted) {
    return { kind: "none" };
  }

  if (
    options.dispatchMessages.length > 0 &&
    options.dispatchMessages.every((message) => isUnexpectedTurnStopMessage(message))
  ) {
    return { kind: "none" };
  }

  const signalKind =
    options.latestSession.lastTurnSignalTurnId === options.turnId
      ? options.latestSession.lastTurnSignalKind
      : undefined;
  if (isStopExplainingTurnSignalKind(signalKind)) {
    if (signalKind !== "wait" || options.hasRunningBackgroundJob) {
      return { kind: "none" };
    }
  }

  if (options.hasPendingUnexpectedStopNudge) {
    return { kind: "none" };
  }

  return {
    kind: "unexpected_stop",
    reason:
      signalKind === "wait"
        ? "The previous run said it was waiting, but there is no running broker-managed async job attached to this session. Either resume the work, declare a block that clearly names the human/external blocker, or register the async job and then declare wait."
        : "The previous run ended without an explicit final, block, or wait state. Either continue the work, send a final Slack update, declare a block that clearly names the human/external blocker, or declare a wait state backed by a running broker-managed async job."
  };
}
