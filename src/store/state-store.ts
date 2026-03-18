import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  PersistedBackgroundJob,
  PersistedInboundMessage,
  PersistedInboundMessageStatus,
  PersistedInboundSource,
  SlackSessionRecord
} from "../types.js";
import { ensureDir, fileExists } from "../utils/fs.js";

export class StateStore {
  readonly #stateDir: string;
  readonly #sessionsRoot: string;
  readonly #processedEventsFilePath: string;
  readonly #sessionsDirPath: string;
  readonly #inboundDirPath: string;
  readonly #jobsDirPath: string;

  #sessions = new Map<string, SlackSessionRecord>();
  #processedEventIds: string[] = [];
  #processedEventIdSet = new Set<string>();
  #inboundMessagesBySession = new Map<string, Map<string, PersistedInboundMessage>>();
  #backgroundJobs = new Map<string, PersistedBackgroundJob>();
  #writeChains = new Map<string, Promise<void>>();

  constructor(stateDir: string, sessionsRoot: string) {
    this.#stateDir = stateDir;
    this.#sessionsRoot = sessionsRoot;
    this.#processedEventsFilePath = path.join(stateDir, "processed-event-ids.json");
    this.#sessionsDirPath = path.join(stateDir, "sessions");
    this.#inboundDirPath = path.join(stateDir, "inbound-messages");
    this.#jobsDirPath = path.join(stateDir, "background-jobs");
  }

  async load(): Promise<void> {
    await ensureDir(this.#stateDir);
    await ensureDir(this.#sessionsDirPath);
    await ensureDir(this.#inboundDirPath);
    await ensureDir(this.#jobsDirPath);

    this.#resetInMemoryState();

    await this.#loadSplitState();
  }

  listSessions(): SlackSessionRecord[] {
    return [...this.#sessions.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getSession(key: string): SlackSessionRecord | undefined {
    return this.#sessions.get(key);
  }

  async upsertSession(record: SlackSessionRecord): Promise<void> {
    const normalized = this.#normalizeSession(record);
    this.#sessions.set(normalized.key, normalized);
    await this.#writeJsonAtomic(
      path.join(this.#sessionsDirPath, `${encodeKey(normalized.key)}.json`),
      normalized
    );
  }

  async patchSession(
    key: string,
    patch:
      | Partial<SlackSessionRecord>
      | ((current: SlackSessionRecord) => Partial<SlackSessionRecord>)
  ): Promise<SlackSessionRecord> {
    const filePath = path.join(this.#sessionsDirPath, `${encodeKey(key)}.json`);
    let updated!: SlackSessionRecord;

    await this.#runSerialized(filePath, async () => {
      const current = this.#sessions.get(key);
      if (!current) {
        throw new Error(`Unknown session: ${key}`);
      }

      const resolvedPatch = typeof patch === "function" ? patch(current) : patch;
      updated = this.#normalizeSession({
        ...current,
        ...resolvedPatch,
        key: current.key,
        channelId: current.channelId,
        rootThreadTs: current.rootThreadTs,
        workspacePath: resolvedPatch.workspacePath ?? current.workspacePath,
        createdAt: current.createdAt
      });

      this.#sessions.set(key, updated);
      await this.#writeJsonAtomicUnlocked(filePath, updated);
    });

    return updated;
  }

  hasProcessedEvent(eventId: string): boolean {
    return this.#processedEventIdSet.has(eventId);
  }

  async markProcessedEvent(eventId: string): Promise<void> {
    if (this.hasProcessedEvent(eventId)) {
      return;
    }

    this.#processedEventIds = [...this.#processedEventIds, eventId].slice(-2_000);
    this.#processedEventIdSet = new Set(this.#processedEventIds);
    await this.#writeJsonAtomic(this.#processedEventsFilePath, this.#processedEventIds);
  }

  listInboundMessages(options?: {
    readonly sessionKey?: string | undefined;
    readonly status?: PersistedInboundMessageStatus | readonly PersistedInboundMessageStatus[] | undefined;
    readonly batchId?: string | undefined;
    readonly source?: PersistedInboundSource | readonly PersistedInboundSource[] | undefined;
  }): PersistedInboundMessage[] {
    const statuses = Array.isArray(options?.status)
      ? options.status
      : options?.status
        ? [options.status]
        : undefined;
    const sources = Array.isArray(options?.source)
      ? options.source
      : options?.source
        ? [options.source]
        : undefined;
    const sessionKeys = options?.sessionKey ? [options.sessionKey] : [...this.#inboundMessagesBySession.keys()];

    return sessionKeys
      .flatMap((sessionKey) => [...(this.#inboundMessagesBySession.get(sessionKey)?.values() ?? [])])
      .filter((message) => {
        if (statuses && !statuses.includes(message.status)) {
          return false;
        }

        if (options?.batchId && message.batchId !== options.batchId) {
          return false;
        }

        if (sources && !sources.includes(message.source)) {
          return false;
        }

        return true;
      })
      .sort(compareInboundMessages);
  }

  getInboundMessage(sessionKey: string, messageTs: string): PersistedInboundMessage | undefined {
    return this.#inboundMessagesBySession.get(sessionKey)?.get(messageTs);
  }

  getLatestInboundMessageTs(sessionKey: string, options?: {
    readonly source?: PersistedInboundSource | readonly PersistedInboundSource[] | undefined;
  }): string | undefined {
    return this.listInboundMessages({
      sessionKey,
      source: options?.source
    }).at(-1)?.messageTs;
  }

  async upsertInboundMessage(record: PersistedInboundMessage): Promise<void> {
    const messages = this.#getOrCreateInboundSession(record.sessionKey);
    messages.set(record.messageTs, record);
    await this.#writeInboundSession(record.sessionKey);
  }

  async updateInboundMessage(
    sessionKey: string,
    messageTs: string,
    patch: {
      readonly status?: PersistedInboundMessageStatus | undefined;
      readonly batchId?: string | undefined;
    }
  ): Promise<PersistedInboundMessage | undefined> {
    const messages = this.#inboundMessagesBySession.get(sessionKey);
    const existing = messages?.get(messageTs);
    if (!existing) {
      return undefined;
    }

    const updated: PersistedInboundMessage = {
      ...existing,
      status: patch.status ?? existing.status,
      batchId: patch.batchId,
      updatedAt: new Date().toISOString()
    };
    messages!.set(messageTs, updated);
    await this.#writeInboundSession(sessionKey);
    return updated;
  }

  async updateInboundMessagesForBatch(
    sessionKey: string,
    messageTsList: readonly string[],
    patch: {
      readonly status?: PersistedInboundMessageStatus | undefined;
      readonly batchId?: string | undefined;
    }
  ): Promise<PersistedInboundMessage[]> {
    const messages = this.#inboundMessagesBySession.get(sessionKey);
    if (!messages) {
      return [];
    }

    const updatedAt = new Date().toISOString();
    const updated: PersistedInboundMessage[] = [];

    for (const messageTs of messageTsList) {
      const existing = messages.get(messageTs);
      if (!existing) {
        continue;
      }

      const nextMessage: PersistedInboundMessage = {
        ...existing,
        status: patch.status ?? existing.status,
        batchId: patch.batchId,
        updatedAt
      };
      messages.set(messageTs, nextMessage);
      updated.push(nextMessage);
    }

    if (updated.length > 0) {
      await this.#writeInboundSession(sessionKey);
    }

    return updated;
  }

  async resetInflightMessages(sessionKey: string, batchId?: string | undefined): Promise<PersistedInboundMessage[]> {
    const inflight = this.listInboundMessages({
      sessionKey,
      status: "inflight",
      batchId
    });

    return await this.updateInboundMessagesForBatch(
      sessionKey,
      inflight.map((message) => message.messageTs),
      {
        status: "pending",
        batchId: undefined
      }
    );
  }

  listBackgroundJobs(options?: {
    readonly sessionKey?: string | undefined;
    readonly id?: string | undefined;
  }): PersistedBackgroundJob[] {
    return [...this.#backgroundJobs.values()]
      .filter((job) => {
        if (options?.sessionKey && job.sessionKey !== options.sessionKey) {
          return false;
        }

        if (options?.id && job.id !== options.id) {
          return false;
        }

        return true;
      })
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getBackgroundJob(id: string): PersistedBackgroundJob | undefined {
    return this.#backgroundJobs.get(id);
  }

  async upsertBackgroundJob(record: PersistedBackgroundJob): Promise<void> {
    this.#backgroundJobs.set(record.id, record);
    await this.#writeJsonAtomic(
      path.join(this.#jobsDirPath, `${encodeKey(record.id)}.json`),
      record
    );
  }

  async #loadSplitState(): Promise<void> {
    this.#processedEventIds = await this.#readJsonFile(this.#processedEventsFilePath, []);
    this.#processedEventIdSet = new Set(this.#processedEventIds);

    for (const session of await this.#readEntityDirectory(this.#sessionsDirPath)) {
      const normalized = this.#normalizeSession(session as Partial<SlackSessionRecord>);
      this.#sessions.set(normalized.key, normalized);
    }

    for (const raw of await this.#readEntityDirectory(this.#inboundDirPath)) {
      const normalizedMessages = (Array.isArray(raw) ? raw : [])
        .map((message) => this.#normalizeInboundMessage(message as Partial<PersistedInboundMessage>))
        .filter((message): message is PersistedInboundMessage => message !== null);
      if (normalizedMessages.length === 0) {
        continue;
      }

      const sessionKey = normalizedMessages[0]!.sessionKey;
      this.#inboundMessagesBySession.set(
        sessionKey,
        new Map(normalizedMessages.map((message) => [message.messageTs, message]))
      );
    }

    for (const job of await this.#readEntityDirectory(this.#jobsDirPath)) {
      const normalized = this.#normalizeBackgroundJob(job as Partial<PersistedBackgroundJob>);
      if (normalized) {
        this.#backgroundJobs.set(normalized.id, normalized);
      }
    }
  }

  async #writeInboundSession(sessionKey: string): Promise<void> {
    const messages = [...(this.#inboundMessagesBySession.get(sessionKey)?.values() ?? [])]
      .sort(compareInboundMessages);
    await this.#writeJsonAtomic(
      path.join(this.#inboundDirPath, `${encodeKey(sessionKey)}.json`),
      messages
    );
  }

  async #writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
    await this.#runSerialized(filePath, async () => {
      await this.#writeJsonAtomicUnlocked(filePath, value);
    });
  }

  async #writeJsonAtomicUnlocked(filePath: string, value: unknown): Promise<void> {
    await ensureDir(path.dirname(filePath));
    const tempFilePath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(tempFilePath, JSON.stringify(value, null, 2));
    await fs.rename(tempFilePath, filePath);
  }

  async #runSerialized<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#writeChains.get(key) ?? Promise.resolve();
    let result!: T;
    const next = previous
      .catch(() => {})
      .then(async () => {
        result = await action();
      });

    this.#writeChains.set(key, next);
    try {
      await next;
    } finally {
      if (this.#writeChains.get(key) === next) {
        this.#writeChains.delete(key);
      }
    }

    return result;
  }

  async #readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
    if (!(await fileExists(filePath))) {
      return fallback;
    }

    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  }

  async #readEntityDirectory(directoryPath: string): Promise<unknown[]> {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .sort((left, right) => left.name.localeCompare(right.name));

    return await Promise.all(
      files.map(async (entry) => JSON.parse(await fs.readFile(path.join(directoryPath, entry.name), "utf8")))
    );
  }

  #getOrCreateInboundSession(sessionKey: string): Map<string, PersistedInboundMessage> {
    let messages = this.#inboundMessagesBySession.get(sessionKey);
    if (!messages) {
      messages = new Map();
      this.#inboundMessagesBySession.set(sessionKey, messages);
    }

    return messages;
  }

  #resetInMemoryState(): void {
    this.#sessions = new Map();
    this.#processedEventIds = [];
    this.#processedEventIdSet = new Set();
    this.#inboundMessagesBySession = new Map();
    this.#backgroundJobs = new Map();
  }

  #normalizeSession(session: Partial<SlackSessionRecord>): SlackSessionRecord {
    const workspacePath = session.workspacePath
      ? String(session.workspacePath)
      : path.join(
        this.#sessionsRoot,
        normalizeSessionDirectoryName(String(session.channelId), String(session.rootThreadTs)),
        "workspace"
      );
    return {
      key: String(session.key),
      channelId: String(session.channelId),
      rootThreadTs: String(session.rootThreadTs),
      workspacePath,
      createdAt: String(session.createdAt),
      updatedAt: String(session.updatedAt),
      codexThreadId: session.codexThreadId,
      activeTurnId: session.activeTurnId,
      activeTurnStartedAt: session.activeTurnStartedAt,
      lastObservedMessageTs: session.lastObservedMessageTs,
      lastDeliveredMessageTs: session.lastDeliveredMessageTs,
      lastSlackReplyAt: session.lastSlackReplyAt,
      lastProgressReminderAt: session.lastProgressReminderAt,
      lastTurnSignalTurnId: session.lastTurnSignalTurnId,
      lastTurnSignalKind: session.lastTurnSignalKind,
      lastTurnSignalReason: session.lastTurnSignalReason,
      lastTurnSignalAt: session.lastTurnSignalAt
    };
  }

  #normalizeInboundMessage(raw: Partial<PersistedInboundMessage>): PersistedInboundMessage | null {
    if (!raw.key || !raw.sessionKey || !raw.channelId || !raw.rootThreadTs || !raw.messageTs || !raw.source || !raw.userId) {
      return null;
    }

    return {
      key: String(raw.key),
      sessionKey: String(raw.sessionKey),
      channelId: String(raw.channelId),
      channelType: raw.channelType,
      rootThreadTs: String(raw.rootThreadTs),
      messageTs: String(raw.messageTs),
      source: raw.source,
      userId: String(raw.userId),
      text: String(raw.text ?? ""),
      senderKind: raw.senderKind,
      botId: raw.botId,
      appId: raw.appId,
      senderUsername: raw.senderUsername,
      mentionedUserIds: raw.mentionedUserIds ?? [],
      contextText: typeof raw.contextText === "string" ? raw.contextText : undefined,
      images: raw.images ?? [],
      slackMessage: raw.slackMessage,
      backgroundJob: raw.backgroundJob,
      unexpectedTurnStop: raw.unexpectedTurnStop,
      status: raw.status ?? "pending",
      batchId: raw.batchId,
      createdAt: String(raw.createdAt ?? new Date().toISOString()),
      updatedAt: String(raw.updatedAt ?? raw.createdAt ?? new Date().toISOString())
    };
  }

  #normalizeBackgroundJob(raw: Partial<PersistedBackgroundJob>): PersistedBackgroundJob | null {
    if (
      !raw.id ||
      !raw.token ||
      !raw.sessionKey ||
      !raw.channelId ||
      !raw.rootThreadTs ||
      !raw.kind ||
      !raw.shell ||
      !raw.cwd ||
      !raw.scriptPath ||
      !raw.status ||
      !raw.createdAt
    ) {
      return null;
    }

    return {
      id: String(raw.id),
      token: String(raw.token),
      sessionKey: String(raw.sessionKey),
      channelId: String(raw.channelId),
      rootThreadTs: String(raw.rootThreadTs),
      kind: String(raw.kind),
      shell: String(raw.shell),
      cwd: String(raw.cwd),
      scriptPath: String(raw.scriptPath),
      restartOnBoot: raw.restartOnBoot ?? true,
      status: raw.status,
      createdAt: String(raw.createdAt),
      updatedAt: String(raw.updatedAt ?? raw.createdAt),
      startedAt: raw.startedAt,
      heartbeatAt: raw.heartbeatAt,
      completedAt: raw.completedAt,
      cancelledAt: raw.cancelledAt,
      exitCode: raw.exitCode,
      error: raw.error,
      lastEventAt: raw.lastEventAt,
      lastEventKind: raw.lastEventKind,
      lastEventSummary: raw.lastEventSummary
    };
  }
}

function compareInboundMessages(left: PersistedInboundMessage, right: PersistedInboundMessage): number {
  return Number(left.messageTs) - Number(right.messageTs);
}

function normalizeSessionDirectoryName(channelId: string, rootThreadTs: string): string {
  return `${channelId}-${rootThreadTs}`.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function encodeKey(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
