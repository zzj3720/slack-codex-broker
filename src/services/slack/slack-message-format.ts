import type {
  BackgroundJobEventPayload,
  JsonLike,
  ResolvedSlackThreadMessage,
  SlackImageAttachment,
  SlackInputMessage,
  SlackUserIdentity
} from "../../types.js";

interface SlackRenderableMessage {
  readonly messageTs?: string | undefined;
  readonly source: string;
  readonly userId: string;
  readonly text: string;
  readonly senderKind?: "user" | "bot" | "app" | "unknown" | undefined;
  readonly botId?: string | undefined;
  readonly appId?: string | undefined;
  readonly senderUsername?: string | undefined;
  readonly mentionedUserIds?: readonly string[] | undefined;
  readonly images?: readonly SlackImageAttachment[] | undefined;
  readonly slackMessage?: JsonLike | undefined;
  readonly backgroundJob?: BackgroundJobEventPayload | undefined;
}

export function formatSlackMessageForCodex(
  message: SlackInputMessage,
  sender: SlackUserIdentity | null
): string {
  if (message.source === "background_job_event" && message.backgroundJob) {
    return formatBackgroundJobEventForCodex(message);
  }

  if (message.batchMessages && message.batchMessages.length > 0) {
    return formatRecoveredSlackBatchForCodex(message);
  }

  const currentMessageBlock = formatSlackMessageBlock(message, sender);

  if (!message.contextText) {
    return currentMessageBlock;
  }

  return [
    message.contextText.trim(),
    "Current Slack message requiring a response:",
    currentMessageBlock
  ].join("\n\n");
}

export function formatSlackHistoryContextForCodex(
  history: readonly ResolvedSlackThreadMessage[]
): string | undefined {
  if (history.length === 0) {
    return undefined;
  }

  const sections = [
    "Earlier Slack thread context before the current message. Treat these history items as context only; do not reply to them individually.",
    `history_count: ${history.length}`
  ];

  history.forEach((message, index) => {
    sections.push(`[history ${index + 1}]`);
    sections.push(
      formatSlackMessageBlock(
        {
          messageTs: message.messageTs,
          source: "thread_history",
          userId: message.userId,
          text: message.text,
          senderKind: message.senderKind,
          botId: message.botId,
          appId: message.appId,
          senderUsername: message.senderUsername,
          mentionedUserIds: message.mentionedUserIds,
          images: message.images,
          slackMessage: message.slackMessage
        },
        message.sender
      )
    );
  });

  return sections.join("\n\n");
}

function formatSlackMessageBlock(
  message: SlackRenderableMessage,
  sender: SlackUserIdentity | null
): string {
  const payload = buildSlackMessagePayload(message, sender);

  const header = message.source === "thread_history"
    ? "An earlier Slack thread message."
    : "A new message arrived in the active Slack thread. Carefully judge whether it requires a reply or action from you.";

  return `${header}\nstructured_message_json:\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
}

function formatBackgroundJobEventForCodex(message: SlackInputMessage): string {
  const payload = {
    source: message.source,
    message_ts: message.messageTs,
    job: {
      job_id: message.backgroundJob?.jobId,
      job_kind: message.backgroundJob?.jobKind,
      event_kind: message.backgroundJob?.eventKind
    },
    summary: message.backgroundJob?.summary ?? (message.text.trim() || "[no summary]"),
    details_text: message.backgroundJob?.detailsText,
    details_json: message.backgroundJob?.detailsJson
  };

  return [
    "A broker-managed background job reported a new asynchronous event for this session.",
    "Decide whether it changes the work, requires a reply in Slack, or needs no action.",
    "background_job_event_json:",
    "```json",
    JSON.stringify(payload, null, 2),
    "```"
  ].join("\n");
}

function formatRecoveredSlackBatchForCodex(message: SlackInputMessage): string {
  const batchMessages = message.batchMessages ?? [];
  const payload = {
    source: message.source,
    recovery_kind: message.recoveryKind,
    recovery_summary:
      "The broker server restarted or reconnected. These are Slack thread messages that may have been missed while the broker was offline.",
    batch_message_count: batchMessages.length,
    messages: batchMessages.map((entry) => buildSlackMessagePayload(entry, entry.sender ?? null))
  };

  return [
    "The broker server restarted or reconnected.",
    "Below is a chronological batch of Slack thread messages that may have been missed while the broker was offline.",
    "Review the batch carefully and decide whether any reply or action is needed now. Do not assume every message requires a reply.",
    "recovered_message_batch_json:",
    "```json",
    JSON.stringify(payload, null, 2),
    "```"
  ].join("\n");
}

function buildSlackMessagePayload(
  message: SlackRenderableMessage,
  sender: SlackUserIdentity | null
): Record<string, unknown> {
  return {
    source: message.source,
    message_ts: message.messageTs,
    sender: buildSenderPayload(message, sender),
    mentioned_user_ids: message.mentionedUserIds && message.mentionedUserIds.length > 0
      ? [...message.mentionedUserIds]
      : undefined,
    mentioned_user_mentions: message.mentionedUserIds && message.mentionedUserIds.length > 0
      ? message.mentionedUserIds.map((userId) => `<@${userId}>`)
      : undefined,
    text: message.text || "[no text body]",
    images: (message.images ?? []).map((image) => ({
      file_id: image.fileId,
      name: image.name,
      title: image.title,
      mimetype: image.mimetype,
      width: image.width,
      height: image.height,
      dimensions: formatImageDimensions(image)
    })),
    slack_message: message.slackMessage
  };
}

function buildSenderPayload(
  message: SlackRenderableMessage,
  sender: SlackUserIdentity | null
): Record<string, unknown> {
  if (message.senderKind === "user" || (!message.senderKind && sender)) {
    return {
      kind: "user",
      user_id: message.userId,
      mention: `<@${message.userId}>`,
      display_name: sender?.displayName,
      real_name: sender?.realName && sender.realName !== sender.displayName ? sender.realName : undefined,
      username: sender?.username && sender.username !== sender.displayName ? sender.username : undefined
    };
  }

  return {
    kind: message.senderKind ?? "unknown",
    sender_id: message.userId,
    bot_id: message.botId,
    app_id: message.appId,
    username: message.senderUsername
  };
}

function formatImageDimensions(image: SlackImageAttachment): string | undefined {
  if (!image.width || !image.height) {
    return undefined;
  }

  return `${image.width}x${image.height}`;
}
