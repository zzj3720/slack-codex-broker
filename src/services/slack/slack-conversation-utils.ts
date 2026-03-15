import type { PersistedInboundSource, SlackInboundSource, SlackSessionRecord } from "../../types.js";

const AUTO_RECOVERY_SESSION_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1_000;

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

export function isMissingActiveTurnSteerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no active turn to steer/i.test(message) || /expectedTurnId/i.test(message);
}

export function isSlackInboundSource(
  source: PersistedInboundSource | "recovered_thread_batch"
): source is SlackInboundSource {
  return source === "app_mention" || source === "direct_message" || source === "thread_reply";
}
