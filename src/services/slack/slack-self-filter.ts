import type { JsonLike, SlackThreadMessage } from "../../types.js";

export interface SlackAuthIdentity {
  readonly userId: string;
  readonly botId?: string | undefined;
  readonly appId?: string | undefined;
}

const IGNORED_SUBTYPES = new Set([
  "message_changed",
  "message_deleted",
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "thread_broadcast"
]);

export class SlackSelfMessageFilter {
  #identity: SlackAuthIdentity | undefined;
  readonly #ignoredOutboundMessageTs = new Set<string>();

  setIdentity(identity: SlackAuthIdentity): void {
    this.#identity = identity;
  }

  rememberPostedMessageTs(messageTs: string): void {
    this.#ignoredOutboundMessageTs.add(messageTs);
    if (this.#ignoredOutboundMessageTs.size <= 500) {
      return;
    }

    const oldest = this.#ignoredOutboundMessageTs.values().next();
    if (!oldest.done) {
      this.#ignoredOutboundMessageTs.delete(oldest.value);
    }
  }

  shouldIgnoreEvent(event: Record<string, any>): boolean {
    const messageTs = typeof event.ts === "string" ? event.ts : undefined;
    if (messageTs && this.#ignoredOutboundMessageTs.has(messageTs)) {
      this.#ignoredOutboundMessageTs.delete(messageTs);
      return true;
    }

    const subtype = typeof event.subtype === "string" ? event.subtype : undefined;
    if (subtype && IGNORED_SUBTYPES.has(subtype)) {
      return true;
    }

    return isSelfAuthoredPayload(event, this.#identity);
  }

  shouldIgnoreThreadMessage(message: SlackThreadMessage): boolean {
    if (this.#ignoredOutboundMessageTs.has(message.messageTs)) {
      this.#ignoredOutboundMessageTs.delete(message.messageTs);
      return true;
    }

    const raw = toRecord(message.slackMessage);
    const subtype = typeof raw?.subtype === "string" ? raw.subtype : undefined;
    if (subtype && IGNORED_SUBTYPES.has(subtype)) {
      return true;
    }

    return isSelfAuthoredPayload(raw, this.#identity) || (
      this.#identity?.userId != null &&
      message.userId === this.#identity.userId
    );
  }
}

function isSelfAuthoredPayload(
  payload: Record<string, any> | JsonLike | undefined,
  identity: SlackAuthIdentity | undefined
): boolean {
  const record = toRecord(payload);
  if (!identity || !record) {
    return false;
  }

  const userId = typeof record.user === "string" ? record.user : undefined;
  if (userId && userId === identity.userId) {
    return true;
  }

  const botId = typeof record.bot_id === "string" ? record.bot_id : undefined;
  if (botId && identity.botId && botId === identity.botId) {
    return true;
  }

  const appId = typeof record.app_id === "string" ? record.app_id : undefined;
  if (appId && identity.appId && appId === identity.appId) {
    return true;
  }

  return false;
}

function isJsonRecord(value: JsonLike | Record<string, any>): value is Record<string, any> {
  return Boolean(value) && !Array.isArray(value) && typeof value === "object";
}

function toRecord(value: JsonLike | Record<string, any> | undefined): Record<string, any> | undefined {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return undefined;
  }

  return value as Record<string, any>;
}
