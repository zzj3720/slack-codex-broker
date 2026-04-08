import type {
  PersistedInboundMessage,
  PersistedInboundSource,
  SlackInboundSource,
  SlackSessionRecord,
  SlackTurnSignalKind
} from "../../types.js";

const AUTO_RECOVERY_SESSION_LOOKBACK_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_FAILURE_NOTIFICATION_COOLDOWN_MS = 5 * 60 * 1_000;

export function chunkSlackMessage(text: string, chunkSize = 3_500): string[] {
  const normalized = text.trim();
  if (normalized.length <= chunkSize) {
    return [normalized];
  }

  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < normalized.length) {
    chunks.push(normalized.slice(cursor, cursor + chunkSize));
    cursor += chunkSize;
  }

  return chunks;
}

export function isBeforeSlackTs(messageTs: string, beforeMessageTs?: string): boolean {
  if (!beforeMessageTs) {
    return true;
  }

  return compareSlackTs(messageTs, beforeMessageTs) < 0;
}

export function compareSlackTs(left: string, right: string): number {
  const leftValue = Number(left);
  const rightValue = Number(right);

  if (Number.isFinite(leftValue) && Number.isFinite(rightValue)) {
    return leftValue - rightValue;
  }

  return left.localeCompare(right);
}

export function isSlackMessageAfterCursor(messageTs: string, cursorTs?: string | undefined): boolean {
  if (!cursorTs) {
    return false;
  }

  return compareSlackTs(messageTs, cursorTs) > 0;
}

export function shouldAutoRecoverSession(session: SlackSessionRecord, nowMs: number): boolean {
  if (!session.lastObservedMessageTs && !session.lastDeliveredMessageTs) {
    return false;
  }

  const updatedAtMs = Date.parse(session.updatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    return false;
  }

  return nowMs - updatedAtMs <= AUTO_RECOVERY_SESSION_LOOKBACK_MS;
}

export function compareIsoTimestamp(left: string, right: string): number {
  return Date.parse(left) - Date.parse(right);
}

export function createInboundMessageKey(sessionKey: string, messageTs: string): string {
  return `${sessionKey}:${messageTs}`;
}

export function createSyntheticMessageTs(): string {
  const now = Date.now();
  const suffix = Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, "0");
  return `${now}.${suffix}`;
}

export function clampHistoryLimit(requested: number | undefined, fallback: number, max: number): number {
  const resolved = requested ?? fallback;
  return Math.max(0, Math.min(resolved, max));
}

export function isRecoverableCodexTurnFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    "Codex app-server websocket is not connected",
    "Codex app-server websocket closed",
    "WebSocket is not open",
    "readyState 3",
    "socket hang up",
    "ECONNREFUSED",
    "closed"
  ].some((pattern) => message.includes(pattern));
}

export function isMissingCodexThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /no rollout found for thread id/i.test(message) ||
    /thread .* not found/i.test(message) ||
    /unknown thread/i.test(message)
  );
}

export function createSlackFailureFingerprint(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().replace(/\s+/g, " ");
}

export function shouldNotifySlackFailure(options: {
  readonly previousFingerprint?: string | undefined;
  readonly previousNotifiedAtMs?: number | undefined;
  readonly error: unknown;
  readonly nowMs: number;
  readonly cooldownMs?: number | undefined;
}): boolean {
  const fingerprint = createSlackFailureFingerprint(options.error);
  if (!options.previousFingerprint || options.previousNotifiedAtMs === undefined) {
    return true;
  }

  if (options.previousFingerprint !== fingerprint) {
    return true;
  }

  return options.nowMs - options.previousNotifiedAtMs >= (options.cooldownMs ?? DEFAULT_FAILURE_NOTIFICATION_COOLDOWN_MS);
}

export function formatSlackRunFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (isRecoverableCodexTurnFailure(error)) {
    return "I lost my connection while working on this thread. I will resume as soon as the connection comes back.";
  }

  if (isMissingCodexThreadError(error)) {
    return "I lost my previous runtime state for this thread. I am resetting the session and will continue from the latest state.";
  }

  if (isMissingActiveTurnSteerError(error)) {
    return "I lost track of the current run while reconnecting. I am resyncing and will continue from the latest state.";
  }

  if (/interrupt/i.test(message) || /aborted/i.test(message) || /cancel/i.test(message)) {
    return "I stopped the current run before it finished.";
  }

  return "I hit an internal issue while working on this thread. Send a quick follow-up and I will continue from the latest state.";
}

export function shouldPostSlackRunFailure(error: unknown): boolean {
  return !isRecoverableCodexTurnFailure(error);
}

export function isMissingActiveTurnSteerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no active turn to steer/i.test(message) || /expected active turn id `[^`]+` but found `[^`]+`/i.test(message);
}

export function parseActiveTurnMismatch(error: unknown): {
  readonly expectedTurnId: string;
  readonly actualTurnId: string;
} | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/expected active turn id `([^`]+)` but found `([^`]+)`/i);
  if (!match) {
    return null;
  }

  return {
    expectedTurnId: match[1]!,
    actualTurnId: match[2]!
  };
}

export function isSlackInboundSource(
  source: PersistedInboundSource | "recovered_thread_batch"
): source is SlackInboundSource {
  return source === "app_mention" || source === "direct_message" || source === "thread_reply";
}

export function isStopExplainingTurnSignalKind(kind: SlackTurnSignalKind | undefined): boolean {
  return kind === "final" || kind === "block" || kind === "wait";
}

export function isUnexpectedTurnStopMessage(message: PersistedInboundMessage): boolean {
  return message.source === "unexpected_turn_stop";
}
