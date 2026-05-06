import fs from "node:fs/promises";
import path from "node:path";

import type {
  JsonLike,
  PersistedAdminAuditEvent,
  PersistedAdminOperation,
  PersistedBackgroundJob,
  PersistedInboundMessage,
  PersistedInboundMessageStatus,
  PersistedInboundSource,
  PersistedSlackEvent,
  SlackSessionRecord,
  SlackTurnSignalKind
} from "../types.js";
import { StateStore } from "../store/state-store.js";
import { ensureDir } from "../utils/fs.js";

export class SessionManager {
  readonly #stateStore: StateStore;
  readonly #sessionsRoot: string;

  constructor(options: {
    readonly stateStore: StateStore;
    readonly sessionsRoot: string;
  }) {
    this.#stateStore = options.stateStore;
    this.#sessionsRoot = options.sessionsRoot;
  }

  static createKey(channelId: string, rootThreadTs: string): string {
    return `${channelId}:${rootThreadTs}`;
  }

  async load(): Promise<void> {
    await this.#stateStore.load();
    await Promise.all(this.#stateStore.listSessions().map(async (session) => {
      await ensureDir(session.workspacePath);
    }));
  }

  getSession(channelId: string, rootThreadTs: string): SlackSessionRecord | undefined {
    return this.#stateStore.getSession(SessionManager.createKey(channelId, rootThreadTs));
  }

  listSessions(): SlackSessionRecord[] {
    return this.#stateStore.listSessions();
  }

  getSessionByKey(key: string): SlackSessionRecord | undefined {
    return this.#stateStore.getSession(key);
  }

  async deleteSessionByKey(key: string): Promise<boolean> {
    const session = this.#stateStore.getSession(key);
    if (session) {
      const sessionRoot = this.#resolveSessionRoot(session.workspacePath);
      if (sessionRoot) {
        await fs.rm(sessionRoot, { force: true, recursive: true });
      }
    }
    return await this.#stateStore.deleteSession(key);
  }

  hasProcessedEvent(eventId: string): boolean {
    return this.#stateStore.hasProcessedEvent(eventId);
  }

  async markProcessedEvent(eventId: string): Promise<void> {
    await this.#stateStore.markProcessedEvent(eventId);
  }

  async enqueueSlackEvent(eventId: string, payload: JsonLike): Promise<void> {
    await this.#stateStore.enqueueSlackEvent(eventId, payload);
  }

  listPendingSlackEvents(limit?: number): PersistedSlackEvent[] {
    return this.#stateStore.listPendingSlackEvents(limit);
  }

  async markSlackEventProcessed(eventId: string): Promise<void> {
    await this.#stateStore.markSlackEventProcessed(eventId);
  }

  async ensureSession(channelId: string, rootThreadTs: string): Promise<SlackSessionRecord> {
    const existing = this.getSession(channelId, rootThreadTs);
    if (existing) {
      await ensureDir(existing.workspacePath);
      return existing;
    }

    const workspacePath = this.#createWorkspacePath(channelId, rootThreadTs);
    await ensureDir(workspacePath);

    const record: SlackSessionRecord = {
      key: SessionManager.createKey(channelId, rootThreadTs),
      channelId,
      rootThreadTs,
      workspacePath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await this.#stateStore.upsertSession(record);
    return record;
  }

  async updateSession(record: SlackSessionRecord): Promise<void> {
    await this.#stateStore.patchSession(record.key, {
      ...record,
      updatedAt: new Date().toISOString()
    });
  }

  findSessionByWorkspace(cwd: string): SlackSessionRecord | undefined {
    const targetPath = path.resolve(cwd);
    const candidates = this.listSessions()
      .filter((session) => isSubpathOf(session.workspacePath, targetPath))
      .sort((left, right) => right.workspacePath.length - left.workspacePath.length);

    return candidates[0];
  }

  async setCodexThreadId(
    channelId: string,
    rootThreadTs: string,
    codexThreadId: string | undefined
  ): Promise<SlackSessionRecord> {
    return await this.#patchSession(channelId, rootThreadTs, {
      codexThreadId
    });
  }

  async setActiveTurnId(channelId: string, rootThreadTs: string, activeTurnId: string | undefined): Promise<SlackSessionRecord> {
    const now = new Date().toISOString();
    return await this.#patchSession(channelId, rootThreadTs, {
      activeTurnId,
      activeTurnStartedAt: activeTurnId ? now : undefined,
      lastProgressReminderAt: undefined
    });
  }

  async setLastObservedMessageTs(
    channelId: string,
    rootThreadTs: string,
    lastObservedMessageTs: string | undefined
  ): Promise<SlackSessionRecord> {
    return await this.#patchSession(channelId, rootThreadTs, {
      lastObservedMessageTs
    });
  }

  async setLastDeliveredMessageTs(
    channelId: string,
    rootThreadTs: string,
    lastDeliveredMessageTs: string | undefined
  ): Promise<SlackSessionRecord> {
    return await this.#patchSession(channelId, rootThreadTs, {
      lastDeliveredMessageTs
    });
  }

  async setLastSlackReplyAt(
    channelId: string,
    rootThreadTs: string,
    lastSlackReplyAt: string | undefined
  ): Promise<SlackSessionRecord> {
    return await this.#patchSession(channelId, rootThreadTs, {
      lastSlackReplyAt
    });
  }

  async setLastProgressReminderAt(
    channelId: string,
    rootThreadTs: string,
    lastProgressReminderAt: string | undefined
  ): Promise<SlackSessionRecord> {
    return await this.#patchSession(channelId, rootThreadTs, {
      lastProgressReminderAt
    });
  }

  async recordTurnSignal(
    channelId: string,
    rootThreadTs: string,
    signal: {
      readonly turnId?: string | undefined;
      readonly kind: SlackTurnSignalKind;
      readonly reason?: string | undefined;
      readonly occurredAt?: string | undefined;
    }
  ): Promise<SlackSessionRecord> {
    return await this.#patchSession(channelId, rootThreadTs, {
      lastTurnSignalTurnId: signal.turnId,
      lastTurnSignalKind: signal.kind,
      lastTurnSignalReason: signal.reason?.trim() || undefined,
      lastTurnSignalAt: signal.occurredAt ?? new Date().toISOString()
    });
  }

  async addCoAuthorCandidates(
    channelId: string,
    rootThreadTs: string,
    userIds: readonly string[]
  ): Promise<SlackSessionRecord> {
    const session = this.#requireSession(channelId, rootThreadTs);
    const additions = userIds
      .map((userId) => userId.trim())
      .filter(Boolean)
      .filter((userId, index, array) => array.indexOf(userId) === index)
      .filter((userId) => !(session.coAuthorCandidateUserIds ?? []).includes(userId));

    if (additions.length === 0) {
      return session;
    }

    return await this.#patchSession(channelId, rootThreadTs, {
      coAuthorCandidateUserIds: [...(session.coAuthorCandidateUserIds ?? []), ...additions],
      coAuthorCandidateRevision: (session.coAuthorCandidateRevision ?? 0) + 1,
      coAuthorIgnoreMissingRevision: undefined,
      coAuthorPromptRevision: undefined,
      coAuthorPromptedAt: undefined
    });
  }

  async confirmCoAuthors(
    channelId: string,
    rootThreadTs: string,
    options: {
      readonly userIds: readonly string[];
      readonly candidateRevision: number;
      readonly ignoreMissing?: boolean | undefined;
    }
  ): Promise<SlackSessionRecord> {
    const session = this.#requireSession(channelId, rootThreadTs);
    const confirmedUserIds = (session.coAuthorCandidateUserIds ?? [])
      .filter((userId) => options.userIds.includes(userId));

    return await this.#patchSession(channelId, rootThreadTs, {
      coAuthorConfirmedUserIds: confirmedUserIds,
      coAuthorConfirmedRevision: options.candidateRevision,
      coAuthorIgnoreMissingRevision: options.ignoreMissing ? options.candidateRevision : undefined,
      coAuthorPromptRevision: options.candidateRevision,
      coAuthorPromptedAt: undefined
    });
  }

  async allowMissingCoAuthors(
    channelId: string,
    rootThreadTs: string,
    candidateRevision: number
  ): Promise<SlackSessionRecord> {
    return await this.#patchSession(channelId, rootThreadTs, {
      coAuthorIgnoreMissingRevision: candidateRevision,
      coAuthorPromptRevision: candidateRevision,
      coAuthorPromptedAt: undefined
    });
  }

  async markCoAuthorPrompted(
    channelId: string,
    rootThreadTs: string,
    promptRevision: number
  ): Promise<SlackSessionRecord> {
    return await this.#patchSession(channelId, rootThreadTs, {
      coAuthorPromptRevision: promptRevision,
      coAuthorPromptedAt: new Date().toISOString()
    });
  }

  getInboundMessage(channelId: string, rootThreadTs: string, messageTs: string): PersistedInboundMessage | undefined {
    return this.#stateStore.getInboundMessage(SessionManager.createKey(channelId, rootThreadTs), messageTs);
  }

  listInboundMessages(options?: {
    readonly channelId?: string | undefined;
    readonly rootThreadTs?: string | undefined;
    readonly status?: PersistedInboundMessageStatus | readonly PersistedInboundMessageStatus[] | undefined;
    readonly batchId?: string | undefined;
    readonly source?: PersistedInboundSource | readonly PersistedInboundSource[] | undefined;
  }): PersistedInboundMessage[] {
    return this.#stateStore.listInboundMessages({
      sessionKey:
        options?.channelId && options?.rootThreadTs
          ? SessionManager.createKey(options.channelId, options.rootThreadTs)
          : undefined,
      status: options?.status,
      batchId: options?.batchId,
      source: options?.source
    });
  }

  getLatestInboundMessageTs(channelId: string, rootThreadTs: string): string | undefined {
    return this.#stateStore.getLatestInboundMessageTs(SessionManager.createKey(channelId, rootThreadTs));
  }

  getLatestSlackInboundMessageTs(channelId: string, rootThreadTs: string): string | undefined {
    return this.#stateStore.getLatestInboundMessageTs(SessionManager.createKey(channelId, rootThreadTs), {
      source: ["app_mention", "direct_message", "thread_reply"]
    });
  }

  async upsertInboundMessage(record: PersistedInboundMessage): Promise<void> {
    await this.#stateStore.upsertInboundMessage(record);
  }

  async updateInboundMessagesForBatch(
    channelId: string,
    rootThreadTs: string,
    messageTsList: readonly string[],
    patch: {
      readonly status?: PersistedInboundMessageStatus | undefined;
      readonly batchId?: string | undefined;
    }
  ): Promise<PersistedInboundMessage[]> {
    return await this.#stateStore.updateInboundMessagesForBatch(
      SessionManager.createKey(channelId, rootThreadTs),
      messageTsList,
      patch
    );
  }

  async resetInflightMessages(
    channelId: string,
    rootThreadTs: string,
    batchId?: string | undefined
  ): Promise<PersistedInboundMessage[]> {
    return await this.#stateStore.resetInflightMessages(
      SessionManager.createKey(channelId, rootThreadTs),
      batchId
    );
  }

  listBackgroundJobs(options?: {
    readonly channelId?: string | undefined;
    readonly rootThreadTs?: string | undefined;
    readonly id?: string | undefined;
  }): PersistedBackgroundJob[] {
    return this.#stateStore.listBackgroundJobs({
      sessionKey:
        options?.channelId && options?.rootThreadTs
          ? SessionManager.createKey(options.channelId, options.rootThreadTs)
          : undefined,
      id: options?.id
    });
  }

  getBackgroundJob(id: string): PersistedBackgroundJob | undefined {
    return this.#stateStore.getBackgroundJob(id);
  }

  async upsertBackgroundJob(record: PersistedBackgroundJob): Promise<void> {
    await this.#stateStore.upsertBackgroundJob(record);
  }

  listAdminOperations(limit?: number): PersistedAdminOperation[] {
    return this.#stateStore.listAdminOperations(limit);
  }

  getAdminOperation(id: string): PersistedAdminOperation | undefined {
    return this.#stateStore.getAdminOperation(id);
  }

  async upsertAdminOperation(record: PersistedAdminOperation): Promise<void> {
    await this.#stateStore.upsertAdminOperation(record);
  }

  listAdminAuditEvents(options?: {
    readonly operationId?: string | undefined;
    readonly limit?: number | undefined;
  }): PersistedAdminAuditEvent[] {
    return this.#stateStore.listAdminAuditEvents(options);
  }

  async appendAdminAuditEvent(record: PersistedAdminAuditEvent): Promise<void> {
    await this.#stateStore.appendAdminAuditEvent(record);
  }

  #requireSession(channelId: string, rootThreadTs: string): SlackSessionRecord {
    const session = this.getSession(channelId, rootThreadTs);
    if (!session) {
      throw new Error(`Unknown session: ${channelId}:${rootThreadTs}`);
    }

    return session;
  }

  #createWorkspacePath(channelId: string, rootThreadTs: string): string {
    return path.join(
      this.#sessionsRoot,
      `${channelId}-${rootThreadTs}`.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
      "workspace"
    );
  }

  #resolveSessionRoot(workspacePath: string): string | undefined {
    const resolvedSessionsRoot = path.resolve(this.#sessionsRoot);
    const resolvedWorkspacePath = path.resolve(workspacePath);
    const sessionRoot = path.basename(resolvedWorkspacePath) === "workspace"
      ? path.dirname(resolvedWorkspacePath)
      : resolvedWorkspacePath;

    return isSubpathOf(resolvedSessionsRoot, sessionRoot) ? sessionRoot : undefined;
  }

  async #patchSession(
    channelId: string,
    rootThreadTs: string,
    patch: Partial<SlackSessionRecord>
  ): Promise<SlackSessionRecord> {
    const session = this.#requireSession(channelId, rootThreadTs);
    return await this.#stateStore.patchSession(session.key, {
      ...patch,
      updatedAt: new Date().toISOString()
    });
  }
}

function isSubpathOf(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
