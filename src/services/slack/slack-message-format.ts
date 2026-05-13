import type {
  BackgroundJobEventPayload,
  JsonLike,
  ResolvedSlackThreadMessage,
  SlackImageAttachment,
  SlackInputMessage,
  SlackUserIdentity,
  UnexpectedTurnStopPayload
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
  readonly mentionedUsers?: readonly SlackUserIdentity[] | undefined;
  readonly images?: readonly SlackImageAttachment[] | undefined;
  readonly slackMessage?: JsonLike | undefined;
  readonly backgroundJob?: BackgroundJobEventPayload | undefined;
  readonly unexpectedTurnStop?: UnexpectedTurnStopPayload | undefined;
}

export function formatSlackMessageForAgent(
  message: SlackInputMessage,
  sender: SlackUserIdentity | null
): string {
  if (message.source === "background_job_event" && message.backgroundJob) {
    return formatBackgroundJobEventForAgent(message);
  }

  if (message.source === "unexpected_turn_stop" && message.unexpectedTurnStop) {
    return formatUnexpectedTurnStopForAgent(message);
  }

  if (message.source === "admin_session_reset") {
    return formatAdminSessionResetForAgent(message);
  }

  if (message.batchMessages && message.batchMessages.length > 0) {
    return formatRecoveredSlackBatchForAgent(message);
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

export function formatSlackHistoryContextForAgent(
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
          mentionedUsers: message.mentionedUsers,
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

function formatBackgroundJobEventForAgent(message: SlackInputMessage): string {
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
    "Decide whether it materially changes the work, requires a reply in Slack, or needs no action.",
    "Most watcher events do not need a Slack reply. If this is only routine monitoring noise or an unchanged waiting state, keep waiting silently.",
    "If this async event only confirms a completion you already told the Slack thread about, record a silent final state through /slack/post-state instead of posting another completion message.",
    "If you need to record that you are still intentionally waiting without speaking in Slack, use the broker's /slack/post-state wait API instead of posting another wait message.",
    "background_job_event_json:",
    "```json",
    JSON.stringify(payload, null, 2),
    "```"
  ].join("\n");
}

function formatUnexpectedTurnStopForAgent(message: SlackInputMessage): string {
  const payload = {
    source: message.source,
    message_ts: message.messageTs,
    previous_turn: {
      turn_id: message.unexpectedTurnStop?.turnId
    },
    reason:
      message.unexpectedTurnStop?.reason ??
      message.text.trim() ??
      "The previous run ended without an explicit final/block/wait state."
  };

  return [
    "The previous run for this Slack thread appears to have stopped unexpectedly.",
    "If the work is actually complete, send a short final Slack update now.",
    "If the thread already has a clear completion update from you and you only need to settle broker state, record a silent final state through /slack/post-state instead of sending another completion message.",
    "If you are intentionally blocked on user input, approval, credentials, or any other human/external dependency, send a Slack update with kind=block and a concrete blocker.",
    "If your visible Slack reply already explains the blocker, record a silent block state through /slack/post-state instead of sending a second state-only Slack message.",
    "If you are intentionally waiting on a broker-managed async job that is already running and will wake this session later, you may either send a Slack update with kind=wait or record a silent wait state through /slack/post-state.",
    "Use a visible kind=wait update only when the waiting state itself is worth telling the thread about. Do not use it for routine watcher ticks.",
    "Do not send a normal Slack reply and then a second '[block]' or '[wait]' line just to attach state.",
    "Otherwise resume the work from the latest state.",
    "unexpected_turn_stop_json:",
    "```json",
    JSON.stringify(payload, null, 2),
    "```"
  ].join("\n");
}

function formatAdminSessionResetForAgent(message: SlackInputMessage): string {
  const payload = {
    source: message.source,
    message_ts: message.messageTs,
    reason: message.text.trim() || "The broker admin reset this session."
  };
  const sections = [
    "The broker admin manually reset this Slack session.",
    "The previous agent thread/history was intentionally discarded. Treat this as a fresh agent session.",
    "Use the Slack thread context below as the only prior context, continue from the latest user intent, and reply only if the current Slack state requires it."
  ];

  if (message.contextText?.trim()) {
    sections.push(
      "",
      "Current Slack thread context:",
      message.contextText.trim()
    );
  } else {
    sections.push(
      "",
      "No Slack thread context was available from the broker at reset time."
    );
  }

  sections.push(
    "",
    "admin_session_reset_json:",
    "```json",
    JSON.stringify(payload, null, 2),
    "```"
  );

  return sections.join("\n");
}

function formatRecoveredSlackBatchForAgent(message: SlackInputMessage): string {
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
    mentioned_users: message.mentionedUsers && message.mentionedUsers.length > 0
      ? message.mentionedUsers.map((user) => ({
        user_id: user.userId,
        mention: user.mention,
        display_name: user.displayName,
        real_name: user.realName && user.realName !== user.displayName ? user.realName : undefined,
        username: user.username && user.username !== user.displayName ? user.username : undefined,
        ...buildTimezonePayload(user)
      }))
      : undefined,
    request_context: buildRequestContextPayload(message, sender),
    text: message.text || "[no text body]",
    text_with_resolved_mentions: resolveMentionText(message.text || "[no text body]", message.mentionedUsers),
    attachments: (message.images ?? []).map((attachment) => ({
      file_id: attachment.fileId,
      name: attachment.name,
      title: attachment.title,
      mimetype: attachment.mimetype,
      filetype: attachment.filetype,
      size: attachment.size,
      width: attachment.width,
      height: attachment.height,
      dimensions: formatImageDimensions(attachment),
      local_path: attachment.localPath,
      download_error: attachment.downloadError
    })),
    slack_message: buildSelectedSlackPayload(message),
    unexpected_turn_stop: message.unexpectedTurnStop
  };
}

function buildSelectedSlackPayload(message: SlackRenderableMessage): JsonLike | undefined {
  if (message.senderKind !== "bot" && message.senderKind !== "app") {
    return undefined;
  }

  const raw = toRecord(message.slackMessage);
  if (!raw) {
    return undefined;
  }

  const selected = pickJsonFields(raw, [
    "subtype",
    "bot_id",
    "app_id",
    "username",
    "text",
    "attachments",
    "blocks",
    "files"
  ]);
  return Object.keys(selected).length > 0 ? selected : undefined;
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
      username: sender?.username && sender.username !== sender.displayName ? sender.username : undefined,
      ...buildTimezonePayload(sender)
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

function buildRequestContextPayload(
  message: SlackRenderableMessage,
  sender: SlackUserIdentity | null
): Record<string, unknown> | undefined {
  const timezonePayload = buildTimezonePayload(sender);
  if (Object.keys(timezonePayload).length === 0) {
    return undefined;
  }

  const messageDate = parseSlackMessageDate(message.messageTs);
  const localTime = sender?.timezone && messageDate
    ? formatLocalTimeParts(messageDate, sender.timezone)
    : undefined;

  return {
    timezone_source: "slack_user_profile",
    ...(messageDate ? { message_time_utc: messageDate.toISOString() } : {}),
    ...(localTime
      ? {
          sender_local_date: localTime.date,
          sender_local_time: localTime.time
        }
      : {}),
    ...prefixTimezonePayload("sender", timezonePayload)
  };
}

function buildTimezonePayload(user: SlackUserIdentity | null | undefined): Record<string, unknown> {
  if (!user) {
    return {};
  }

  return {
    ...(user.timezone ? { timezone: user.timezone } : {}),
    ...(user.timezoneLabel ? { timezone_label: user.timezoneLabel } : {}),
    ...(user.timezoneOffsetSeconds !== undefined
      ? {
          timezone_offset_seconds: user.timezoneOffsetSeconds,
          timezone_offset: formatTimezoneOffset(user.timezoneOffsetSeconds)
        }
      : {})
  };
}

function prefixTimezonePayload(prefix: string, payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [`${prefix}_${key}`, value])
  );
}

function parseSlackMessageDate(messageTs: string | undefined): Date | undefined {
  const match = /^(\d{1,10})(?:\.(\d{1,6}))?$/.exec(messageTs?.trim() ?? "");
  if (!match) {
    return undefined;
  }

  const seconds = Number(match[1]);
  const microseconds = Number((match[2] ?? "").padEnd(6, "0"));
  if (
    !Number.isFinite(seconds) ||
    !Number.isFinite(microseconds) ||
    seconds <= 0 ||
    seconds > 10_000_000_000
  ) {
    return undefined;
  }

  const date = new Date((seconds * 1000) + Math.floor(microseconds / 1000));
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function formatLocalTimeParts(date: Date, timeZone: string): { date: string; time: string } | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }).formatToParts(date);
    const values = new Map(parts.map((part) => [part.type, part.value]));
    const year = values.get("year");
    const month = values.get("month");
    const day = values.get("day");
    const hour = values.get("hour");
    const minute = values.get("minute");
    const second = values.get("second");
    if (!year || !month || !day || !hour || !minute || !second) {
      return undefined;
    }
    return {
      date: `${year}-${month}-${day}`,
      time: `${hour}:${minute}:${second}`
    };
  } catch {
    return undefined;
  }
}

function formatTimezoneOffset(offsetSeconds: number): string | undefined {
  if (!Number.isFinite(offsetSeconds)) {
    return undefined;
  }

  const sign = offsetSeconds >= 0 ? "+" : "-";
  const absoluteSeconds = Math.abs(offsetSeconds);
  const hours = Math.floor(absoluteSeconds / 3600);
  const minutes = Math.floor((absoluteSeconds % 3600) / 60);
  return `${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function formatImageDimensions(image: SlackImageAttachment): string | undefined {
  if (!image.width || !image.height) {
    return undefined;
  }

  return `${image.width}x${image.height}`;
}

function pickJsonFields(value: Record<string, JsonLike>, keys: readonly string[]): Record<string, JsonLike> {
  const picked: Record<string, JsonLike> = {};
  for (const key of keys) {
    if (value[key] !== undefined) {
      picked[key] = value[key]!;
    }
  }
  return picked;
}

function toRecord(value: JsonLike | undefined): Record<string, JsonLike> | undefined {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, JsonLike>;
}

export function resolveMentionText(
  text: string,
  mentionedUsers?: readonly SlackUserIdentity[] | undefined
): string {
  if (!mentionedUsers || mentionedUsers.length === 0) {
    return text;
  }

  let resolved = text;
  for (const user of mentionedUsers) {
    const label = user.displayName ?? user.realName ?? user.username ?? user.mention;
    resolved = resolved.replaceAll(user.mention, `@${label}`);
  }
  return resolved;
}
