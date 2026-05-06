import { logger } from "../../logger.js";
import type {
  JsonLike,
  SlackImageAttachment,
  SlackSenderKind,
  SlackThreadMessage,
  SlackUserIdentity
} from "../../types.js";

interface SlackApiResponse<T> {
  readonly ok: boolean;
  readonly error?: string;
  readonly url?: string;
  readonly user_id?: string;
  readonly bot_id?: string;
  readonly app_id?: string;
  readonly ts?: string;
  readonly message?: T;
}

export interface SlackUploadedFile {
  readonly fileId: string;
  readonly title?: string | undefined;
  readonly name?: string | undefined;
  readonly mimetype?: string | undefined;
  readonly permalink?: string | undefined;
  readonly privateUrl?: string | undefined;
  readonly downloadUrl?: string | undefined;
  readonly size?: number | undefined;
}

export class SlackApi {
  readonly #baseUrl: string;
  readonly #appToken: string;
  readonly #botToken: string;
  readonly #userIdentityCache = new Map<string, Promise<SlackUserIdentity | null>>();

  constructor(options: {
    readonly baseUrl: string;
    readonly appToken: string;
    readonly botToken: string;
  }) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#appToken = options.appToken;
    this.#botToken = options.botToken;
  }

  async openSocketConnection(path = "apps.connections.open"): Promise<string> {
    const response = await this.#post<{ url: string }>(path, {}, this.#appToken);

    if (!response.url) {
      throw new Error("Slack apps.connections.open response did not include a websocket URL");
    }

    return response.url;
  }

  async authTest(): Promise<{
    readonly userId: string;
    readonly botId?: string | undefined;
    readonly appId?: string | undefined;
  }> {
    const response = await this.#post<{
      user_id: string;
      bot_id?: string;
      app_id?: string;
    }>("auth.test", {}, this.#botToken);

    if (!response.user_id) {
      throw new Error("Slack auth.test response did not include user_id");
    }

    return {
      userId: response.user_id,
      botId: normalizeSlackField(response.bot_id),
      appId: normalizeSlackField(response.app_id)
    };
  }

  async postThreadMessage(channel: string, threadTs: string, text: string): Promise<string | undefined> {
    const response = await this.#post<{ ts?: string }>(
      "chat.postMessage",
      {
        channel,
        thread_ts: threadTs,
        text
      },
      this.#botToken
    );

    logger.debug("Posted Slack thread message", {
      channel,
      threadTs,
      ts: response.ts
    });

    return response.ts;
  }

  async postEphemeral(options: {
    readonly channelId: string;
    readonly threadTs?: string | undefined;
    readonly userId: string;
    readonly text: string;
    readonly blocks?: readonly Record<string, unknown>[] | undefined;
  }): Promise<string | undefined> {
    const response = await this.#post<{ message_ts?: string; ts?: string }>(
      "chat.postEphemeral",
      {
        channel: options.channelId,
        user: options.userId,
        thread_ts: options.threadTs,
        text: options.text,
        blocks: options.blocks ? JSON.stringify(options.blocks) : undefined
      },
      this.#botToken
    );

    return response.message_ts ?? response.ts;
  }

  async openView(options: {
    readonly triggerId: string;
    readonly view: Record<string, unknown>;
  }): Promise<void> {
    await this.#post(
      "views.open",
      {
        trigger_id: options.triggerId,
        view: JSON.stringify(options.view)
      },
      this.#botToken
    );
  }

  async setAssistantThreadStatus(options: {
    readonly channelId: string;
    readonly threadTs: string;
    readonly status: string;
  }): Promise<void> {
    await this.#post(
      "assistant.threads.setStatus",
      {
        channel_id: options.channelId,
        thread_ts: options.threadTs,
        status: options.status,
        loading_messages: options.status.trim() ? options.status : undefined
      },
      this.#botToken
    );
  }

  async addReaction(options: {
    readonly channelId: string;
    readonly timestamp: string;
    readonly name: string;
  }): Promise<void> {
    await this.#post(
      "reactions.add",
      {
        channel: options.channelId,
        timestamp: options.timestamp,
        name: options.name
      },
      this.#botToken
    );
  }

  async removeReaction(options: {
    readonly channelId: string;
    readonly timestamp: string;
    readonly name: string;
  }): Promise<void> {
    await this.#post(
      "reactions.remove",
      {
        channel: options.channelId,
        timestamp: options.timestamp,
        name: options.name
      },
      this.#botToken
    );
  }

  async uploadThreadFile(options: {
    readonly channelId: string;
    readonly threadTs: string;
    readonly filename: string;
    readonly bytes: Uint8Array;
    readonly title?: string | undefined;
    readonly initialComment?: string | undefined;
    readonly altText?: string | undefined;
    readonly snippetType?: string | undefined;
    readonly contentType?: string | undefined;
  }): Promise<SlackUploadedFile> {
    const uploadStart = await this.#post<{
      upload_url?: string;
      file_id?: string;
    }>(
      "files.getUploadURLExternal",
      {
        filename: options.filename,
        length: options.bytes.byteLength,
        alt_txt: options.altText,
        snippet_type: options.snippetType
      },
      this.#botToken
    );

    if (!uploadStart.upload_url || !uploadStart.file_id) {
      throw new Error("Slack files.getUploadURLExternal response did not include upload_url and file_id");
    }

    await this.#uploadExternalFile(uploadStart.upload_url, options.bytes, options.contentType);

    const filesArgument = JSON.stringify([
      options.title
        ? { id: uploadStart.file_id, title: options.title }
        : { id: uploadStart.file_id }
    ]);
    const complete = await this.#post<{
      files?: Array<{
        id?: string;
        title?: string;
        name?: string;
        mimetype?: string;
        permalink?: string;
        url_private?: string;
        url_private_download?: string;
        size?: number;
      }>;
    }>(
      "files.completeUploadExternal",
      {
        files: filesArgument,
        channel_id: options.channelId,
        thread_ts: options.threadTs,
        initial_comment: options.initialComment
      },
      this.#botToken
    );

    const file = complete.files?.[0];

    if (!file?.id) {
      throw new Error("Slack files.completeUploadExternal response did not include uploaded file metadata");
    }

    logger.debug("Uploaded Slack thread file", {
      channel: options.channelId,
      threadTs: options.threadTs,
      fileId: file.id,
      filename: options.filename
    });

    return {
      fileId: file.id,
      title: normalizeSlackField(file.title),
      name: normalizeSlackField(file.name),
      mimetype: normalizeSlackField(file.mimetype),
      permalink: normalizeSlackField(file.permalink),
      privateUrl: normalizeSlackField(file.url_private),
      downloadUrl: normalizeSlackField(file.url_private_download),
      size: normalizeSlackNumber(file.size)
    };
  }

  async getUserIdentity(userId: string): Promise<SlackUserIdentity | null> {
    const cached = this.#userIdentityCache.get(userId);

    if (cached) {
      return await cached;
    }

    const pending = this.#fetchUserIdentity(userId);
    this.#userIdentityCache.set(userId, pending);

    try {
      return await pending;
    } catch (error) {
      this.#userIdentityCache.delete(userId);
      logger.warn("Failed to fetch Slack user identity", {
        userId,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  async listThreadMessages(options: {
    readonly channelId: string;
    readonly rootThreadTs: string;
    readonly channelType?: string | undefined;
  }): Promise<SlackThreadMessage[]> {
    const response = await this.#post<{
      messages?: Array<Record<string, unknown>>;
    }>(
      "conversations.replies",
      {
        channel: options.channelId,
        ts: options.rootThreadTs,
        limit: 200
      },
      this.#botToken
    );

    return (response.messages ?? []).flatMap((message) => {
      const author = resolveSlackMessageAuthor(message);
      const messageTs = typeof message.ts === "string" ? message.ts : undefined;
      const text = typeof message.text === "string" ? message.text : "";
      const images = normalizeSlackImageAttachments(message.files);
      const isSupportedSubtype = isSupportedSlackMessageSubtype(message.subtype);
      const slackMessage = normalizeSlackJson(message);

      if (!author.userId || !messageTs || (!text.trim() && images.length === 0 && !slackMessage) || !isSupportedSubtype) {
        return [];
      }

      return [
        {
          channelId: options.channelId,
          channelType: options.channelType,
          rootThreadTs: options.rootThreadTs,
          messageTs,
          userId: author.userId,
          text,
          senderKind: author.senderKind,
          botId: author.botId,
          appId: author.appId,
          senderUsername: author.senderUsername,
          images,
          slackMessage
        }
      ];
    });
  }

  async downloadImageAsDataUrl(image: SlackImageAttachment): Promise<string> {
    const response = await fetch(image.url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${this.#botToken}`
      }
    });

    if (!response.ok) {
      throw new Error(
        `Slack image download failed (${response.status} ${response.statusText}) for ${image.fileId}`
      );
    }

    const rawContentType = response.headers.get("content-type");
    const mediaType =
      rawContentType?.split(";")[0]?.trim() ||
      image.mimetype ||
      "application/octet-stream";
    const bytes = Buffer.from(await response.arrayBuffer());

    return `data:${mediaType};base64,${bytes.toString("base64")}`;
  }

  async #uploadExternalFile(
    uploadUrl: string,
    bytes: Uint8Array,
    contentType?: string | undefined
  ): Promise<void> {
    const response = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "content-type": contentType ?? "application/octet-stream"
      },
      body: Buffer.from(bytes)
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Slack file upload failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`
      );
    }
  }

  async #fetchUserIdentity(userId: string): Promise<SlackUserIdentity | null> {
    const response = await this.#post<{
      user?: {
        id?: string;
        name?: string;
        real_name?: string;
        profile?: {
          display_name?: string;
          display_name_normalized?: string;
          real_name?: string;
          real_name_normalized?: string;
          email?: string;
        };
      };
    }>(
      "users.info",
      {
        user: userId
      },
      this.#botToken
    );

    if (!response.user?.id) {
      return null;
    }

    const displayName = normalizeSlackField(
      response.user.profile?.display_name ??
        response.user.profile?.display_name_normalized
    );
    const realName = normalizeSlackField(
      response.user.real_name ??
        response.user.profile?.real_name ??
        response.user.profile?.real_name_normalized
    );
    const username = normalizeSlackField(response.user.name);

    return {
      userId: response.user.id,
      mention: `<@${response.user.id}>`,
      username,
      displayName,
      realName,
      email: normalizeSlackField(response.user.profile?.email)?.toLowerCase()
    };
  }

  async #post<T extends Record<string, unknown>>(
    path: string,
    body: Record<string, unknown>,
    token: string
  ): Promise<SlackApiResponse<T> & T> {
    const encodedBody = new URLSearchParams();

    for (const [key, value] of Object.entries(body)) {
      if (value == null) {
        continue;
      }

      encodedBody.set(key, String(value));
    }

    const response = await fetch(`${this.#baseUrl}/${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/x-www-form-urlencoded; charset=utf-8"
      },
      body: encodedBody.toString()
    });

    if (!response.ok) {
      throw new Error(`Slack API request failed (${response.status} ${response.statusText}) for ${path}`);
    }

    const payload = await response.json() as SlackApiResponse<T> & T;

    if (!payload.ok) {
      throw new Error(`Slack API error for ${path}: ${payload.error ?? "unknown_error"}`);
    }

    return payload;
  }
}

export function normalizeSlackImageAttachments(files: unknown): SlackImageAttachment[] {
  if (!Array.isArray(files)) {
    return [];
  }

  return files.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const file = entry as Record<string, unknown>;
    const fileId = normalizeSlackField(file.id);
    const mimetype = normalizeSlackField(file.mimetype);

    if (!fileId || !mimetype?.startsWith("image/")) {
      return [];
    }

    const url = pickSlackImageUrl(file);
    if (!url) {
      return [];
    }

    return [
      {
        fileId,
        name: normalizeSlackField(file.name),
        title: normalizeSlackField(file.title),
        mimetype,
        width: normalizeSlackNumber(
          file.original_w ??
            file.thumb_1024_w ??
            file.thumb_960_w ??
            file.thumb_720_w ??
            file.thumb_480_w ??
            file.thumb_360_w
        ),
        height: normalizeSlackNumber(
          file.original_h ??
            file.thumb_1024_h ??
            file.thumb_960_h ??
            file.thumb_720_h ??
            file.thumb_480_h ??
            file.thumb_360_h
        ),
        url
      }
    ];
  });
}

export function normalizeSlackJson(value: unknown): JsonLike | undefined {
  if (value === null) {
    return null;
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeSlackJson(entry))
      .filter((entry): entry is JsonLike => entry !== undefined);
  }

  if (typeof value !== "object") {
    return undefined;
  }

  const normalizedEntries = Object.entries(value)
    .map(([key, entry]) => [key, normalizeSlackJson(entry)] as const)
    .filter(([, entry]) => entry !== undefined);

  return Object.fromEntries(normalizedEntries) as { [key: string]: JsonLike };
}

function resolveSlackMessageAuthor(message: Record<string, unknown>): {
  readonly userId?: string | undefined;
  readonly senderKind: SlackSenderKind;
  readonly botId?: string | undefined;
  readonly appId?: string | undefined;
  readonly senderUsername?: string | undefined;
} {
  const botId = normalizeSlackField(message.bot_id);
  const appId = normalizeSlackField(message.app_id);
  const senderUsername = normalizeSlackField(message.username);

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

  const userId = normalizeSlackField(message.user);
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
    senderKind: "unknown"
  };
}

function isSupportedSlackMessageSubtype(value: unknown): boolean {
  const subtype = normalizeSlackField(value);
  if (!subtype) {
    return true;
  }

  return ![
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
  ].includes(subtype);
}

function pickSlackImageUrl(file: Record<string, unknown>): string | undefined {
  const candidates = [
    file.thumb_1024,
    file.thumb_960,
    file.thumb_720,
    file.thumb_480,
    file.thumb_360,
    file.url_private_download,
    file.url_private
  ];

  for (const candidate of candidates) {
    const normalized = normalizeSlackField(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return undefined;
}

function normalizeSlackField(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeSlackNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}
