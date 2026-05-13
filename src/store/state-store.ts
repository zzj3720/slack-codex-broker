import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import type {
  PersistedAdminAuditEvent,
  PersistedAdminEvent,
  PersistedAdminOperation,
  PersistedAgentTraceEvent,
  JsonLike,
  PersistedBackgroundJob,
  PersistedAgentTurnUsage,
  PersistedInboundMessage,
  PersistedInboundMessageStatus,
  PersistedInboundSource,
  PersistedSlackEvent,
  SlackUserIdentity,
  SlackSessionRecord
} from "../types.js";
import { ensureDir } from "../utils/fs.js";

export const STATE_DATABASE_FILENAME = "broker.sqlite";
export const CURRENT_STATE_SCHEMA_VERSION = 13;
export const STATE_STORE_BUSY_TIMEOUT_MS = 5_000;
const ADMIN_EVENT_RETENTION_LIMIT = 20_000;

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
          channel_name TEXT,
          channel_type TEXT,
          root_thread_ts TEXT NOT NULL,
          workspace_path TEXT NOT NULL,
          initiator_user_id TEXT,
          initiator_message_ts TEXT,
          initiator_captured_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          agent_session_id TEXT,
          active_turn_id TEXT,
          active_turn_started_at TEXT,
          last_observed_message_ts TEXT,
          last_delivered_message_ts TEXT,
          last_slack_reply_at TEXT,
          session_page_link_posted_at TEXT,
          auth_profile_name TEXT,
          auth_profile_bound_at TEXT,
          auth_blocked_at TEXT,
          auth_block_reason TEXT,
          auth_blocked_notice_posted_at TEXT,
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
          mentioned_users TEXT,
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
  },
  {
    version: 2,
    name: "admin_operations",
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS admin_operations (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          request TEXT NOT NULL,
          result TEXT,
          error TEXT,
          actor TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT
        );

        CREATE TABLE IF NOT EXISTS admin_audit_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          operation_id TEXT REFERENCES admin_operations(id) ON DELETE SET NULL,
          action TEXT NOT NULL,
          status TEXT NOT NULL,
          detail TEXT,
          actor TEXT,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_admin_operations_updated ON admin_operations(updated_at);
        CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_events(sequence);
        CREATE INDEX IF NOT EXISTS idx_admin_audit_operation ON admin_audit_events(operation_id, sequence);
      `);
    }
  },
  {
    version: 3,
    name: "agent_turn_usage",
    up(database) {
      createAgentTurnUsageSchema(database);
    }
  },
  {
    version: 4,
    name: "agent_trace_events",
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS agent_trace_events (
          id TEXT PRIMARY KEY,
          session_key TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
          source TEXT NOT NULL,
          type TEXT NOT NULL,
          at TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          detail TEXT,
          status TEXT,
          role TEXT,
          tool_name TEXT,
          call_id TEXT,
          turn_id TEXT,
          detail_truncated INTEGER NOT NULL DEFAULT 0,
          detail_original_chars INTEGER,
          metadata TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_agent_trace_events_session_sequence ON agent_trace_events(session_key, sequence);
        CREATE INDEX IF NOT EXISTS idx_agent_trace_events_session_at ON agent_trace_events(session_key, at);
        CREATE INDEX IF NOT EXISTS idx_agent_trace_events_turn ON agent_trace_events(session_key, turn_id);
      `);
    }
  },
  {
    version: 5,
    name: "agent_schema_repair",
    up(database) {
      createAgentTurnUsageSchema(database);

      if (!tableExists(database, "codex_turn_usage")) {
        return;
      }

      const columns = tableColumns(database, "codex_turn_usage");
      const agentSessionColumn = columns.has("codex_thread_id")
        ? "codex_thread_id"
        : (columns.has("agent_session_id") ? "agent_session_id" : "NULL");
      database.exec(`
        INSERT OR IGNORE INTO agent_turn_usage (
          turn_id, session_key, channel_id, root_thread_ts, agent_session_id,
          status, source, model, effort,
          input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, total_tokens,
          raw_usage, started_at, completed_at, created_at, updated_at
        )
        SELECT
          turn_id, session_key, channel_id, root_thread_ts, ${agentSessionColumn},
          status, source, model, effort,
          input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, total_tokens,
          raw_usage, started_at, completed_at, created_at, updated_at
        FROM codex_turn_usage;

        DROP TABLE codex_turn_usage;
      `);
    }
  },
  {
    version: 6,
    name: "session_agent_schema_repair",
    up(database) {
      repairSessionAgentSchema(database);
    }
  },
  {
    version: 7,
    name: "session_channel_metadata",
    up(database) {
      repairSessionChannelMetadataSchema(database);
    }
  },
  {
    version: 8,
    name: "inbound_mentioned_users",
    up(database) {
      repairInboundMentionedUsersSchema(database);
    }
  },
  {
    version: 9,
    name: "admin_realtime_events",
    up(database) {
      createAdminEventsSchema(database);
    }
  },
  {
    version: 10,
    name: "session_page_link_announcement",
    up(database) {
      repairSessionPageLinkAnnouncementSchema(database);
    }
  },
  {
    version: 11,
    name: "session_auth_profile_binding",
    up(database) {
      repairSessionAuthProfileSchema(database);
    }
  },
  {
    version: 12,
    name: "agent_activity_bindings",
    up(database) {
      createAgentActivityBindingSchema(database);
    }
  },
  {
    version: 13,
    name: "session_initiator",
    up(database) {
      repairSessionInitiatorSchema(database);
    }
  }
];

function createAgentActivityBindingSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_session_bindings (
      agent_session_id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
      channel_id TEXT NOT NULL,
      root_thread_ts TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_turn_bindings (
      turn_id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
      channel_id TEXT NOT NULL,
      root_thread_ts TEXT NOT NULL,
      agent_session_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_session_bindings_session ON agent_session_bindings(session_key);
    CREATE INDEX IF NOT EXISTS idx_agent_turn_bindings_session ON agent_turn_bindings(session_key);
    CREATE INDEX IF NOT EXISTS idx_agent_turn_bindings_agent_session ON agent_turn_bindings(agent_session_id);

    INSERT OR IGNORE INTO agent_session_bindings (
      agent_session_id, session_key, channel_id, root_thread_ts, created_at, updated_at
    )
    SELECT
      agent_session_id, key, channel_id, root_thread_ts, updated_at, updated_at
    FROM sessions
    WHERE agent_session_id IS NOT NULL;

    INSERT OR IGNORE INTO agent_turn_bindings (
      turn_id, session_key, channel_id, root_thread_ts, agent_session_id, created_at, updated_at
    )
    SELECT
      active_turn_id, key, channel_id, root_thread_ts, agent_session_id, updated_at, updated_at
    FROM sessions
    WHERE active_turn_id IS NOT NULL;
  `);
}

function createAdminEventsSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS admin_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      scope TEXT NOT NULL,
      session_key TEXT,
      entity_id TEXT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_admin_events_sequence ON admin_events(sequence);
    CREATE INDEX IF NOT EXISTS idx_admin_events_session_sequence ON admin_events(session_key, sequence);
  `);
}

function repairInboundMentionedUsersSchema(database: DatabaseSync): void {
  if (!tableExists(database, "inbound_messages")) {
    return;
  }

  const columns = tableColumns(database, "inbound_messages");
  if (!columns.has("mentioned_users")) {
    database.exec("ALTER TABLE inbound_messages ADD COLUMN mentioned_users TEXT");
  }
}

function repairSessionChannelMetadataSchema(database: DatabaseSync): void {
  if (!tableExists(database, "sessions")) {
    return;
  }

  const columns = tableColumns(database, "sessions");
  if (!columns.has("channel_name")) {
    database.exec("ALTER TABLE sessions ADD COLUMN channel_name TEXT");
  }
  if (!columns.has("channel_type")) {
    database.exec("ALTER TABLE sessions ADD COLUMN channel_type TEXT");
  }
}

function repairSessionPageLinkAnnouncementSchema(database: DatabaseSync): void {
  if (!tableExists(database, "sessions")) {
    return;
  }

  const columns = tableColumns(database, "sessions");
  if (!columns.has("session_page_link_posted_at")) {
    database.exec("ALTER TABLE sessions ADD COLUMN session_page_link_posted_at TEXT");
  }
}

function repairSessionInitiatorSchema(database: DatabaseSync): void {
  if (!tableExists(database, "sessions")) {
    return;
  }

  const columns = tableColumns(database, "sessions");
  if (!columns.has("initiator_user_id")) {
    database.exec("ALTER TABLE sessions ADD COLUMN initiator_user_id TEXT");
  }
  if (!columns.has("initiator_message_ts")) {
    database.exec("ALTER TABLE sessions ADD COLUMN initiator_message_ts TEXT");
  }
  if (!columns.has("initiator_captured_at")) {
    database.exec("ALTER TABLE sessions ADD COLUMN initiator_captured_at TEXT");
  }
}

function repairSessionAuthProfileSchema(database: DatabaseSync): void {
  if (!tableExists(database, "sessions")) {
    return;
  }

  const columns = tableColumns(database, "sessions");
  if (!columns.has("auth_profile_name")) {
    database.exec("ALTER TABLE sessions ADD COLUMN auth_profile_name TEXT");
  }
  if (!columns.has("auth_profile_bound_at")) {
    database.exec("ALTER TABLE sessions ADD COLUMN auth_profile_bound_at TEXT");
  }
  if (!columns.has("auth_blocked_at")) {
    database.exec("ALTER TABLE sessions ADD COLUMN auth_blocked_at TEXT");
  }
  if (!columns.has("auth_block_reason")) {
    database.exec("ALTER TABLE sessions ADD COLUMN auth_block_reason TEXT");
  }
  if (!columns.has("auth_blocked_notice_posted_at")) {
    database.exec("ALTER TABLE sessions ADD COLUMN auth_blocked_notice_posted_at TEXT");
  }
}

function repairSessionAgentSchema(database: DatabaseSync): void {
  if (!tableExists(database, "sessions")) {
    return;
  }

  const columns = tableColumns(database, "sessions");
  if (!columns.has("agent_session_id")) {
    database.exec("ALTER TABLE sessions ADD COLUMN agent_session_id TEXT");
  }

  if (columns.has("codex_thread_id")) {
    database.exec(`
      UPDATE sessions
      SET agent_session_id = COALESCE(agent_session_id, codex_thread_id)
      WHERE codex_thread_id IS NOT NULL
    `);
  }
}

function createAgentTurnUsageSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_turn_usage (
      turn_id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
      channel_id TEXT NOT NULL,
      root_thread_ts TEXT NOT NULL,
      agent_session_id TEXT,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      model TEXT,
      effort TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      raw_usage TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_turn_usage_session ON agent_turn_usage(session_key, completed_at);
    CREATE INDEX IF NOT EXISTS idx_agent_turn_usage_completed ON agent_turn_usage(completed_at);
    CREATE INDEX IF NOT EXISTS idx_agent_turn_usage_total ON agent_turn_usage(total_tokens);
  `);
}

function tableExists(database: DatabaseSync, tableName: string): boolean {
  return Boolean(database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName));
}

function tableColumns(database: DatabaseSync, tableName: string): Set<string> {
  return new Set(
    (database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>)
      .map((row) => row.name)
  );
}

export class StateStore {
  readonly #stateDir: string;
  readonly #sessionsRoot: string;
  #database: DatabaseSync | undefined;
  #loaded = false;

  constructor(stateDir: string, sessionsRoot: string) {
    this.#stateDir = stateDir;
    this.#sessionsRoot = sessionsRoot;
  }

  async load(): Promise<void> {
    await ensureDir(this.#stateDir);
    if (this.#loaded) {
      return;
    }
    this.#openDatabase();
    this.#migrate();
    this.#loaded = true;
  }

  close(): void {
    this.#database?.close();
    this.#database = undefined;
    this.#loaded = false;
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
      this.#appendAdminEvent({
        kind: "session.upsert",
        scope: "session",
        sessionKey: normalized.key,
        entityId: normalized.key,
        payload: normalized,
        createdAt: normalized.updatedAt
      });
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
      this.#appendAdminEvent({
        kind: "session.delete",
        scope: "session",
        sessionKey: key,
        entityId: key,
        payload: { key },
        createdAt: new Date().toISOString()
      });
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
      this.#appendAdminEvent({
        kind: "session.upsert",
        scope: "session",
        sessionKey: updated.key,
        entityId: updated.key,
        payload: updated,
        createdAt: updated.updatedAt
      });
      return updated;
    });
  }

  async bindAgentSession(record: {
    readonly sessionKey: string;
    readonly channelId: string;
    readonly rootThreadTs: string;
    readonly agentSessionId: string;
    readonly at?: string | undefined;
  }): Promise<void> {
    const agentSessionId = record.agentSessionId.trim();
    if (!agentSessionId) {
      return;
    }
    const now = record.at ?? new Date().toISOString();
    this.#transaction(() => {
      this.#upsertAgentSessionBinding({
        sessionKey: record.sessionKey,
        channelId: record.channelId,
        rootThreadTs: record.rootThreadTs,
        agentSessionId,
        createdAt: now,
        updatedAt: now
      });
    });
  }

  async bindAgentTurn(record: {
    readonly sessionKey: string;
    readonly channelId: string;
    readonly rootThreadTs: string;
    readonly turnId: string;
    readonly agentSessionId?: string | undefined;
    readonly at?: string | undefined;
  }): Promise<void> {
    const turnId = record.turnId.trim();
    if (!turnId) {
      return;
    }
    const agentSessionId = record.agentSessionId?.trim() || undefined;
    const now = record.at ?? new Date().toISOString();
    this.#transaction(() => {
      this.#upsertAgentTurnBinding({
        sessionKey: record.sessionKey,
        channelId: record.channelId,
        rootThreadTs: record.rootThreadTs,
        agentSessionId,
        turnId,
        createdAt: now,
        updatedAt: now
      });
    });
  }

  getSessionKeyForAgentActivity(options: {
    readonly agentSessionId?: string | undefined;
    readonly turnId?: string | undefined;
  }): string | undefined {
    const turnId = options.turnId?.trim();
    if (turnId) {
      const row = this.#databaseRequired()
        .prepare("SELECT session_key FROM agent_turn_bindings WHERE turn_id = ?")
        .get(turnId) as SqlRow | undefined;
      const sessionKey = optionalStringColumn(row ?? {}, "session_key");
      if (sessionKey) {
        return sessionKey;
      }
    }

    const agentSessionId = options.agentSessionId?.trim();
    if (agentSessionId) {
      const row = this.#databaseRequired()
        .prepare("SELECT session_key FROM agent_session_bindings WHERE agent_session_id = ?")
        .get(agentSessionId) as SqlRow | undefined;
      return optionalStringColumn(row ?? {}, "session_key");
    }

    return undefined;
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
      this.#appendAdminEvent({
        kind: "inbound.upsert",
        scope: "session",
        sessionKey: normalized.sessionKey,
        entityId: normalized.key,
        payload: normalized,
        createdAt: normalized.updatedAt
      });
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
      this.#appendAdminEvent({
        kind: "inbound.upsert",
        scope: "session",
        sessionKey: updated.sessionKey,
        entityId: updated.key,
        payload: updated,
        createdAt: updated.updatedAt
      });
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
        this.#appendAdminEvent({
          kind: "inbound.upsert",
          scope: "session",
          sessionKey: nextMessage.sessionKey,
          entityId: nextMessage.key,
          payload: nextMessage,
          createdAt: nextMessage.updatedAt
        });
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
      this.#appendAdminEvent({
        kind: "job.upsert",
        scope: "session",
        sessionKey: normalized.sessionKey,
        entityId: normalized.id,
        payload: normalized,
        createdAt: normalized.updatedAt
      });
    });
  }

  listAdminOperations(limit = 50): PersistedAdminOperation[] {
    return this.#databaseRequired()
      .prepare(`
        SELECT * FROM admin_operations
        ORDER BY updated_at DESC, created_at DESC
        LIMIT ?
      `)
      .all(limit)
      .map((row) => this.#rowToAdminOperation(row as SqlRow));
  }

  getAdminOperation(id: string): PersistedAdminOperation | undefined {
    const row = this.#databaseRequired()
      .prepare("SELECT * FROM admin_operations WHERE id = ?")
      .get(id) as SqlRow | undefined;
    return row ? this.#rowToAdminOperation(row) : undefined;
  }

  async upsertAdminOperation(record: PersistedAdminOperation): Promise<void> {
    const normalized = this.#normalizeAdminOperation(record);
    this.#transaction(() => {
      this.#upsertAdminOperation(normalized);
      this.#appendAdminEvent({
        kind: "operation.upsert",
        scope: "global",
        entityId: normalized.id,
        payload: normalized,
        createdAt: normalized.updatedAt
      });
    });
  }

  listAdminAuditEvents(options?: {
    readonly operationId?: string | undefined;
    readonly limit?: number | undefined;
  }): PersistedAdminAuditEvent[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (options?.operationId) {
      where.push("operation_id = ?");
      params.push(options.operationId);
    }
    params.push(options?.limit ?? 50);

    const sql = [
      "SELECT * FROM admin_audit_events",
      where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
      "ORDER BY sequence DESC",
      "LIMIT ?"
    ].filter(Boolean).join(" ");

    return this.#databaseRequired()
      .prepare(sql)
      .all(...params)
      .map((row) => this.#rowToAdminAuditEvent(row as SqlRow));
  }

  async appendAdminAuditEvent(record: PersistedAdminAuditEvent): Promise<void> {
    const normalized = this.#normalizeAdminAuditEvent(record);
    this.#transaction(() => {
      this.#databaseRequired().prepare(`
        INSERT INTO admin_audit_events (
          id, operation_id, action, status, detail, actor, created_at
        ) VALUES (${placeholders(7)})
      `).run(
        normalized.id,
        normalized.operationId ?? null,
        normalized.action,
        normalized.status,
        jsonOrNull(normalized.detail),
        normalized.actor ?? null,
        normalized.createdAt
      );
      this.#appendAdminEvent({
        kind: "audit.append",
        scope: "global",
        entityId: normalized.id,
        payload: normalized,
        createdAt: normalized.createdAt
      });
    });
  }

  listAgentTurnUsage(limit = 1000): PersistedAgentTurnUsage[] {
    return this.#databaseRequired()
      .prepare(`
        SELECT * FROM agent_turn_usage
        ORDER BY COALESCE(completed_at, updated_at, created_at) DESC, updated_at DESC
        LIMIT ?
      `)
      .all(limit)
      .map((row) => this.#rowToAgentTurnUsage(row as SqlRow));
  }

  async upsertAgentTurnUsage(record: PersistedAgentTurnUsage): Promise<void> {
    const normalized = this.#normalizeAgentTurnUsage(record);
    this.#transaction(() => {
      this.#upsertAgentTurnUsage(normalized);
      this.#appendAdminEvent({
        kind: "usage.update",
        scope: "session",
        sessionKey: normalized.sessionKey,
        entityId: normalized.turnId,
        payload: normalized,
        createdAt: normalized.updatedAt
      });
    });
  }

  listAgentTraceEvents(sessionKey: string, limit = 1000): PersistedAgentTraceEvent[] {
    return this.#databaseRequired()
      .prepare(`
        SELECT * FROM agent_trace_events
        WHERE session_key = ?
        ORDER BY sequence ASC, at ASC, id ASC
        LIMIT ?
      `)
      .all(sessionKey, limit)
      .map((row) => this.#rowToAgentTraceEvent(row as SqlRow));
  }

  async upsertAgentTraceEvent(record: PersistedAgentTraceEvent): Promise<void> {
    const normalized = this.#normalizeAgentTraceEvent(record);
    this.#transaction(() => {
      this.#upsertAgentTraceEvent(normalized);
      this.#appendAdminEvent({
        kind: "trace.append",
        scope: "session",
        sessionKey: normalized.sessionKey,
        entityId: normalized.id,
        payload: normalized,
        createdAt: normalized.updatedAt
      });
    });
  }

  listAdminEvents(options?: {
    readonly afterSequence?: number | undefined;
    readonly sessionKey?: string | undefined;
    readonly limit?: number | undefined;
  }): PersistedAdminEvent[] {
    const afterSequence = Number(options?.afterSequence ?? 0);
    const limit = Number(options?.limit ?? 100);
    const where: string[] = ["sequence > ?"];
    const params: SqlValue[] = [Number.isFinite(afterSequence) ? Math.max(0, Math.floor(afterSequence)) : 0];
    if (options?.sessionKey) {
      where.push("session_key = ?");
      params.push(options.sessionKey);
    }
    params.push(Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.floor(limit))) : 100);

    return this.#databaseRequired()
      .prepare(`
        SELECT * FROM admin_events
        WHERE ${where.join(" AND ")}
        ORDER BY sequence ASC
        LIMIT ?
      `)
      .all(...params)
      .map((row) => this.#rowToAdminEvent(row as SqlRow));
  }

  getLatestAdminEventSequence(): number {
    const row = this.#databaseRequired()
      .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM admin_events")
      .get() as { sequence?: number | bigint | null } | undefined;
    return Number(row?.sequence ?? 0);
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
      PRAGMA busy_timeout = ${STATE_STORE_BUSY_TIMEOUT_MS};
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
        key, channel_id, channel_name, channel_type, root_thread_ts, workspace_path, created_at, updated_at,
        initiator_user_id, initiator_message_ts, initiator_captured_at,
        agent_session_id, active_turn_id, active_turn_started_at,
        last_observed_message_ts, last_delivered_message_ts, last_slack_reply_at, session_page_link_posted_at,
        auth_profile_name, auth_profile_bound_at, auth_blocked_at, auth_block_reason, auth_blocked_notice_posted_at,
        last_turn_signal_turn_id, last_turn_signal_kind, last_turn_signal_reason, last_turn_signal_at,
        co_author_candidate_user_ids, co_author_candidate_revision,
        co_author_confirmed_user_ids, co_author_confirmed_revision,
        co_author_ignore_missing_revision, co_author_prompt_revision, co_author_prompted_at
      ) VALUES (${placeholders(34)})
      ON CONFLICT(key) DO UPDATE SET
        channel_id = excluded.channel_id,
        channel_name = excluded.channel_name,
        channel_type = excluded.channel_type,
        root_thread_ts = excluded.root_thread_ts,
        workspace_path = excluded.workspace_path,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        initiator_user_id = excluded.initiator_user_id,
        initiator_message_ts = excluded.initiator_message_ts,
        initiator_captured_at = excluded.initiator_captured_at,
        agent_session_id = excluded.agent_session_id,
        active_turn_id = excluded.active_turn_id,
        active_turn_started_at = excluded.active_turn_started_at,
        last_observed_message_ts = excluded.last_observed_message_ts,
        last_delivered_message_ts = excluded.last_delivered_message_ts,
        last_slack_reply_at = excluded.last_slack_reply_at,
        session_page_link_posted_at = excluded.session_page_link_posted_at,
        auth_profile_name = excluded.auth_profile_name,
        auth_profile_bound_at = excluded.auth_profile_bound_at,
        auth_blocked_at = excluded.auth_blocked_at,
        auth_block_reason = excluded.auth_block_reason,
        auth_blocked_notice_posted_at = excluded.auth_blocked_notice_posted_at,
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
      record.channelName ?? null,
      record.channelType ?? null,
      record.rootThreadTs,
      record.workspacePath,
      record.createdAt,
      record.updatedAt,
      record.initiatorUserId ?? null,
      record.initiatorMessageTs ?? null,
      record.initiatorCapturedAt ?? null,
      record.agentSessionId ?? null,
      record.activeTurnId ?? null,
      record.activeTurnStartedAt ?? null,
      record.lastObservedMessageTs ?? null,
      record.lastDeliveredMessageTs ?? null,
      record.lastSlackReplyAt ?? null,
      record.sessionPageLinkPostedAt ?? null,
      record.authProfileName ?? null,
      record.authProfileBoundAt ?? null,
      record.authBlockedAt ?? null,
      record.authBlockReason ?? null,
      record.authBlockedNoticePostedAt ?? null,
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
    this.#bindAgentActivityFromSession(record);
  }

  #bindAgentActivityFromSession(record: SlackSessionRecord): void {
    if (record.agentSessionId) {
      this.#upsertAgentSessionBinding({
        sessionKey: record.key,
        channelId: record.channelId,
        rootThreadTs: record.rootThreadTs,
        agentSessionId: record.agentSessionId,
        createdAt: record.updatedAt,
        updatedAt: record.updatedAt
      });
    }
    if (record.activeTurnId) {
      this.#upsertAgentTurnBinding({
        sessionKey: record.key,
        channelId: record.channelId,
        rootThreadTs: record.rootThreadTs,
        agentSessionId: record.agentSessionId,
        turnId: record.activeTurnId,
        createdAt: record.updatedAt,
        updatedAt: record.updatedAt
      });
    }
  }

  #upsertAgentSessionBinding(record: {
    readonly sessionKey: string;
    readonly channelId: string;
    readonly rootThreadTs: string;
    readonly agentSessionId: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  }): void {
    this.#databaseRequired().prepare(`
      INSERT INTO agent_session_bindings (
        agent_session_id, session_key, channel_id, root_thread_ts, created_at, updated_at
      ) VALUES (${placeholders(6)})
      ON CONFLICT(agent_session_id) DO UPDATE SET
        session_key = excluded.session_key,
        channel_id = excluded.channel_id,
        root_thread_ts = excluded.root_thread_ts,
        updated_at = excluded.updated_at
    `).run(
      record.agentSessionId,
      record.sessionKey,
      record.channelId,
      record.rootThreadTs,
      record.createdAt,
      record.updatedAt
    );
  }

  #upsertAgentTurnBinding(record: {
    readonly sessionKey: string;
    readonly channelId: string;
    readonly rootThreadTs: string;
    readonly agentSessionId?: string | undefined;
    readonly turnId: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  }): void {
    this.#databaseRequired().prepare(`
      INSERT INTO agent_turn_bindings (
        turn_id, session_key, channel_id, root_thread_ts, agent_session_id, created_at, updated_at
      ) VALUES (${placeholders(7)})
      ON CONFLICT(turn_id) DO UPDATE SET
        session_key = excluded.session_key,
        channel_id = excluded.channel_id,
        root_thread_ts = excluded.root_thread_ts,
        agent_session_id = excluded.agent_session_id,
        updated_at = excluded.updated_at
    `).run(
      record.turnId,
      record.sessionKey,
      record.channelId,
      record.rootThreadTs,
      record.agentSessionId ?? null,
      record.createdAt,
      record.updatedAt
    );
  }

  #upsertInboundMessage(record: PersistedInboundMessage): void {
    this.#databaseRequired().prepare(`
      INSERT INTO inbound_messages (
        key, session_key, channel_id, channel_type, root_thread_ts, message_ts,
        source, user_id, text, sender_kind, bot_id, app_id, sender_username,
        mentioned_user_ids, mentioned_users, context_text, images, slack_message, background_job,
        unexpected_turn_stop, status, batch_id, created_at, updated_at
      ) VALUES (${placeholders(24)})
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
        mentioned_users = excluded.mentioned_users,
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
      jsonOrNull(record.mentionedUsers ?? []),
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

  #upsertAdminOperation(record: PersistedAdminOperation): void {
    this.#databaseRequired().prepare(`
      INSERT INTO admin_operations (
        id, kind, status, request, result, error, actor,
        created_at, updated_at, started_at, completed_at
      ) VALUES (${placeholders(11)})
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        status = excluded.status,
        request = excluded.request,
        result = excluded.result,
        error = excluded.error,
        actor = excluded.actor,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at
    `).run(
      record.id,
      record.kind,
      record.status,
      JSON.stringify(record.request),
      jsonOrNull(record.result),
      record.error ?? null,
      record.actor ?? null,
      record.createdAt,
      record.updatedAt,
      record.startedAt ?? null,
      record.completedAt ?? null
    );
  }

  #upsertAgentTurnUsage(record: PersistedAgentTurnUsage): void {
    this.#databaseRequired().prepare(`
      INSERT INTO agent_turn_usage (
        turn_id, session_key, channel_id, root_thread_ts, agent_session_id,
        status, source, model, effort, input_tokens, cached_input_tokens,
        output_tokens, reasoning_tokens, total_tokens, raw_usage,
        started_at, completed_at, created_at, updated_at
      ) VALUES (${placeholders(19)})
      ON CONFLICT(turn_id) DO UPDATE SET
        session_key = excluded.session_key,
        channel_id = excluded.channel_id,
        root_thread_ts = excluded.root_thread_ts,
        agent_session_id = excluded.agent_session_id,
        status = excluded.status,
        source = excluded.source,
        model = excluded.model,
        effort = excluded.effort,
        input_tokens = excluded.input_tokens,
        cached_input_tokens = excluded.cached_input_tokens,
        output_tokens = excluded.output_tokens,
        reasoning_tokens = excluded.reasoning_tokens,
        total_tokens = excluded.total_tokens,
        raw_usage = excluded.raw_usage,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `).run(
      record.turnId,
      record.sessionKey,
      record.channelId,
      record.rootThreadTs,
      record.agentSessionId ?? null,
      record.status,
      record.source,
      record.model ?? null,
      record.effort ?? null,
      record.inputTokens,
      record.cachedInputTokens,
      record.outputTokens,
      record.reasoningTokens,
      record.totalTokens,
      jsonOrNull(record.rawUsage),
      record.startedAt ?? null,
      record.completedAt ?? null,
      record.createdAt,
      record.updatedAt
    );
  }

  #upsertAgentTraceEvent(record: PersistedAgentTraceEvent): void {
    this.#databaseRequired().prepare(`
      INSERT INTO agent_trace_events (
        id, session_key, source, type, at, sequence, title, summary, detail,
        status, role, tool_name, call_id, turn_id, detail_truncated,
        detail_original_chars, metadata, created_at, updated_at
      ) VALUES (${placeholders(19)})
      ON CONFLICT(id) DO UPDATE SET
        session_key = excluded.session_key,
        source = excluded.source,
        type = excluded.type,
        at = excluded.at,
        sequence = excluded.sequence,
        title = excluded.title,
        summary = excluded.summary,
        detail = excluded.detail,
        status = excluded.status,
        role = excluded.role,
        tool_name = excluded.tool_name,
        call_id = excluded.call_id,
        turn_id = excluded.turn_id,
        detail_truncated = excluded.detail_truncated,
        detail_original_chars = excluded.detail_original_chars,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
    `).run(
      record.id,
      record.sessionKey,
      record.source,
      record.type,
      record.at,
      record.sequence,
      record.title,
      record.summary,
      record.detail ?? null,
      record.status ?? null,
      record.role ?? null,
      record.toolName ?? null,
      record.callId ?? null,
      record.turnId ?? null,
      record.detailTruncated ? 1 : 0,
      record.detailOriginalChars ?? null,
      jsonOrNull(record.metadata),
      record.createdAt,
      record.updatedAt
    );
  }

  #appendAdminEvent(event: Omit<PersistedAdminEvent, "sequence" | "payload"> & {
    readonly payload: unknown;
  }): void {
    this.#databaseRequired().prepare(`
      INSERT INTO admin_events (
        kind, scope, session_key, entity_id, payload, created_at
      ) VALUES (${placeholders(6)})
    `).run(
      event.kind,
      event.scope,
      event.sessionKey ?? null,
      event.entityId ?? null,
      JSON.stringify(event.payload),
      event.createdAt
    );
    this.#databaseRequired().prepare(`
      DELETE FROM admin_events
      WHERE sequence NOT IN (
        SELECT sequence FROM admin_events ORDER BY sequence DESC LIMIT ?
      )
    `).run(ADMIN_EVENT_RETENTION_LIMIT);
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
      channelName: optionalStringColumn(row, "channel_name"),
      channelType: optionalStringColumn(row, "channel_type"),
      rootThreadTs: stringColumn(row, "root_thread_ts"),
      workspacePath: stringColumn(row, "workspace_path"),
      initiatorUserId: optionalStringColumn(row, "initiator_user_id"),
      initiatorMessageTs: optionalStringColumn(row, "initiator_message_ts"),
      initiatorCapturedAt: optionalStringColumn(row, "initiator_captured_at"),
      createdAt: stringColumn(row, "created_at"),
      updatedAt: stringColumn(row, "updated_at"),
      agentSessionId: optionalStringColumn(row, "agent_session_id"),
      activeTurnId: optionalStringColumn(row, "active_turn_id"),
      activeTurnStartedAt: optionalStringColumn(row, "active_turn_started_at"),
      lastObservedMessageTs: optionalStringColumn(row, "last_observed_message_ts"),
      lastDeliveredMessageTs: optionalStringColumn(row, "last_delivered_message_ts"),
      lastSlackReplyAt: optionalStringColumn(row, "last_slack_reply_at"),
      sessionPageLinkPostedAt: optionalStringColumn(row, "session_page_link_posted_at"),
      authProfileName: optionalStringColumn(row, "auth_profile_name"),
      authProfileBoundAt: optionalStringColumn(row, "auth_profile_bound_at"),
      authBlockedAt: optionalStringColumn(row, "auth_blocked_at"),
      authBlockReason: optionalStringColumn(row, "auth_block_reason"),
      authBlockedNoticePostedAt: optionalStringColumn(row, "auth_blocked_notice_posted_at"),
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
      mentionedUsers: readJsonColumn<readonly SlackUserIdentity[]>(row, "mentioned_users", []),
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

  #rowToAdminOperation(row: SqlRow): PersistedAdminOperation {
    return this.#normalizeAdminOperation({
      id: stringColumn(row, "id"),
      kind: stringColumn(row, "kind") as PersistedAdminOperation["kind"],
      status: stringColumn(row, "status") as PersistedAdminOperation["status"],
      request: readJsonColumn<JsonLike>(row, "request", null),
      result: readJsonColumn<JsonLike | undefined>(row, "result", undefined),
      error: optionalStringColumn(row, "error"),
      actor: optionalStringColumn(row, "actor"),
      createdAt: stringColumn(row, "created_at"),
      updatedAt: stringColumn(row, "updated_at"),
      startedAt: optionalStringColumn(row, "started_at"),
      completedAt: optionalStringColumn(row, "completed_at")
    });
  }

  #rowToAdminAuditEvent(row: SqlRow): PersistedAdminAuditEvent {
    return this.#normalizeAdminAuditEvent({
      id: stringColumn(row, "id"),
      operationId: optionalStringColumn(row, "operation_id"),
      action: stringColumn(row, "action"),
      status: stringColumn(row, "status") as PersistedAdminAuditEvent["status"],
      detail: readJsonColumn<JsonLike | undefined>(row, "detail", undefined),
      actor: optionalStringColumn(row, "actor"),
      createdAt: stringColumn(row, "created_at")
    });
  }

  #rowToAdminEvent(row: SqlRow): PersistedAdminEvent {
    return {
      sequence: Number(row.sequence),
      kind: stringColumn(row, "kind"),
      scope: stringColumn(row, "scope") === "session" ? "session" : "global",
      sessionKey: optionalStringColumn(row, "session_key"),
      entityId: optionalStringColumn(row, "entity_id"),
      payload: readJsonColumn<JsonLike>(row, "payload", {}),
      createdAt: stringColumn(row, "created_at")
    };
  }

  #rowToAgentTurnUsage(row: SqlRow): PersistedAgentTurnUsage {
    return this.#normalizeAgentTurnUsage({
      turnId: stringColumn(row, "turn_id"),
      sessionKey: stringColumn(row, "session_key"),
      channelId: stringColumn(row, "channel_id"),
      rootThreadTs: stringColumn(row, "root_thread_ts"),
      agentSessionId: optionalStringColumn(row, "agent_session_id"),
      status: stringColumn(row, "status") as PersistedAgentTurnUsage["status"],
      source: stringColumn(row, "source") as PersistedAgentTurnUsage["source"],
      model: optionalStringColumn(row, "model"),
      effort: optionalStringColumn(row, "effort"),
      inputTokens: optionalNumberColumn(row, "input_tokens") ?? 0,
      cachedInputTokens: optionalNumberColumn(row, "cached_input_tokens") ?? 0,
      outputTokens: optionalNumberColumn(row, "output_tokens") ?? 0,
      reasoningTokens: optionalNumberColumn(row, "reasoning_tokens") ?? 0,
      totalTokens: optionalNumberColumn(row, "total_tokens") ?? 0,
      rawUsage: readJsonColumn<JsonLike | undefined>(row, "raw_usage", undefined),
      startedAt: optionalStringColumn(row, "started_at"),
      completedAt: optionalStringColumn(row, "completed_at"),
      createdAt: stringColumn(row, "created_at"),
      updatedAt: stringColumn(row, "updated_at")
    });
  }

  #rowToAgentTraceEvent(row: SqlRow): PersistedAgentTraceEvent {
    return this.#normalizeAgentTraceEvent({
      id: stringColumn(row, "id"),
      sessionKey: stringColumn(row, "session_key"),
      source: stringColumn(row, "source") as PersistedAgentTraceEvent["source"],
      type: stringColumn(row, "type"),
      at: stringColumn(row, "at"),
      sequence: optionalNumberColumn(row, "sequence") ?? 0,
      title: stringColumn(row, "title"),
      summary: stringColumn(row, "summary"),
      detail: optionalStringColumn(row, "detail"),
      status: optionalStringColumn(row, "status"),
      role: optionalStringColumn(row, "role"),
      toolName: optionalStringColumn(row, "tool_name"),
      callId: optionalStringColumn(row, "call_id"),
      turnId: optionalStringColumn(row, "turn_id"),
      detailTruncated: booleanColumn(row, "detail_truncated", false),
      detailOriginalChars: optionalNumberColumn(row, "detail_original_chars"),
      metadata: readJsonColumn<JsonLike | undefined>(row, "metadata", undefined),
      createdAt: stringColumn(row, "created_at"),
      updatedAt: stringColumn(row, "updated_at")
    });
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
      channelName: optionalNonEmptyString(session.channelName),
      channelType: optionalNonEmptyString(session.channelType),
      rootThreadTs: String(session.rootThreadTs),
      workspacePath,
      initiatorUserId: optionalNonEmptyString(session.initiatorUserId),
      initiatorMessageTs: optionalNonEmptyString(session.initiatorMessageTs),
      initiatorCapturedAt: optionalNonEmptyString(session.initiatorCapturedAt),
      createdAt: String(session.createdAt),
      updatedAt: String(session.updatedAt),
      agentSessionId: session.agentSessionId,
      activeTurnId: session.activeTurnId,
      activeTurnStartedAt: session.activeTurnStartedAt,
      lastObservedMessageTs: session.lastObservedMessageTs,
      lastDeliveredMessageTs: session.lastDeliveredMessageTs,
      lastSlackReplyAt: session.lastSlackReplyAt,
      sessionPageLinkPostedAt: session.sessionPageLinkPostedAt,
      authProfileName: optionalNonEmptyString(session.authProfileName),
      authProfileBoundAt: session.authProfileBoundAt,
      authBlockedAt: session.authBlockedAt,
      authBlockReason: optionalNonEmptyString(session.authBlockReason),
      authBlockedNoticePostedAt: session.authBlockedNoticePostedAt,
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
      mentionedUsers: raw.mentionedUsers ?? [],
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

  #normalizeAdminOperation(raw: Partial<PersistedAdminOperation>): PersistedAdminOperation {
    if (!raw.id || !raw.kind || !raw.status || !raw.createdAt) {
      throw new Error(`Invalid admin operation: ${raw.id ?? "unknown"}`);
    }

    return {
      id: String(raw.id),
      kind: raw.kind,
      status: raw.status,
      request: raw.request ?? null,
      result: raw.result,
      error: raw.error,
      actor: raw.actor,
      createdAt: String(raw.createdAt),
      updatedAt: String(raw.updatedAt ?? raw.createdAt),
      startedAt: raw.startedAt,
      completedAt: raw.completedAt
    };
  }

  #normalizeAdminAuditEvent(raw: Partial<PersistedAdminAuditEvent>): PersistedAdminAuditEvent {
    if (!raw.id || !raw.action || !raw.status || !raw.createdAt) {
      throw new Error(`Invalid admin audit event: ${raw.id ?? "unknown"}`);
    }

    return {
      id: String(raw.id),
      operationId: raw.operationId,
      action: String(raw.action),
      status: raw.status,
      detail: raw.detail,
      actor: raw.actor,
      createdAt: String(raw.createdAt)
    };
  }

  #normalizeAgentTurnUsage(raw: Partial<PersistedAgentTurnUsage>): PersistedAgentTurnUsage {
    if (!raw.turnId || !raw.sessionKey || !raw.channelId || !raw.rootThreadTs || !raw.status || !raw.source) {
      throw new Error(`Invalid Agent turn usage: ${raw.turnId ?? "unknown"}`);
    }

    const now = new Date().toISOString();
    return {
      turnId: String(raw.turnId),
      sessionKey: String(raw.sessionKey),
      channelId: String(raw.channelId),
      rootThreadTs: String(raw.rootThreadTs),
      agentSessionId: typeof raw.agentSessionId === "string" ? raw.agentSessionId : undefined,
      status: raw.status,
      source: raw.source,
      model: typeof raw.model === "string" ? raw.model : undefined,
      effort: typeof raw.effort === "string" ? raw.effort : undefined,
      inputTokens: normalizeTokenCount(raw.inputTokens),
      cachedInputTokens: normalizeTokenCount(raw.cachedInputTokens),
      outputTokens: normalizeTokenCount(raw.outputTokens),
      reasoningTokens: normalizeTokenCount(raw.reasoningTokens),
      totalTokens: normalizeTokenCount(raw.totalTokens),
      rawUsage: raw.rawUsage,
      startedAt: typeof raw.startedAt === "string" ? raw.startedAt : undefined,
      completedAt: typeof raw.completedAt === "string" ? raw.completedAt : undefined,
      createdAt: String(raw.createdAt ?? now),
      updatedAt: String(raw.updatedAt ?? raw.createdAt ?? now)
    };
  }

  #normalizeAgentTraceEvent(raw: Partial<PersistedAgentTraceEvent>): PersistedAgentTraceEvent {
    if (!raw.id || !raw.sessionKey || !raw.source || !raw.type || !raw.at || !raw.title) {
      throw new Error(`Invalid agent trace event: ${raw.id ?? "unknown"}`);
    }

    const now = new Date().toISOString();
    return {
      id: String(raw.id),
      sessionKey: String(raw.sessionKey),
      source: raw.source,
      type: String(raw.type),
      at: String(raw.at),
      sequence: normalizeFiniteNumber(raw.sequence) ?? timestampSequence(raw.at),
      title: String(raw.title),
      summary: String(raw.summary ?? ""),
      detail: typeof raw.detail === "string" ? raw.detail : undefined,
      status: typeof raw.status === "string" ? raw.status : undefined,
      role: typeof raw.role === "string" ? raw.role : undefined,
      toolName: typeof raw.toolName === "string" ? raw.toolName : undefined,
      callId: typeof raw.callId === "string" ? raw.callId : undefined,
      turnId: typeof raw.turnId === "string" ? raw.turnId : undefined,
      detailTruncated: raw.detailTruncated,
      detailOriginalChars: normalizeFiniteNumber(raw.detailOriginalChars),
      metadata: raw.metadata,
      createdAt: String(raw.createdAt ?? now),
      updatedAt: String(raw.updatedAt ?? raw.createdAt ?? now)
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

function optionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
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

function normalizeTokenCount(value: unknown): number {
  const parsed = normalizeFiniteNumber(value) ?? 0;
  return Math.max(0, Math.trunc(parsed));
}

function timestampSequence(value: unknown): number {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}
