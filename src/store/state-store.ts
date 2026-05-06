import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import type {
  JsonLike,
  PersistedBackgroundJob,
  PersistedInboundMessage,
  PersistedInboundMessageStatus,
  PersistedInboundSource,
  PersistedSlackEvent,
  SlackSessionRecord
} from "../types.js";
import { ensureDir } from "../utils/fs.js";

export const STATE_DATABASE_FILENAME = "broker.sqlite";
export const CURRENT_STATE_SCHEMA_VERSION = 1;

type SqlValue = string | number | bigint | null;
type SqlRow = Record<string, unknown>;

interface StateMigration {
  readonly version: number;
  readonly name: string;
  readonly up: (database: DatabaseSync) => void;
}

const STATE_MIGRATIONS: readonly StateMigration[] = [
  {
    version: 1,
    name: "initial_sqlite_state",
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          key TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL,
          root_thread_ts TEXT NOT NULL,
          workspace_path TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          codex_thread_id TEXT,
          active_turn_id TEXT,
          active_turn_started_at TEXT,
          last_observed_message_ts TEXT,
          last_delivered_message_ts TEXT,
          last_slack_reply_at TEXT,
          last_progress_reminder_at TEXT,
          last_turn_signal_turn_id TEXT,
          last_turn_signal_kind TEXT,
          last_turn_signal_reason TEXT,
          last_turn_signal_at TEXT,
          co_author_candidate_user_ids TEXT,
          co_author_candidate_revision INTEGER,
          co_author_confirmed_user_ids TEXT,
          co_author_confirmed_revision INTEGER,
          co_author_ignore_missing_revision INTEGER,
          co_author_prompt_revision INTEGER,
          co_author_prompted_at TEXT,
          UNIQUE(channel_id, root_thread_ts)
        );

        CREATE TABLE IF NOT EXISTS inbound_messages (
          key TEXT NOT NULL UNIQUE,
          session_key TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
          channel_id TEXT NOT NULL,
          channel_type TEXT,
          root_thread_ts TEXT NOT NULL,
          message_ts TEXT NOT NULL,
          source TEXT NOT NULL,
          user_id TEXT NOT NULL,
          text TEXT NOT NULL,
          sender_kind TEXT,
          bot_id TEXT,
          app_id TEXT,
          sender_username TEXT,
          mentioned_user_ids TEXT,
          context_text TEXT,
          images TEXT,
          slack_message TEXT,
          background_job TEXT,
          unexpected_turn_stop TEXT,
          status TEXT NOT NULL,
          batch_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(session_key, message_ts)
        );

        CREATE TABLE IF NOT EXISTS background_jobs (
          id TEXT PRIMARY KEY,
          token TEXT NOT NULL,
          session_key TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
          channel_id TEXT NOT NULL,
          root_thread_ts TEXT NOT NULL,
          kind TEXT NOT NULL,
          shell TEXT NOT NULL,
          cwd TEXT NOT NULL,
          script_path TEXT NOT NULL,
          restart_on_boot INTEGER NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          heartbeat_at TEXT,
          completed_at TEXT,
          cancelled_at TEXT,
          exit_code INTEGER,
          error TEXT,
          last_event_at TEXT,
          last_event_kind TEXT,
          last_event_summary TEXT
        );

        CREATE TABLE IF NOT EXISTS processed_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE
        );

        CREATE TABLE IF NOT EXISTS slack_events (
          event_id TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_sessions_activity ON sessions(updated_at);
        CREATE INDEX IF NOT EXISTS idx_inbound_session_status ON inbound_messages(session_key, status, batch_id);
        CREATE INDEX IF NOT EXISTS idx_inbound_source ON inbound_messages(session_key, source, message_ts);
        CREATE INDEX IF NOT EXISTS idx_jobs_session_status ON background_jobs(session_key, status);
        CREATE INDEX IF NOT EXISTS idx_slack_events_status ON slack_events(status, created_at);
      `);
    }
  }
];

export class StateStore {
  readonly #stateDir: string;
  readonly #sessionsRoot: string;
  #database: DatabaseSync | undefined;

  constructor(stateDir: string, sessionsRoot: string) {
    this.#stateDir = stateDir;
    this.#sessionsRoot = sessionsRoot;
  }

  async load(): Promise<void> {
    await ensureDir(this.#stateDir);
    this.#openDatabase();
    this.#migrate();
  }

  close(): void {
    this.#database?.close();
    this.#database = undefined;
  }

  listSessions(): SlackSessionRecord[] {
    return this.#databaseRequired()
      .prepare("SELECT * FROM sessions ORDER BY created_at ASC")
      .all()
      .map((row) => this.#rowToSession(row as SqlRow));
  }

  getSession(key: string): SlackSessionRecord | undefined {
    const row = this.#databaseRequired()
      .prepare("SELECT * FROM sessions WHERE key = ?")
      .get(key) as SqlRow | undefined;
    return row ? this.#rowToSession(row) : undefined;
  }

  async upsertSession(record: SlackSessionRecord): Promise<void> {
    const normalized = this.#normalizeSession(record);
    this.#transaction(() => {
      this.#upsertSession(normalized);
    });
  }

  async deleteSession(key: string): Promise<boolean> {
    return this.#transaction(() => {
      const existing = this.#databaseRequired()
        .prepare("SELECT key FROM sessions WHERE key = ?")
        .get(key);
      if (!existing) {
        return false;
      }

      this.#databaseRequired().prepare("DELETE FROM sessions WHERE key = ?").run(key);
      return true;
    });
  }

  async patchSession(
    key: string,
    patch:
      | Partial<SlackSessionRecord>
      | ((current: SlackSessionRecord) => Partial<SlackSessionRecord>)
  ): Promise<SlackSessionRecord> {
    return this.#transaction(() => {
      const current = this.getSession(key);
      if (!current) {
        throw new Error(`Unknown session: ${key}`);
      }

      const resolvedPatch = typeof patch === "function" ? patch(current) : patch;
      const updated = this.#normalizeSession({
        ...current,
        ...resolvedPatch,
        key: current.key,
        channelId: current.channelId,
        rootThreadTs: current.rootThreadTs,
        workspacePath: resolvedPatch.workspacePath ?? current.workspacePath,
        createdAt: current.createdAt
      });

      this.#upsertSession(updated);
      return updated;
    });
  }

  hasProcessedEvent(eventId: string): boolean {
    return Boolean(this.#databaseRequired()
      .prepare("SELECT 1 FROM processed_events WHERE event_id = ?")
      .get(eventId));
  }

  async markProcessedEvent(eventId: string): Promise<void> {
    this.#transaction(() => {
      this.#markProcessedEvent(eventId);
    });
  }

  listPendingSlackEvents(limit = 100): PersistedSlackEvent[] {
    return this.#databaseRequired()
      .prepare(`
        SELECT * FROM slack_events
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT ?
      `)
      .all(limit)
      .map((row) => this.#rowToSlackEvent(row as SqlRow));
  }

  async enqueueSlackEvent(eventId: string, payload: JsonLike): Promise<void> {
    const now = new Date().toISOString();
    this.#transaction(() => {
      if (this.hasProcessedEvent(eventId)) {
        return;
      }

      this.#databaseRequired().prepare(`
        INSERT INTO slack_events (
          event_id, payload, status, created_at, updated_at
        ) VALUES (?, ?, 'pending', ?, ?)
        ON CONFLICT(event_id) DO UPDATE SET
          payload = CASE
            WHEN slack_events.status = 'done' THEN slack_events.payload
            ELSE excluded.payload
          END,
          status = CASE
            WHEN slack_events.status = 'done' THEN slack_events.status
            ELSE 'pending'
          END,
          updated_at = excluded.updated_at
      `).run(eventId, JSON.stringify(payload), now, now);
    });
  }

  async markSlackEventProcessed(eventId: string): Promise<void> {
    const now = new Date().toISOString();
    this.#transaction(() => {
      this.#databaseRequired()
        .prepare("UPDATE slack_events SET status = 'done', updated_at = ? WHERE event_id = ?")
        .run(now, eventId);
      this.#markProcessedEvent(eventId);
      this.#pruneDoneSlackEvents();
    });
  }

  listInboundMessages(options?: {
    readonly sessionKey?: string | undefined;
    readonly status?: PersistedInboundMessageStatus | readonly PersistedInboundMessageStatus[] | undefined;
    readonly batchId?: string | undefined;
    readonly source?: PersistedInboundSource | readonly PersistedInboundSource[] | undefined;
  }): PersistedInboundMessage[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    const statuses = arrayOption(options?.status);
    const sources = arrayOption(options?.source);

    if (options?.sessionKey) {
      where.push("session_key = ?");
      params.push(options.sessionKey);
    }
    if (statuses) {
      where.push(`status IN (${placeholders(statuses.length)})`);
      params.push(...statuses);
    }
    if (options?.batchId) {
      where.push("batch_id = ?");
      params.push(options.batchId);
    }
    if (sources) {
      where.push(`source IN (${placeholders(sources.length)})`);
      params.push(...sources);
    }

    const sql = [
      "SELECT * FROM inbound_messages",
      where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
      "ORDER BY CAST(message_ts AS REAL) ASC, message_ts ASC"
    ].filter(Boolean).join(" ");

    return this.#databaseRequired()
      .prepare(sql)
      .all(...params)
      .map((row) => this.#rowToInboundMessage(row as SqlRow))
      .sort(compareInboundMessages);
  }

  getInboundMessage(sessionKey: string, messageTs: string): PersistedInboundMessage | undefined {
    const row = this.#databaseRequired()
      .prepare("SELECT * FROM inbound_messages WHERE session_key = ? AND message_ts = ?")
      .get(sessionKey, messageTs) as SqlRow | undefined;
    return row ? this.#rowToInboundMessage(row) : undefined;
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
    const normalized = this.#normalizeInboundMessage(record);
    if (!normalized) {
      throw new Error(`Invalid inbound message: ${record.key}`);
    }
    this.#transaction(() => {
      this.#upsertInboundMessage(normalized);
    });
  }

  async updateInboundMessage(
    sessionKey: string,
    messageTs: string,
    patch: {
      readonly status?: PersistedInboundMessageStatus | undefined;
      readonly batchId?: string | undefined;
    }
  ): Promise<PersistedInboundMessage | undefined> {
    return this.#transaction(() => {
      const existing = this.getInboundMessage(sessionKey, messageTs);
      if (!existing) {
        return undefined;
      }

      const updated: PersistedInboundMessage = {
        ...existing,
        status: patch.status ?? existing.status,
        batchId: patch.batchId,
        updatedAt: new Date().toISOString()
      };
      this.#upsertInboundMessage(updated);
      return updated;
    });
  }

  async updateInboundMessagesForBatch(
    sessionKey: string,
    messageTsList: readonly string[],
    patch: {
      readonly status?: PersistedInboundMessageStatus | undefined;
      readonly batchId?: string | undefined;
    }
  ): Promise<PersistedInboundMessage[]> {
    return this.#transaction(() => {
      const updatedAt = new Date().toISOString();
      const updated: PersistedInboundMessage[] = [];

      for (const messageTs of messageTsList) {
        const existing = this.getInboundMessage(sessionKey, messageTs);
        if (!existing) {
          continue;
        }
        const nextMessage: PersistedInboundMessage = {
          ...existing,
          status: patch.status ?? existing.status,
          batchId: patch.batchId,
          updatedAt
        };
        this.#upsertInboundMessage(nextMessage);
        updated.push(nextMessage);
      }

      return updated;
    });
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
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (options?.sessionKey) {
      where.push("session_key = ?");
      params.push(options.sessionKey);
    }
    if (options?.id) {
      where.push("id = ?");
      params.push(options.id);
    }

    const sql = [
      "SELECT * FROM background_jobs",
      where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
      "ORDER BY created_at ASC"
    ].filter(Boolean).join(" ");

    return this.#databaseRequired()
      .prepare(sql)
      .all(...params)
      .map((row) => this.#rowToBackgroundJob(row as SqlRow));
  }

  getBackgroundJob(id: string): PersistedBackgroundJob | undefined {
    const row = this.#databaseRequired()
      .prepare("SELECT * FROM background_jobs WHERE id = ?")
      .get(id) as SqlRow | undefined;
    return row ? this.#rowToBackgroundJob(row) : undefined;
  }

  async upsertBackgroundJob(record: PersistedBackgroundJob): Promise<void> {
    const normalized = this.#normalizeBackgroundJob(record);
    if (!normalized) {
      throw new Error(`Invalid background job: ${record.id}`);
    }
    this.#transaction(() => {
      this.#upsertBackgroundJob(normalized);
    });
  }

  #openDatabase(): void {
    if (this.#database) {
      return;
    }
    this.#database = new DatabaseSync(path.join(this.#stateDir, STATE_DATABASE_FILENAME));
    this.#database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
    `);
  }

  #migrate(): void {
    this.#transaction(() => {
      const database = this.#databaseRequired();
      ensureSchemaMigrationsTable(database);
      const appliedVersions = new Set(
        (database
          .prepare("SELECT version FROM schema_migrations")
          .all() as Array<{ version: number | bigint }>)
          .map((row) => Number(row.version))
      );

      for (const migration of STATE_MIGRATIONS) {
        if (!appliedVersions.has(migration.version)) {
          migration.up(database);
          database
            .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
            .run(migration.version, migration.name, new Date().toISOString());
          continue;
        }

        database
          .prepare("UPDATE schema_migrations SET name = ? WHERE version = ? AND name != ?")
          .run(migration.name, migration.version, migration.name);
      }
    });
  }

  #upsertSession(record: SlackSessionRecord): void {
    this.#databaseRequired().prepare(`
      INSERT INTO sessions (
        key, channel_id, root_thread_ts, workspace_path, created_at, updated_at,
        codex_thread_id, active_turn_id, active_turn_started_at,
        last_observed_message_ts, last_delivered_message_ts, last_slack_reply_at,
        last_progress_reminder_at, last_turn_signal_turn_id, last_turn_signal_kind,
        last_turn_signal_reason, last_turn_signal_at,
        co_author_candidate_user_ids, co_author_candidate_revision,
        co_author_confirmed_user_ids, co_author_confirmed_revision,
        co_author_ignore_missing_revision, co_author_prompt_revision, co_author_prompted_at
      ) VALUES (${placeholders(24)})
      ON CONFLICT(key) DO UPDATE SET
        channel_id = excluded.channel_id,
        root_thread_ts = excluded.root_thread_ts,
        workspace_path = excluded.workspace_path,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        codex_thread_id = excluded.codex_thread_id,
        active_turn_id = excluded.active_turn_id,
        active_turn_started_at = excluded.active_turn_started_at,
        last_observed_message_ts = excluded.last_observed_message_ts,
        last_delivered_message_ts = excluded.last_delivered_message_ts,
        last_slack_reply_at = excluded.last_slack_reply_at,
        last_progress_reminder_at = excluded.last_progress_reminder_at,
        last_turn_signal_turn_id = excluded.last_turn_signal_turn_id,
        last_turn_signal_kind = excluded.last_turn_signal_kind,
        last_turn_signal_reason = excluded.last_turn_signal_reason,
        last_turn_signal_at = excluded.last_turn_signal_at,
        co_author_candidate_user_ids = excluded.co_author_candidate_user_ids,
        co_author_candidate_revision = excluded.co_author_candidate_revision,
        co_author_confirmed_user_ids = excluded.co_author_confirmed_user_ids,
        co_author_confirmed_revision = excluded.co_author_confirmed_revision,
        co_author_ignore_missing_revision = excluded.co_author_ignore_missing_revision,
        co_author_prompt_revision = excluded.co_author_prompt_revision,
        co_author_prompted_at = excluded.co_author_prompted_at
    `).run(
      record.key,
      record.channelId,
      record.rootThreadTs,
      record.workspacePath,
      record.createdAt,
      record.updatedAt,
      record.codexThreadId ?? null,
      record.activeTurnId ?? null,
      record.activeTurnStartedAt ?? null,
      record.lastObservedMessageTs ?? null,
      record.lastDeliveredMessageTs ?? null,
      record.lastSlackReplyAt ?? null,
      record.lastProgressReminderAt ?? null,
      record.lastTurnSignalTurnId ?? null,
      record.lastTurnSignalKind ?? null,
      record.lastTurnSignalReason ?? null,
      record.lastTurnSignalAt ?? null,
      jsonOrNull(record.coAuthorCandidateUserIds),
      record.coAuthorCandidateRevision ?? null,
      jsonOrNull(record.coAuthorConfirmedUserIds),
      record.coAuthorConfirmedRevision ?? null,
      record.coAuthorIgnoreMissingRevision ?? null,
      record.coAuthorPromptRevision ?? null,
      record.coAuthorPromptedAt ?? null
    );
  }

  #upsertInboundMessage(record: PersistedInboundMessage): void {
    this.#databaseRequired().prepare(`
      INSERT INTO inbound_messages (
        key, session_key, channel_id, channel_type, root_thread_ts, message_ts,
        source, user_id, text, sender_kind, bot_id, app_id, sender_username,
        mentioned_user_ids, context_text, images, slack_message, background_job,
        unexpected_turn_stop, status, batch_id, created_at, updated_at
      ) VALUES (${placeholders(23)})
      ON CONFLICT(session_key, message_ts) DO UPDATE SET
        key = excluded.key,
        session_key = excluded.session_key,
        channel_id = excluded.channel_id,
        channel_type = excluded.channel_type,
        root_thread_ts = excluded.root_thread_ts,
        message_ts = excluded.message_ts,
        source = excluded.source,
        user_id = excluded.user_id,
        text = excluded.text,
        sender_kind = excluded.sender_kind,
        bot_id = excluded.bot_id,
        app_id = excluded.app_id,
        sender_username = excluded.sender_username,
        mentioned_user_ids = excluded.mentioned_user_ids,
        context_text = excluded.context_text,
        images = excluded.images,
        slack_message = excluded.slack_message,
        background_job = excluded.background_job,
        unexpected_turn_stop = excluded.unexpected_turn_stop,
        status = excluded.status,
        batch_id = excluded.batch_id,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `).run(
      record.key,
      record.sessionKey,
      record.channelId,
      record.channelType ?? null,
      record.rootThreadTs,
      record.messageTs,
      record.source,
      record.userId,
      record.text,
      record.senderKind ?? null,
      record.botId ?? null,
      record.appId ?? null,
      record.senderUsername ?? null,
      jsonOrNull(record.mentionedUserIds ?? []),
      record.contextText ?? null,
      jsonOrNull(record.images ?? []),
      jsonOrNull(record.slackMessage),
      jsonOrNull(record.backgroundJob),
      jsonOrNull(record.unexpectedTurnStop),
      record.status,
      record.batchId ?? null,
      record.createdAt,
      record.updatedAt
    );
  }

  #upsertBackgroundJob(record: PersistedBackgroundJob): void {
    this.#databaseRequired().prepare(`
      INSERT INTO background_jobs (
        id, token, session_key, channel_id, root_thread_ts, kind, shell, cwd,
        script_path, restart_on_boot, status, created_at, updated_at, started_at,
        heartbeat_at, completed_at, cancelled_at, exit_code, error,
        last_event_at, last_event_kind, last_event_summary
      ) VALUES (${placeholders(22)})
      ON CONFLICT(id) DO UPDATE SET
        token = excluded.token,
        session_key = excluded.session_key,
        channel_id = excluded.channel_id,
        root_thread_ts = excluded.root_thread_ts,
        kind = excluded.kind,
        shell = excluded.shell,
        cwd = excluded.cwd,
        script_path = excluded.script_path,
        restart_on_boot = excluded.restart_on_boot,
        status = excluded.status,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        started_at = excluded.started_at,
        heartbeat_at = excluded.heartbeat_at,
        completed_at = excluded.completed_at,
        cancelled_at = excluded.cancelled_at,
        exit_code = excluded.exit_code,
        error = excluded.error,
        last_event_at = excluded.last_event_at,
        last_event_kind = excluded.last_event_kind,
        last_event_summary = excluded.last_event_summary
    `).run(
      record.id,
      record.token,
      record.sessionKey,
      record.channelId,
      record.rootThreadTs,
      record.kind,
      record.shell,
      record.cwd,
      record.scriptPath,
      record.restartOnBoot ? 1 : 0,
      record.status,
      record.createdAt,
      record.updatedAt,
      record.startedAt ?? null,
      record.heartbeatAt ?? null,
      record.completedAt ?? null,
      record.cancelledAt ?? null,
      record.exitCode ?? null,
      record.error ?? null,
      record.lastEventAt ?? null,
      record.lastEventKind ?? null,
      record.lastEventSummary ?? null
    );
  }

  #markProcessedEvent(eventId: string): void {
    this.#databaseRequired()
      .prepare("INSERT OR IGNORE INTO processed_events (event_id) VALUES (?)")
      .run(eventId);
    this.#databaseRequired().exec(`
      DELETE FROM processed_events
      WHERE sequence NOT IN (
        SELECT sequence FROM processed_events ORDER BY sequence DESC LIMIT 2000
      )
    `);
  }

  #pruneDoneSlackEvents(): void {
    this.#databaseRequired().exec(`
      DELETE FROM slack_events
      WHERE status = 'done'
        AND event_id NOT IN (
          SELECT event_id FROM slack_events
          WHERE status = 'done'
          ORDER BY updated_at DESC
          LIMIT 2000
        )
    `);
  }

  #rowToSession(row: SqlRow): SlackSessionRecord {
    return this.#normalizeSession({
      key: stringColumn(row, "key"),
      channelId: stringColumn(row, "channel_id"),
      rootThreadTs: stringColumn(row, "root_thread_ts"),
      workspacePath: stringColumn(row, "workspace_path"),
      createdAt: stringColumn(row, "created_at"),
      updatedAt: stringColumn(row, "updated_at"),
      codexThreadId: optionalStringColumn(row, "codex_thread_id"),
      activeTurnId: optionalStringColumn(row, "active_turn_id"),
      activeTurnStartedAt: optionalStringColumn(row, "active_turn_started_at"),
      lastObservedMessageTs: optionalStringColumn(row, "last_observed_message_ts"),
      lastDeliveredMessageTs: optionalStringColumn(row, "last_delivered_message_ts"),
      lastSlackReplyAt: optionalStringColumn(row, "last_slack_reply_at"),
      lastProgressReminderAt: optionalStringColumn(row, "last_progress_reminder_at"),
      lastTurnSignalTurnId: optionalStringColumn(row, "last_turn_signal_turn_id"),
      lastTurnSignalKind: optionalStringColumn(row, "last_turn_signal_kind") as SlackSessionRecord["lastTurnSignalKind"],
      lastTurnSignalReason: optionalStringColumn(row, "last_turn_signal_reason"),
      lastTurnSignalAt: optionalStringColumn(row, "last_turn_signal_at"),
      coAuthorCandidateUserIds: readJsonColumn(row, "co_author_candidate_user_ids", undefined),
      coAuthorCandidateRevision: optionalNumberColumn(row, "co_author_candidate_revision"),
      coAuthorConfirmedUserIds: readJsonColumn(row, "co_author_confirmed_user_ids", undefined),
      coAuthorConfirmedRevision: optionalNumberColumn(row, "co_author_confirmed_revision"),
      coAuthorIgnoreMissingRevision: optionalNumberColumn(row, "co_author_ignore_missing_revision"),
      coAuthorPromptRevision: optionalNumberColumn(row, "co_author_prompt_revision"),
      coAuthorPromptedAt: optionalStringColumn(row, "co_author_prompted_at")
    });
  }

  #rowToSlackEvent(row: SqlRow): PersistedSlackEvent {
    return {
      eventId: stringColumn(row, "event_id"),
      payload: readJsonColumn<JsonLike>(row, "payload", null),
      status: stringColumn(row, "status") as PersistedSlackEvent["status"],
      createdAt: stringColumn(row, "created_at"),
      updatedAt: stringColumn(row, "updated_at")
    };
  }

  #rowToInboundMessage(row: SqlRow): PersistedInboundMessage {
    return this.#normalizeInboundMessage({
      key: stringColumn(row, "key"),
      sessionKey: stringColumn(row, "session_key"),
      channelId: stringColumn(row, "channel_id"),
      channelType: optionalStringColumn(row, "channel_type"),
      rootThreadTs: stringColumn(row, "root_thread_ts"),
      messageTs: stringColumn(row, "message_ts"),
      source: stringColumn(row, "source") as PersistedInboundSource,
      userId: stringColumn(row, "user_id"),
      text: stringColumn(row, "text"),
      senderKind: optionalStringColumn(row, "sender_kind") as PersistedInboundMessage["senderKind"],
      botId: optionalStringColumn(row, "bot_id"),
      appId: optionalStringColumn(row, "app_id"),
      senderUsername: optionalStringColumn(row, "sender_username"),
      mentionedUserIds: readJsonColumn(row, "mentioned_user_ids", []),
      contextText: optionalStringColumn(row, "context_text"),
      images: readJsonColumn(row, "images", []),
      slackMessage: readJsonColumn(row, "slack_message", undefined),
      backgroundJob: readJsonColumn(row, "background_job", undefined),
      unexpectedTurnStop: readJsonColumn(row, "unexpected_turn_stop", undefined),
      status: stringColumn(row, "status") as PersistedInboundMessageStatus,
      batchId: optionalStringColumn(row, "batch_id"),
      createdAt: stringColumn(row, "created_at"),
      updatedAt: stringColumn(row, "updated_at")
    })!;
  }

  #rowToBackgroundJob(row: SqlRow): PersistedBackgroundJob {
    return this.#normalizeBackgroundJob({
      id: stringColumn(row, "id"),
      token: stringColumn(row, "token"),
      sessionKey: stringColumn(row, "session_key"),
      channelId: stringColumn(row, "channel_id"),
      rootThreadTs: stringColumn(row, "root_thread_ts"),
      kind: stringColumn(row, "kind"),
      shell: stringColumn(row, "shell"),
      cwd: stringColumn(row, "cwd"),
      scriptPath: stringColumn(row, "script_path"),
      restartOnBoot: booleanColumn(row, "restart_on_boot", true),
      status: stringColumn(row, "status") as PersistedBackgroundJob["status"],
      createdAt: stringColumn(row, "created_at"),
      updatedAt: stringColumn(row, "updated_at"),
      startedAt: optionalStringColumn(row, "started_at"),
      heartbeatAt: optionalStringColumn(row, "heartbeat_at"),
      completedAt: optionalStringColumn(row, "completed_at"),
      cancelledAt: optionalStringColumn(row, "cancelled_at"),
      exitCode: optionalNumberColumn(row, "exit_code"),
      error: optionalStringColumn(row, "error"),
      lastEventAt: optionalStringColumn(row, "last_event_at"),
      lastEventKind: optionalStringColumn(row, "last_event_kind"),
      lastEventSummary: optionalStringColumn(row, "last_event_summary")
    })!;
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
      lastTurnSignalAt: session.lastTurnSignalAt,
      coAuthorCandidateUserIds: normalizeStringArray(session.coAuthorCandidateUserIds),
      coAuthorCandidateRevision: normalizeFiniteNumber(session.coAuthorCandidateRevision),
      coAuthorConfirmedUserIds: normalizeStringArray(session.coAuthorConfirmedUserIds),
      coAuthorConfirmedRevision: normalizeFiniteNumber(session.coAuthorConfirmedRevision),
      coAuthorIgnoreMissingRevision: normalizeFiniteNumber(session.coAuthorIgnoreMissingRevision),
      coAuthorPromptRevision: normalizeFiniteNumber(session.coAuthorPromptRevision),
      coAuthorPromptedAt:
        typeof session.coAuthorPromptedAt === "string" ? session.coAuthorPromptedAt : undefined
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

  #databaseRequired(): DatabaseSync {
    if (!this.#database) {
      throw new Error("StateStore has not been loaded");
    }
    return this.#database;
  }

  #transaction<T>(operation: () => T): T {
    const db = this.#databaseRequired();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

function ensureSchemaMigrationsTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      applied_at TEXT NOT NULL
    );
  `);

  const columns = new Set(
    (database.prepare("PRAGMA table_info(schema_migrations)").all() as Array<{ name: string }>)
      .map((row) => row.name)
  );
  if (!columns.has("name")) {
    database.exec("ALTER TABLE schema_migrations ADD COLUMN name TEXT NOT NULL DEFAULT ''");
  }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function arrayOption<T>(value: T | readonly T[] | undefined): readonly T[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) ? value as readonly T[] : [value as T];
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function readJsonColumn<T>(row: SqlRow, column: string, fallback: T): T {
  const value = row[column];
  if (typeof value !== "string") {
    return fallback;
  }
  return JSON.parse(value) as T;
}

function stringColumn(row: SqlRow, column: string): string {
  return String(row[column]);
}

function optionalStringColumn(row: SqlRow, column: string): string | undefined {
  const value = row[column];
  return value === null || value === undefined ? undefined : String(value);
}

function optionalNumberColumn(row: SqlRow, column: string): number | undefined {
  const value = row[column];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return undefined;
}

function booleanColumn(row: SqlRow, column: string, fallback: boolean): boolean {
  const value = row[column];
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "bigint") {
    return value !== 0n;
  }
  return fallback;
}

function compareInboundMessages(left: PersistedInboundMessage, right: PersistedInboundMessage): number {
  return Number(left.messageTs) - Number(right.messageTs);
}

function normalizeSessionDirectoryName(channelId: string, rootThreadTs: string): string {
  return `${channelId}-${rootThreadTs}`.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function normalizeStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeFiniteNumber(value: unknown): number | undefined {
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
