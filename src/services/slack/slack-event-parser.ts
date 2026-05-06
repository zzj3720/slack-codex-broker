import type {
  JsonLike,
  SlackImageAttachment,
  SlackInputMessage,
  SlackSenderKind,
  SlackThreadMessage
} from "../../types.js";
import {
  normalizeSlackImageAttachments,
  normalizeSlackJson
} from "./slack-api.js";

export interface SlackEventAuthor {
  readonly userId: string;
  readonly senderKind: SlackSenderKind;
  readonly botId?: string | undefined;
  readonly appId?: string | undefined;
  readonly senderUsername?: string | undefined;
}

export interface ParsedSlackEvent {
  readonly route: "app_mention" | "thread_reply" | "direct_message";
  readonly channelId: string;
  readonly rootThreadTs: string;
  readonly channelType?: string | undefined;
  readonly messageTs?: string | undefined;
  readonly controlText: string;
  readonly input: SlackInputMessage;
}

export function parseSlackEvent(event: Record<string, any>, botUserId: string): ParsedSlackEvent | null {
  const eventType = typeof event.type === "string" ? event.type : undefined;
  const channelId = typeof event.channel === "string" ? event.channel : undefined;
  const channelType = typeof event.channel_type === "string" ? event.channel_type : undefined;
  const messageTs = typeof event.ts === "string" ? event.ts : undefined;
  const author = resolveSlackEventAuthor(event);
  const metadata = parseSlackTextMetadata(String(event.text ?? ""));
  const images = normalizeSlackImageAttachments(event.files);
  const slackMessage = normalizeSlackJson(event);

  if (eventType === "app_mention" && channelId && messageTs) {
    const rootThreadTs = typeof event.thread_ts === "string" ? event.thread_ts : messageTs;
    return {
      route: "app_mention",
      channelId,
      rootThreadTs,
      channelType,
      messageTs,
      controlText: normalizeControlText(metadata.text, botUserId),
      input: createSlackInput({
        source: "app_mention",
        channelId,
        channelType,
        rootThreadTs,
        messageTs,
        userId: author.userId,
        senderKind: author.senderKind,
        botId: author.botId,
        appId: author.appId,
        senderUsername: author.senderUsername,
        text: metadata.text,
        mentionedUserIds: metadata.mentionedUserIds,
        images,
        slackMessage
      })
    };
  }

  if (eventType !== "message" || !channelId) {
    return null;
  }

  if (channelType === "im" && messageTs) {
    const rootThreadTs = typeof event.thread_ts === "string" ? event.thread_ts : messageTs;
    return {
      route: "direct_message",
      channelId,
      rootThreadTs,
      channelType,
      messageTs,
      controlText: normalizeControlText(metadata.text, botUserId),
      input: createSlackInput({
        source: "direct_message",
        channelId,
        channelType,
        rootThreadTs,
        messageTs,
        userId: author.userId,
        senderKind: author.senderKind,
        botId: author.botId,
        appId: author.appId,
        senderUsername: author.senderUsername,
        text: metadata.text,
        mentionedUserIds: metadata.mentionedUserIds,
        images,
        slackMessage
      })
    };
  }

  const rootThreadTs = typeof event.thread_ts === "string" ? event.thread_ts : undefined;
  if (!rootThreadTs) {
    return null;
  }

  return {
    route: "thread_reply",
    channelId,
    rootThreadTs,
    channelType,
    messageTs,
    controlText: normalizeControlText(metadata.text, botUserId),
    input: createSlackInput({
      source: "thread_reply",
      channelId,
      channelType,
      rootThreadTs,
      messageTs,
      userId: author.userId,
      senderKind: author.senderKind,
      botId: author.botId,
      appId: author.appId,
      senderUsername: author.senderUsername,
      text: metadata.text,
      mentionedUserIds: metadata.mentionedUserIds,
      images,
      slackMessage
    })
  };
}

export function createSlackInputFromThreadMessage(
  source: "thread_reply" | "thread_history",
  message: SlackThreadMessage
): SlackInputMessage {
  const metadata = parseSlackTextMetadata(message.text);
  return createSlackInput({
    source: source === "thread_history" ? "thread_reply" : source,
    channelId: message.channelId,
    channelType: message.channelType,
    rootThreadTs: message.rootThreadTs,
    messageTs: message.messageTs,
    userId: message.userId,
    senderKind: message.senderKind,
    botId: message.botId,
    appId: message.appId,
    senderUsername: message.senderUsername,
    text: metadata.text,
    mentionedUserIds: metadata.mentionedUserIds,
    images: message.images,
    slackMessage: message.slackMessage
  });
}

export function parseSlackTextMetadata(rawText: string): {
  readonly text: string;
  readonly mentionedUserIds: readonly string[];
} {
  return {
    text: rawText,
    mentionedUserIds: [...extractMentionedUserIds(rawText)]
  };
}

export function normalizeControlText(text: string, botUserId: string): string {
  return text.replaceAll(`<@${botUserId}>`, "").trim();
}

export function isSlackMessageEffectivelyEmpty(
  text: string,
  images: readonly SlackImageAttachment[] = [],
  slackMessage?: JsonLike | undefined
): boolean {
  return !text.trim() && images.length === 0 && !slackMessage;
}

export function resolveSlackEventAuthor(event: Record<string, any>): SlackEventAuthor {
  const botId = typeof event.bot_id === "string" ? event.bot_id : undefined;
  const appId = typeof event.app_id === "string" ? event.app_id : undefined;
  const senderUsername = typeof event.username === "string" ? event.username : undefined;

  if (botId) {
    return {
      userId: `bot:${botId}`,
      senderKind: "bot",
      botId,
      appId,
      senderUsername
    };
  }

  if (appId) {
    return {
      userId: `app:${appId}`,
      senderKind: "app",
      appId,
      senderUsername
    };
  }

  const userId = typeof event.user === "string" ? event.user : undefined;
  if (userId) {
    return {
      userId,
      senderKind: "user"
    };
  }

  if (senderUsername) {
    return {
      userId: `username:${senderUsername}`,
      senderKind: "unknown",
      senderUsername
    };
  }

  return {
    userId: "unknown:slack-message",
    senderKind: "unknown"
  };
}

function createSlackInput(options: {
  readonly source: SlackInputMessage["source"];
  readonly channelId: string;
  readonly channelType?: string | undefined;
  readonly rootThreadTs: string;
  readonly messageTs?: string | undefined;
  readonly userId: string;
  readonly senderKind?: SlackSenderKind | undefined;
  readonly botId?: string | undefined;
  readonly appId?: string | undefined;
  readonly senderUsername?: string | undefined;
  readonly text: string;
  readonly mentionedUserIds?: readonly string[] | undefined;
  readonly images?: readonly SlackImageAttachment[] | undefined;
  readonly slackMessage?: JsonLike | undefined;
}): SlackInputMessage {
  return {
    source: options.source,
    channelId: options.channelId,
    channelType: options.channelType,
    rootThreadTs: options.rootThreadTs,
    messageTs: options.messageTs,
    userId: options.userId,
    senderKind: options.senderKind,
    botId: options.botId,
    appId: options.appId,
    senderUsername: options.senderUsername,
    text: options.text,
    mentionedUserIds: options.mentionedUserIds,
    images: options.images,
    slackMessage: options.slackMessage
  };
}

function extractMentionedUserIds(text: string): Set<string> {
  const matches = text.matchAll(/<@([A-Z0-9]+)>/g);
  const userIds = new Set<string>();

  for (const match of matches) {
    const userId = match[1]?.trim();
    if (userId) {
      userIds.add(userId);
    }
  }

  return userIds;
}
