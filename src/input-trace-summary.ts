export interface InputTraceDisplaySummary {
  readonly badgeLabel?: string | undefined;
  readonly title: string;
  readonly summary: string;
  readonly metadata: Record<string, string | number | boolean | null>;
}

export function summarizeInputTraceDisplay(options: {
  readonly source?: string | undefined;
  readonly text?: unknown;
  readonly fallbackTitle?: string | undefined;
  readonly fallbackSummary?: string | undefined;
}): InputTraceDisplaySummary | undefined {
  const source = normalizeString(options.source);
  const text = normalizeString(options.text);
  const extracted = extractInputPayload(text);

  if (extracted) {
    return summarizePayload(extracted.payload, source, extracted.kind);
  }

  const fallbackSummary = normalizeString(options.fallbackSummary);
  if (looksLikeBrokerWrapper(fallbackSummary)) {
    return {
      badgeLabel: "输入",
      title: normalizeString(options.fallbackTitle) || "输入",
      summary: "",
      metadata: {
        source
      }
    };
  }

  return undefined;
}

function summarizePayload(
  payload: Record<string, unknown>,
  source: string,
  kind: InputPayloadKind
): InputTraceDisplaySummary {
  if (kind === "recovered_message_batch" || Array.isArray(payload.messages)) {
    const messagePayloads = Array.isArray(payload.messages) ? payload.messages : [];
    const messages = messagePayloads
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => Boolean(entry));
    const first = messages[0];
    const firstText = compactText(extractSlackText(first), 180);
    return {
      badgeLabel: "恢复",
      title: firstText || `恢复 ${messages.length} 条 Slack 消息`,
      summary: `批量恢复 ${messages.length} 条消息`,
      metadata: {
        source,
        batchMessageCount: messages.length
      }
    };
  }

  if (kind === "background_job_event" || payload.job) {
    return summarizeBackgroundJobPayload(payload, source);
  }

  if (kind === "unexpected_turn_stop" || payload.previous_turn) {
    return summarizeUnexpectedTurnStopPayload(payload, source);
  }

  const slackText = compactText(extractSlackText(payload), 220);
  const sender = summarizeSender(asRecord(payload.sender));
  const attachmentCount = Array.isArray(payload.attachments)
    ? payload.attachments.length
    : Array.isArray(payload.images)
      ? payload.images.length
      : 0;
  const summary = [
    sender,
    sourceLabel(normalizeString(payload.source) || source),
    attachmentCount > 0 ? `${attachmentCount} 个附件` : ""
  ].filter(Boolean).join(" · ");

  return {
    badgeLabel: "Slack",
    title: slackText || "[无文本消息]",
    summary,
    metadata: compactMetadataRecord({
      source: normalizeString(payload.source) || source,
      messageTs: normalizeString(payload.message_ts),
      sender,
      attachmentCount
    })
  };
}

type InputPayloadKind =
  | "structured_message"
  | "recovered_message_batch"
  | "background_job_event"
  | "unexpected_turn_stop";

interface ExtractedInputPayload {
  readonly kind: InputPayloadKind;
  readonly payload: Record<string, unknown>;
}

function summarizeBackgroundJobPayload(payload: Record<string, unknown>, source: string): InputTraceDisplaySummary {
  const job = asRecord(payload.job);
  const jobKind = normalizeString(job?.job_kind);
  const eventKind = normalizeString(job?.event_kind);
  const jobId = normalizeString(job?.job_id);
  return {
    badgeLabel: "后台任务",
    title: compactText(
      normalizeString(payload.summary) ||
        normalizeString(payload.details_text) ||
        "后台任务事件",
      220
    ),
    summary: [
      jobKind,
      eventKind,
      jobId ? `Job ${jobId}` : ""
    ].filter(Boolean).join(" · "),
    metadata: compactMetadataRecord({
      source: normalizeString(payload.source) || source,
      messageTs: normalizeString(payload.message_ts),
      jobKind,
      eventKind,
      jobId
    })
  };
}

function summarizeUnexpectedTurnStopPayload(payload: Record<string, unknown>, source: string): InputTraceDisplaySummary {
  const previousTurn = asRecord(payload.previous_turn);
  const reason = normalizeString(payload.reason);
  return {
    badgeLabel: "提醒",
    title: "回合异常停止",
    summary: compactText(reason || "前一个回合没有明确结束状态", 220),
    metadata: compactMetadataRecord({
      source: normalizeString(payload.source) || source,
      messageTs: normalizeString(payload.message_ts),
      previousTurnId: normalizeString(previousTurn?.turn_id)
    })
  };
}

function extractInputPayload(text: string): ExtractedInputPayload | undefined {
  if (!text) {
    return undefined;
  }

  const namedPayload =
    extractNamedJsonPayload(text, "recovered_message_batch_json", "recovered_message_batch") ??
    extractNamedJsonPayload(text, "background_job_event_json", "background_job_event") ??
    extractNamedJsonPayload(text, "unexpected_turn_stop_json", "unexpected_turn_stop");
  if (namedPayload) {
    return namedPayload;
  }

  const blocks = extractJsonBlocks(text)
    .map((block) => parseJsonObject(block))
    .filter((payload): payload is Record<string, unknown> => Boolean(payload));
  const currentMessage = [...blocks].reverse().find((payload) =>
    normalizeString(payload.source) !== "thread_history" &&
      (
        payload.text !== undefined ||
        payload.text_with_resolved_mentions !== undefined ||
        payload.attachments !== undefined ||
        payload.images !== undefined
      )
  );
  const payload = currentMessage ?? blocks[blocks.length - 1];
  return payload ? {
    kind: "structured_message",
    payload
  } : undefined;
}

function extractNamedJsonPayload(
  text: string,
  label: string,
  kind: InputPayloadKind
): ExtractedInputPayload | undefined {
  const index = text.indexOf(label);
  if (index < 0) {
    return undefined;
  }

  const afterLabel = text.slice(index + label.length);
  const block = extractJsonBlocks(afterLabel)[0];
  const payload = block ? parseJsonObject(block) : undefined;
  return payload ? {
    kind,
    payload
  } : undefined;
}

function extractJsonBlocks(text: string): string[] {
  const blocks: string[] = [];
  const regex = /```json\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match[1]?.trim()) {
      blocks.push(match[1].trim());
    }
  }
  return blocks;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function extractSlackText(payload: Record<string, unknown> | undefined): string {
  if (!payload) {
    return "";
  }
  const text = normalizeString(payload.text_with_resolved_mentions) ||
    normalizeString(payload.text) ||
    normalizeString(payload.summary);
  return text === "[no text body]" ? "" : text;
}

function summarizeSender(sender: Record<string, unknown> | undefined): string {
  if (!sender) {
    return "";
  }
  return normalizeString(sender.display_name) ||
    normalizeString(sender.real_name) ||
    normalizeString(sender.username) ||
    normalizeString(sender.mention) ||
    normalizeString(sender.user_id) ||
    normalizeString(sender.sender_id);
}

function sourceLabel(source: string): string {
  const labels: Record<string, string> = {
    app_mention: "提及",
    direct_message: "私信",
    thread_reply: "线程回复",
    slack_user: "Slack",
    broker_recovery: "恢复",
    background_job: "后台任务",
    background_job_event: "后台任务"
  };
  return labels[source] || source;
}

function looksLikeBrokerWrapper(value: string): boolean {
  return value.startsWith("A newer Slack message arrived") ||
    value.startsWith("The broker detected Slack thread messages") ||
    value.startsWith("The broker server restarted or reconnected");
}

function compactText(value: string, maxLength: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(1, maxLength - 1)).trim()}…`;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function compactMetadataRecord(record: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const compacted: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(record)) {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      if (value !== "" && value !== 0) {
        compacted[key] = value;
      }
    }
  }
  return compacted;
}
