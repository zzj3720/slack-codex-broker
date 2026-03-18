import { readFile } from "node:fs/promises";
import path from "node:path";

import type { AppConfig } from "../../config.js";
import { logger } from "../../logger.js";
import { SessionManager } from "../session-manager.js";
import type {
  BackgroundJobEventPayload,
  PersistedInboundMessage,
  ResolvedSlackThreadMessage,
  SlackInputMessage,
  SlackSessionRecord,
  SlackThreadMessage,
  SlackTurnSignalKind
} from "../../types.js";
import { CodexBroker } from "../codex/codex-broker.js";
import {
  SlackApi,
  type SlackUploadedFile
} from "./slack-api.js";
import {
  createSlackInputFromThreadMessage,
  isSlackMessageEffectivelyEmpty,
  parseSlackTextMetadata
} from "./slack-event-parser.js";
import {
  chunkSlackMessage,
  clampHistoryLimit,
  compareIsoTimestamp,
  createSlackFailureFingerprint,
  formatSlackRunFailureMessage,
  isBeforeSlackTs,
  isMissingCodexThreadError,
  isRecoverableCodexTurnFailure,
  parseActiveTurnMismatch,
  isMissingActiveTurnSteerError,
  isSlackMessageAfterCursor,
  isStopExplainingTurnSignalKind,
  isUnexpectedTurnStopMessage,
  shouldNotifySlackFailure,
  shouldAutoRecoverSession
} from "./slack-conversation-utils.js";
import { SlackInboundStore } from "./slack-inbound-store.js";
import {
  formatSlackHistoryContextForCodex
} from "./slack-message-format.js";
import { SlackSelfMessageFilter } from "./slack-self-filter.js";
import { SlackTurnReconciler } from "./slack-turn-reconciler.js";
import { SlackTurnRunner } from "./slack-turn-runner.js";

interface RuntimeSessionState {
  readonly queue: PendingDispatchRequest[];
  processing: boolean;
  generation: number;
  autoResumeTimer?: NodeJS.Timeout | undefined;
  blockedUntilMs?: number | undefined;
  blockedFailureFingerprint?: string | undefined;
  lastFailureNotificationFingerprint?: string | undefined;
  lastFailureNotificationAtMs?: number | undefined;
}

interface PendingDispatchRequest {
  readonly kind: "dispatch_pending";
  readonly recoveryKind?: "socket_ready_missed_messages" | undefined;
}

const AUTO_RESUME_AFTER_FAILURE_MS = 5_000;
const NONRECOVERABLE_DISPATCH_RETRY_COOLDOWN_MS = 5 * 60 * 1_000;

export class SlackConversationService {
  readonly #config: AppConfig;
  readonly #sessions: SessionManager;
  readonly #slackApi: SlackApi;
  readonly #selfMessageFilter: SlackSelfMessageFilter;
  readonly #runtimeSessions = new Map<string, RuntimeSessionState>();
  readonly #inboundStore: SlackInboundStore;
  readonly #turnRunner: SlackTurnRunner;
  readonly #turnReconciler: SlackTurnReconciler;
  #botUserId = "";
  #activeTurnReconcileTimer: NodeJS.Timeout | undefined;
  #catchUpPromise: Promise<void> | undefined;

  constructor(options: {
    readonly config: AppConfig;
    readonly sessions: SessionManager;
    readonly codex: CodexBroker;
    readonly slackApi: SlackApi;
    readonly selfMessageFilter: SlackSelfMessageFilter;
  }) {
    this.#config = options.config;
    this.#sessions = options.sessions;
    this.#slackApi = options.slackApi;
    this.#selfMessageFilter = options.selfMessageFilter;
    this.#inboundStore = new SlackInboundStore({
      sessions: this.#sessions,
      slackApi: this.#slackApi
    });
    this.#turnRunner = new SlackTurnRunner({
      codex: options.codex,
      slackApi: this.#slackApi,
      sessions: this.#sessions,
      inboundStore: this.#inboundStore
    });
    this.#turnReconciler = new SlackTurnReconciler({
      sessions: this.#sessions,
      turnRunner: this.#turnRunner,
      inboundStore: this.#inboundStore
    });
  }

  setBotUserId(botUserId: string): void {
    this.#botUserId = botUserId;
  }

  async start(): Promise<void> {
    await this.#reconcilePersistedActiveTurns();
    await this.#recoverPendingSessionsOnBoot();
    await this.#recoverPendingSyntheticMessages();
    this.#startActiveTurnReconciler();
  }

  async stop(): Promise<void> {
    this.#stopActiveTurnReconciler();
    for (const runtime of this.#runtimeSessions.values()) {
      if (!runtime.autoResumeTimer) {
        continue;
      }
      clearTimeout(runtime.autoResumeTimer);
      runtime.autoResumeTimer = undefined;
    }
  }

  isAlreadyHandled(session: SlackSessionRecord, messageTs?: string | undefined): boolean {
    return this.#inboundStore.isAlreadyHandled(session, messageTs);
  }

  async ensureCodexThread(session: SlackSessionRecord): Promise<SlackSessionRecord> {
    return await this.#turnRunner.ensureCodexThread(session);
  }

  async readThreadHistory(options: {
    readonly channelId: string;
    readonly rootThreadTs: string;
    readonly beforeMessageTs?: string | undefined;
    readonly limit?: number | undefined;
    readonly channelType?: string | undefined;
  }): Promise<{
    readonly messages: ResolvedSlackThreadMessage[];
    readonly formattedText?: string | undefined;
    readonly hasMore: boolean;
  }> {
    const effectiveLimit = clampHistoryLimit(
      options.limit,
      this.#config.slackInitialThreadHistoryCount,
      this.#config.slackHistoryApiMaxLimit
    );

    if (effectiveLimit === 0) {
      return {
        messages: [],
        formattedText: undefined,
        hasMore: false
      };
    }

    const threadMessages = await this.#slackApi.listThreadMessages({
      channelId: options.channelId,
      channelType: options.channelType,
      rootThreadTs: options.rootThreadTs
    });
    const filteredMessages = threadMessages
      .filter((message) => !this.#selfMessageFilter.shouldIgnoreThreadMessage(message))
      .filter((message) => isBeforeSlackTs(message.messageTs, options.beforeMessageTs));
    const boundedMessages = filteredMessages.slice(-effectiveLimit);
    const resolvedMessages = await Promise.all(
      boundedMessages.map(async (message) => {
        const metadata = parseSlackTextMetadata(message.text);
        return {
          ...message,
          text: metadata.text,
          mentionedUserIds: metadata.mentionedUserIds,
          sender: message.senderKind === "user"
            ? await this.#slackApi.getUserIdentity(message.userId)
            : null
        };
      })
    );

    return {
      messages: resolvedMessages,
      formattedText: formatSlackHistoryContextForCodex(resolvedMessages),
      hasMore: filteredMessages.length > boundedMessages.length
    };
  }

  async replayThreadMessage(options: {
    readonly channelId: string;
    readonly rootThreadTs: string;
    readonly messageTs: string;
  }): Promise<SlackInputMessage | null> {
    const session = this.#sessions.getSession(options.channelId, options.rootThreadTs);
    if (!session) {
      return null;
    }

    const threadMessages = await this.#slackApi.listThreadMessages({
      channelId: options.channelId,
      rootThreadTs: options.rootThreadTs
    });
    const message = threadMessages.find((entry) => entry.messageTs === options.messageTs);

    if (!message || this.#selfMessageFilter.shouldIgnoreThreadMessage(message)) {
      return null;
    }

    if (this.isAlreadyHandled(session, message.messageTs)) {
      return null;
    }

    const input = createSlackInputFromThreadMessage("thread_reply", message);
    if (isSlackMessageEffectivelyEmpty(input.text, input.images, input.slackMessage)) {
      return null;
    }

    await this.acceptInboundMessage(session, input);
    return input;
  }

  async resumePendingSession(options: {
    readonly channelId: string;
    readonly rootThreadTs: string;
    readonly forceReset?: boolean | undefined;
  }): Promise<{
    readonly sessionKey: string;
    readonly pendingCount: number;
    readonly resumed: boolean;
  } | null> {
    const session = this.#sessions.getSession(options.channelId, options.rootThreadTs);
    if (!session) {
      return null;
    }

    const pendingCount = await this.#resumePendingDispatch(session.key, {
      forceReset: options.forceReset ?? true
    });

    return {
      sessionKey: session.key,
      pendingCount,
      resumed: pendingCount > 0
    };
  }

  async acceptBackgroundJobEvent(options: {
    readonly channelId: string;
    readonly rootThreadTs: string;
    readonly payload: BackgroundJobEventPayload;
  }): Promise<void> {
    const session = this.#sessions.getSession(options.channelId, options.rootThreadTs);
    if (!session) {
      throw new Error(`Unknown session for background job event: ${options.channelId}:${options.rootThreadTs}`);
    }

    if (
      session.lastTurnSignalKind === "final" &&
      session.lastTurnSignalAt &&
      options.payload.jobId
    ) {
      const job = this.#sessions.getBackgroundJob(options.payload.jobId);
      if (job && compareIsoTimestamp(job.createdAt, session.lastTurnSignalAt) <= 0) {
        logger.info("Ignoring stale background job event after session was finalized", {
          sessionKey: session.key,
          jobId: job.id,
          eventKind: options.payload.eventKind,
          summary: options.payload.summary
        });
        return;
      }
    }

    await this.acceptInboundMessage(session, {
      source: "background_job_event",
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs,
      messageTs: `${Date.now()}.${Math.floor(Math.random() * 1_000_000).toString().padStart(6, "0")}`,
      userId: this.#botUserId || "BACKGROUND_JOB",
      text: options.payload.summary,
      backgroundJob: options.payload
    });
  }

  async acceptUnexpectedTurnStop(options: {
    readonly session: SlackSessionRecord;
    readonly previousTurnId: string;
    readonly reason: string;
  }): Promise<void> {
    await this.acceptInboundMessage(options.session, {
      source: "unexpected_turn_stop",
      channelId: options.session.channelId,
      rootThreadTs: options.session.rootThreadTs,
      messageTs: `${Date.now()}.${Math.floor(Math.random() * 1_000_000).toString().padStart(6, "0")}`,
      userId: this.#botUserId || "BROKER",
      text: options.reason,
      unexpectedTurnStop: {
        turnId: options.previousTurnId,
        reason: options.reason
      }
    });
  }

  async recoverMissedThreadMessages(reason: "socket_ready"): Promise<void> {
    if (this.#catchUpPromise) {
      await this.#catchUpPromise;
      return;
    }

    this.#catchUpPromise = this.#runMissedThreadRecovery(reason)
      .catch((error) => {
        logger.error("Failed to recover missed Slack thread messages", {
          reason,
          error: error instanceof Error ? error.message : String(error)
        });
      })
      .finally(() => {
        this.#catchUpPromise = undefined;
      });

    await this.#catchUpPromise;
  }

  async postSlackMessage(options: {
    readonly channelId: string;
    readonly rootThreadTs: string;
    readonly text: string;
    readonly kind?: SlackTurnSignalKind | undefined;
    readonly reason?: string | undefined;
  }): Promise<void> {
    const chunks = chunkSlackMessage(options.text);
    for (const [index, chunk] of chunks.entries()) {
      await this.#postBotThreadMessage(options.channelId, options.rootThreadTs, chunk, {
        turnSignal:
          index === 0 && options.kind
            ? {
                kind: options.kind,
                reason: options.reason
              }
            : undefined
      });
    }
  }

  async postSlackState(options: {
    readonly channelId: string;
    readonly rootThreadTs: string;
    readonly kind: "wait" | "block" | "final";
    readonly reason?: string | undefined;
  }): Promise<void> {
    const session = this.#sessions.getSession(options.channelId, options.rootThreadTs);
    if (!session) {
      throw new Error(`Unknown session for Slack state update: ${options.channelId}:${options.rootThreadTs}`);
    }

    await this.#sessions.recordTurnSignal(options.channelId, options.rootThreadTs, {
      turnId: this.#resolveTurnIdForSignal(session),
      kind: options.kind,
      reason: options.reason,
      occurredAt: new Date().toISOString()
    });
  }

  async postSlackFile(options: {
    readonly channelId: string;
    readonly rootThreadTs: string;
    readonly filePath?: string | undefined;
    readonly contentBase64?: string | undefined;
    readonly filename?: string | undefined;
    readonly title?: string | undefined;
    readonly initialComment?: string | undefined;
    readonly altText?: string | undefined;
    readonly snippetType?: string | undefined;
    readonly contentType?: string | undefined;
  }): Promise<SlackUploadedFile> {
    const hasFilePath = Boolean(options.filePath?.trim());
    const hasInlineContent = Boolean(options.contentBase64?.trim());

    if (hasFilePath === hasInlineContent) {
      throw new Error("Provide exactly one of file_path or content_base64");
    }

    let filename = options.filename?.trim() || undefined;
    let bytes: Uint8Array;

    if (hasFilePath) {
      const filePath = options.filePath!.trim();
      bytes = await readFile(filePath);
      filename ??= path.basename(filePath);
    } else {
      const decoded = Buffer.from(options.contentBase64!.trim(), "base64");
      if (decoded.byteLength === 0) {
        throw new Error("Decoded content_base64 was empty");
      }
      if (!filename) {
        throw new Error("filename is required when using content_base64");
      }
      bytes = decoded;
    }

    if (!filename) {
      throw new Error("Unable to determine filename for Slack upload");
    }

    const uploaded = await this.#slackApi.uploadThreadFile({
      channelId: options.channelId,
      threadTs: options.rootThreadTs,
      filename,
      bytes,
      title: options.title?.trim() || undefined,
      initialComment: options.initialComment?.trim() || undefined,
      altText: options.altText?.trim() || undefined,
      snippetType: options.snippetType?.trim() || undefined,
      contentType: options.contentType?.trim() || undefined
    });
    await this.#sessions.setLastSlackReplyAt(options.channelId, options.rootThreadTs, new Date().toISOString());
    return uploaded;
  }

  async #handleCompletedTurnDisposition(
    session: SlackSessionRecord,
    turnId: string,
    dispatchMessages: readonly PersistedInboundMessage[],
    options: {
      readonly aborted: boolean;
    }
  ): Promise<SlackSessionRecord> {
    if (options.aborted) {
      return session;
    }

    if (dispatchMessages.length > 0 && dispatchMessages.every((message) => isUnexpectedTurnStopMessage(message))) {
      return session;
    }

    const signalKind = session.lastTurnSignalTurnId === turnId ? session.lastTurnSignalKind : undefined;
    if (isStopExplainingTurnSignalKind(signalKind)) {
      if (signalKind !== "wait" || this.#hasRunningBackgroundJob(session)) {
        return session;
      }
    }

    if (this.#hasPendingUnexpectedStopNudge(session, turnId)) {
      return session;
    }

    const reason = signalKind === "wait"
      ? "The previous run said it was waiting, but there is no running broker-managed async job attached to this session. Either resume the work, declare a block that clearly names the human/external blocker, or register the async job and then declare wait."
      : "The previous run ended without an explicit final, block, or wait state. Either continue the work, send a final Slack update, declare a block that clearly names the human/external blocker, or declare a wait state backed by a running broker-managed async job.";

    await this.acceptUnexpectedTurnStop({
      session,
      previousTurnId: turnId,
      reason
    });

    return this.#findSessionByKey(session.key);
  }

  #hasRunningBackgroundJob(session: SlackSessionRecord): boolean {
    return this.#sessions.listBackgroundJobs({
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs
    }).some((job) => job.status === "registered" || job.status === "running");
  }

  #hasPendingUnexpectedStopNudge(session: SlackSessionRecord, turnId: string): boolean {
    return this.#sessions.listInboundMessages({
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs,
      source: "unexpected_turn_stop",
      status: ["pending", "inflight", "done"]
    }).some((message) => message.unexpectedTurnStop?.turnId === turnId);
  }

  #resolveTurnIdForSignal(session: SlackSessionRecord): string | undefined {
    if (session.activeTurnId) {
      return session.activeTurnId;
    }

    const inflightBatchIds = new Set(
      this.#sessions.listInboundMessages({
        channelId: session.channelId,
        rootThreadTs: session.rootThreadTs,
        status: "inflight"
      })
        .map((message) => message.batchId)
        .filter((batchId): batchId is string => Boolean(batchId))
    );

    if (inflightBatchIds.size === 1) {
      return [...inflightBatchIds][0];
    }

    return undefined;
  }

  async stopActiveTurn(session: SlackSessionRecord): Promise<boolean> {
    const runtime = this.#getRuntimeSession(session.key);
    runtime.queue.length = 0;

    if (!session.activeTurnId || !session.codexThreadId) {
      return false;
    }

    await this.#turnRunner.ensureCodexThread(session);
    await this.#turnRunner.interrupt(session);
    await this.#inboundStore.markTurnBatchDone(session, session.activeTurnId);
    await this.#sessions.setActiveTurnId(session.channelId, session.rootThreadTs, undefined);
    return true;
  }

  async acceptInboundMessage(session: SlackSessionRecord, item: SlackInputMessage): Promise<void> {
    if (!item.messageTs) {
      logger.warn("Skipping Slack inbound message without message ts", {
        sessionKey: session.key,
        source: item.source,
        userId: item.userId
      });
      return;
    }

    this.#clearDispatchFailureBlock(session.key);
    const recordedSession = await this.#inboundStore.recordInboundMessage(session, item);
    await this.#dispatchPersistedMessage(recordedSession, item.messageTs);
  }

  async #reconcilePersistedActiveTurns(): Promise<void> {
    const sessions = this.#sessions
      .listSessions()
      .filter((session) => session.activeTurnId)
      .sort((left, right) => compareIsoTimestamp(right.updatedAt, left.updatedAt));

    if (sessions.length === 0) {
      return;
    }

    logger.info("Reconciling persisted active Slack sessions", {
      candidateSessionCount: sessions.length
    });

    let clearedCount = 0;
    let retainedCount = 0;

    for (const session of sessions) {
      const outcome = await this.#reconcileSingleActiveTurn(session);
      if (outcome === "retained") {
        retainedCount += 1;
      } else {
        clearedCount += 1;
      }
    }

    logger.info("Finished persisted active session reconciliation", {
      clearedCount,
      retainedCount
    });
  }

  #startActiveTurnReconciler(): void {
    this.#stopActiveTurnReconciler();
    this.#activeTurnReconcileTimer = setInterval(() => {
      void this.#reconcileLiveActiveTurns();
    }, this.#config.slackActiveTurnReconcileIntervalMs);
  }

  #stopActiveTurnReconciler(): void {
    if (!this.#activeTurnReconcileTimer) {
      return;
    }

    clearInterval(this.#activeTurnReconcileTimer);
    this.#activeTurnReconcileTimer = undefined;
  }

  async #reconcileLiveActiveTurns(): Promise<void> {
    const sessions = this.#sessions
      .listSessions()
      .filter((session) => session.activeTurnId)
      .sort((left, right) => compareIsoTimestamp(right.updatedAt, left.updatedAt));

    for (const session of sessions) {
      try {
        const outcome = await this.#reconcileSingleActiveTurn(session);
        if (outcome === "retained") {
          await this.#maybeRemindSilentActiveTurn(this.#findSessionByKey(session.key));
        }
      } catch (error) {
        logger.warn("Failed to reconcile live Codex turn state", {
          sessionKey: session.key,
          turnId: session.activeTurnId ?? null,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    await this.#recoverDormantPendingSessions();
  }

  async #reconcileSingleActiveTurn(session: SlackSessionRecord): Promise<"cleared" | "retained"> {
    const outcome = await this.#turnReconciler.reconcileSingleActiveTurn(session);

    if (outcome === "cleared") {
      this.#resetRuntimeProcessing(session.key);
      await this.#resumePendingDispatch(session.key);
    }

    return outcome;
  }

  async #runMissedThreadRecovery(reason: "socket_ready"): Promise<void> {
    const now = Date.now();
    const sessions = this.#sessions
      .listSessions()
      .filter((session) => shouldAutoRecoverSession(session, now))
      .sort((left, right) => compareIsoTimestamp(right.updatedAt, left.updatedAt));

    if (sessions.length === 0) {
      return;
    }

    logger.info("Checking Slack threads for missed messages", {
      reason,
      candidateSessionCount: sessions.length
    });

    let recoveredBatchCount = 0;
    let recoveredMessageCount = 0;

    for (let session of sessions) {
      const messages = await this.#slackApi.listThreadMessages({
        channelId: session.channelId,
        rootThreadTs: session.rootThreadTs
      });
      const latestPersistedMessageTs =
        this.#sessions.getLatestSlackInboundMessageTs(session.channelId, session.rootThreadTs) ??
        session.lastObservedMessageTs;
      const missedMessages = messages
        .filter((message) => !this.#selfMessageFilter.shouldIgnoreThreadMessage(message))
        .filter((message) => isSlackMessageAfterCursor(message.messageTs, latestPersistedMessageTs));

      if (missedMessages.length > 0) {
        logger.warn("Recovering missed Slack thread messages", {
          reason,
          sessionKey: session.key,
          missedCount: missedMessages.length,
          fromTs: latestPersistedMessageTs,
          toTs: missedMessages.at(-1)?.messageTs ?? null
        });
      }

      for (const message of missedMessages) {
        const input = createSlackInputFromThreadMessage("thread_reply", message);
        if (isSlackMessageEffectivelyEmpty(input.text, input.images, input.slackMessage)) {
          continue;
        }

        session = await this.#inboundStore.recordInboundMessage(session, input);
      }

      const recovered = await this.#dispatchPendingRecoveryBatch(session, "socket_ready_missed_messages");
      if (recovered > 0) {
        recoveredBatchCount += 1;
        recoveredMessageCount += recovered;
      }
    }

    logger.info("Finished Slack missed-message recovery", {
      reason,
      recoveredBatchCount,
      recoveredMessageCount
    });
  }

  async #postBotThreadMessage(
    channelId: string,
    rootThreadTs: string,
    text: string,
    options?: {
      readonly turnSignal?: {
        readonly kind: SlackTurnSignalKind;
        readonly reason?: string | undefined;
      } | undefined;
    }
  ): Promise<string | undefined> {
    const ts = await this.#slackApi.postThreadMessage(channelId, rootThreadTs, text);
    if (ts) {
      this.#selfMessageFilter.rememberPostedMessageTs(ts);
      const occurredAt = new Date().toISOString();
      const session = await this.#sessions.setLastSlackReplyAt(channelId, rootThreadTs, occurredAt);
      if (options?.turnSignal?.kind) {
        await this.#sessions.recordTurnSignal(channelId, rootThreadTs, {
          turnId: this.#resolveTurnIdForSignal(session),
          kind: options.turnSignal.kind,
          reason: options.turnSignal.reason,
          occurredAt
        });
      }
    }
    return ts;
  }

  async #maybeRemindSilentActiveTurn(session: SlackSessionRecord): Promise<void> {
    if (!session.activeTurnId || !session.codexThreadId || !session.activeTurnStartedAt) {
      return;
    }

    const nowMs = Date.now();
    const turnStartedAtMs = Date.parse(session.activeTurnStartedAt);
    if (!Number.isFinite(turnStartedAtMs)) {
      return;
    }

    const lastSlackReplyAtMs = session.lastSlackReplyAt ? Date.parse(session.lastSlackReplyAt) : Number.NaN;
    const silenceAnchorMs =
      Number.isFinite(lastSlackReplyAtMs) && lastSlackReplyAtMs > turnStartedAtMs
        ? lastSlackReplyAtMs
        : turnStartedAtMs;

    if (nowMs - silenceAnchorMs < this.#config.slackProgressReminderAfterMs) {
      return;
    }

    if (session.lastProgressReminderAt) {
      const lastReminderAtMs = Date.parse(session.lastProgressReminderAt);
      if (Number.isFinite(lastReminderAtMs) && nowMs - lastReminderAtMs < this.#config.slackProgressReminderRepeatMs) {
        return;
      }
    }

    try {
      await this.#turnRunner.steerReminder(
        session,
        [
          "You have been working in this Slack thread for a while without a user-visible update.",
          "This is only a reminder, not a command to send filler.",
          "Decide whether there is a meaningful progress point, blocker, partial conclusion, or next-step update worth sharing now.",
          "If yes, send a short Slack update. If not, keep working."
        ].join("\n")
      );
    } catch (error) {
      if (isMissingActiveTurnSteerError(error)) {
        await this.#syncActiveTurnFromSteerError(session, error);
        return;
      }
      throw error;
    }
    await this.#sessions.setLastProgressReminderAt(
      session.channelId,
      session.rootThreadTs,
      new Date().toISOString()
    );
  }

  async #dispatchPersistedMessage(session: SlackSessionRecord, messageTs: string): Promise<void> {
    let latestSession = this.#findSessionByKey(session.key);
    const pendingMessage = this.#sessions.getInboundMessage(
      latestSession.channelId,
      latestSession.rootThreadTs,
      messageTs
    );

    if (!pendingMessage || pendingMessage.status !== "pending") {
      return;
    }

    if (latestSession.activeTurnId) {
      try {
        const input = this.#inboundStore.createSlackInputFromPersistedMessage(pendingMessage);
        const steeredSession = await this.#steerPersistedMessageIntoActiveTurn(latestSession, pendingMessage, input);
        if (steeredSession) {
          latestSession = steeredSession;
          return;
        }
      } catch (error) {
        logger.warn("Failed to steer persisted Slack message into active Codex turn; falling back to queue", {
          sessionKey: session.key,
          turnId: latestSession.activeTurnId,
          messageTs,
          error: error instanceof Error ? error.message : String(error)
        });

        if (isMissingActiveTurnSteerError(error)) {
          latestSession = await this.#syncActiveTurnFromSteerError(latestSession, error, {
            messageTs
          });
        }
      }
    }

    this.#enqueueDispatch(latestSession, {
      kind: "dispatch_pending"
    });
  }

  async #dispatchPendingRecoveryBatch(
    session: SlackSessionRecord,
    recoveryKind: "socket_ready_missed_messages"
  ): Promise<number> {
    let latestSession = this.#findSessionByKey(session.key);
    const pendingMessages = this.#inboundStore.listPendingMessages(latestSession, {
      source: ["app_mention", "direct_message", "thread_reply"]
    });

    if (pendingMessages.length === 0) {
      return 0;
    }

    if (latestSession.activeTurnId) {
      try {
        const input = await this.#inboundStore.createRecoveredBatchInput(latestSession, pendingMessages, recoveryKind);
        if (!input) {
          return 0;
        }

        const steeredSession = await this.#steerPersistedBatchIntoActiveTurn(
          latestSession,
          pendingMessages,
          input
        );
        if (steeredSession) {
          latestSession = steeredSession;
          return pendingMessages.length;
        }
      } catch (error) {
        logger.warn("Failed to steer recovered Slack backlog into active Codex turn; queuing backlog", {
          sessionKey: session.key,
          turnId: latestSession.activeTurnId,
          recoveryKind,
          error: error instanceof Error ? error.message : String(error)
        });

        if (isMissingActiveTurnSteerError(error)) {
          latestSession = await this.#syncActiveTurnFromSteerError(latestSession, error);
        }
      }
    }

    this.#enqueueDispatch(latestSession, {
      kind: "dispatch_pending",
      recoveryKind
    });
    return pendingMessages.length;
  }

  #enqueueDispatch(session: SlackSessionRecord, request: PendingDispatchRequest): void {
    const runtime = this.#getRuntimeSession(session.key);
    runtime.blockedUntilMs = undefined;
    runtime.blockedFailureFingerprint = undefined;
    const existing = runtime.queue.find((entry) => entry.kind === "dispatch_pending");

    if (existing) {
      if (!existing.recoveryKind && request.recoveryKind) {
        runtime.queue.splice(runtime.queue.indexOf(existing), 1, request);
      }
    } else {
      runtime.queue.push(request);
    }

    logger.debug("Queued pending Slack dispatch", {
      sessionKey: session.key,
      recoveryKind: request.recoveryKind ?? null,
      queueLength: runtime.queue.length
    });

    if (!runtime.processing) {
      void this.#drainQueue(session.key);
    }
  }

  async #steerPersistedMessageIntoActiveTurn(
    session: SlackSessionRecord,
    pendingMessage: PersistedInboundMessage,
    input: SlackInputMessage
  ): Promise<SlackSessionRecord | null> {
    let latestSession = session;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!latestSession.activeTurnId) {
        return null;
      }

      try {
        await this.#turnRunner.steerActiveTurn(latestSession, input);
        await this.#inboundStore.markMessagesInflight(
          latestSession,
          [pendingMessage],
          latestSession.activeTurnId
        );
        logger.debug("Steered persisted Slack message into active Codex turn", {
          sessionKey: session.key,
          turnId: latestSession.activeTurnId,
          source: input.source,
          userId: input.userId
        });
        return latestSession;
      } catch (error) {
        const syncedSession = isMissingActiveTurnSteerError(error)
          ? await this.#syncActiveTurnFromSteerError(latestSession, error, {
              messageTs: pendingMessage.messageTs
            })
          : latestSession;
        if (syncedSession.activeTurnId && syncedSession.activeTurnId !== latestSession.activeTurnId) {
          latestSession = syncedSession;
          continue;
        }
        throw error;
      }
    }

    return null;
  }

  async #steerPersistedBatchIntoActiveTurn(
    session: SlackSessionRecord,
    pendingMessages: readonly PersistedInboundMessage[],
    input: SlackInputMessage
  ): Promise<SlackSessionRecord | null> {
    let latestSession = session;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!latestSession.activeTurnId) {
        return null;
      }

      try {
        await this.#turnRunner.steerActiveTurn(latestSession, input);
        await this.#inboundStore.markMessagesInflight(
          latestSession,
          pendingMessages,
          latestSession.activeTurnId
        );
        return latestSession;
      } catch (error) {
        const syncedSession = isMissingActiveTurnSteerError(error)
          ? await this.#syncActiveTurnFromSteerError(latestSession, error)
          : latestSession;
        if (syncedSession.activeTurnId && syncedSession.activeTurnId !== latestSession.activeTurnId) {
          latestSession = syncedSession;
          continue;
        }
        throw error;
      }
    }

    return null;
  }

  async #syncActiveTurnFromSteerError(
    session: SlackSessionRecord,
    error: unknown,
    options?: {
      readonly messageTs?: string | undefined;
    }
  ): Promise<SlackSessionRecord> {
    const mismatch = parseActiveTurnMismatch(error);
    if (mismatch && mismatch.actualTurnId !== session.activeTurnId) {
      logger.warn("Synchronizing broker active turn id to Codex-reported active turn", {
        sessionKey: session.key,
        previousTurnId: session.activeTurnId,
        actualTurnId: mismatch.actualTurnId,
        messageTs: options?.messageTs ?? null
      });
      return await this.#sessions.setActiveTurnId(
        session.channelId,
        session.rootThreadTs,
        mismatch.actualTurnId
      );
    }

    logger.warn("Detected stale active Codex turn; resetting broker runtime state", {
      sessionKey: session.key,
      turnId: session.activeTurnId,
      messageTs: options?.messageTs ?? null
    });
    await this.#sessions.resetInflightMessages(
      session.channelId,
      session.rootThreadTs,
      session.activeTurnId
    );
    const latestSession = await this.#sessions.setActiveTurnId(
      session.channelId,
      session.rootThreadTs,
      undefined
    );
    this.#resetRuntimeProcessing(session.key);
    return latestSession;
  }

  async #drainQueue(sessionKey: string): Promise<void> {
    const runtime = this.#getRuntimeSession(sessionKey);
    const generation = runtime.generation;
    runtime.processing = true;

    while (runtime.queue.length > 0) {
      if (runtime.generation !== generation) {
        return;
      }

      const next = runtime.queue.shift();
      if (!next) {
        continue;
      }

      let session = this.#findSessionByKey(sessionKey);

      try {
        if (session.activeTurnId) {
          runtime.queue.unshift(next);
          break;
        }

        session = await this.#turnRunner.ensureCodexThread(session);
        const pendingMessages = this.#inboundStore.listPendingMessages(session);

        if (pendingMessages.length === 0) {
          continue;
        }

        const dispatchMessages = next.recoveryKind ? pendingMessages : [pendingMessages[0]!];
        const slackInput = next.recoveryKind
          ? await this.#inboundStore.createRecoveredBatchInput(session, dispatchMessages, next.recoveryKind)
          : this.#inboundStore.createSlackInputFromPersistedMessage(dispatchMessages[0]!);

        if (!slackInput) {
          continue;
        }

        const input = await this.#turnRunner.buildTurnInput(slackInput);
        const turnOutcome = await this.#turnRunner.runTurnWithRecovery({
          session,
          sessionKey,
          senderUserId: slackInput.userId,
          input,
          messageTsList: dispatchMessages.map((message) => message.messageTs)
        });

        if (runtime.generation !== generation) {
          return;
        }

        session = turnOutcome.session;
        const result = turnOutcome.result;
        logger.debug("Codex turn finished without broker-managed Slack reply forwarding", {
          sessionKey,
          turnId: result.turnId,
          aborted: result.aborted,
          hadFinalMessage: Boolean(result.finalMessage)
        });
        session = await this.#handleCompletedTurnDisposition(session, result.turnId, dispatchMessages, {
          aborted: result.aborted
        });
      } catch (error) {
        if (runtime.generation !== generation) {
          return;
        }

        logger.error("Slack conversation turn dispatch failed", {
          sessionKey,
          channelId: session.channelId,
          rootThreadTs: session.rootThreadTs,
          error: error instanceof Error ? error.message : String(error)
        });
        const nowMs = Date.now();
        if (shouldNotifySlackFailure({
          previousFingerprint: runtime.lastFailureNotificationFingerprint,
          previousNotifiedAtMs: runtime.lastFailureNotificationAtMs,
          error,
          nowMs
        })) {
          await this.#postBotThreadMessage(
            session.channelId,
            session.rootThreadTs,
            formatSlackRunFailureMessage(error)
          );
          runtime.lastFailureNotificationFingerprint = createSlackFailureFingerprint(error);
          runtime.lastFailureNotificationAtMs = nowMs;
        } else {
          logger.warn("Suppressing duplicate Slack run failure notification", {
            sessionKey,
            error: error instanceof Error ? error.message : String(error)
          });
        }
        await this.#sessions.setActiveTurnId(session.channelId, session.rootThreadTs, undefined);
        if (
          isRecoverableCodexTurnFailure(error) ||
          isMissingActiveTurnSteerError(error) ||
          isMissingCodexThreadError(error)
        ) {
          this.#scheduleAutoResume(session.key);
        } else {
          runtime.blockedUntilMs = nowMs + NONRECOVERABLE_DISPATCH_RETRY_COOLDOWN_MS;
          runtime.blockedFailureFingerprint = createSlackFailureFingerprint(error);
          logger.warn("Pausing automatic retries for a session after non-recoverable dispatch failure", {
            sessionKey,
            blockedUntilMs: runtime.blockedUntilMs,
            error: error instanceof Error ? error.message : String(error)
          });
        }
        break;
      }
    }

    if (runtime.generation === generation) {
      runtime.processing = false;
    }
  }

  #getRuntimeSession(sessionKey: string): RuntimeSessionState {
    let runtime = this.#runtimeSessions.get(sessionKey);

    if (!runtime) {
      runtime = {
        queue: [],
        processing: false,
        generation: 0
      };
      this.#runtimeSessions.set(sessionKey, runtime);
    }

    return runtime;
  }

  #findSessionByKey(sessionKey: string): SlackSessionRecord {
    const session = this.#sessions.listSessions().find((entry) => entry.key === sessionKey);
    if (!session) {
      throw new Error(`Unknown session runtime key: ${sessionKey}`);
    }

    return session;
  }

  #resetRuntimeProcessing(sessionKey: string): void {
    const runtime = this.#getRuntimeSession(sessionKey);
    runtime.generation += 1;
    runtime.processing = false;
  }

  #clearDispatchFailureBlock(sessionKey: string): void {
    const runtime = this.#getRuntimeSession(sessionKey);
    runtime.blockedUntilMs = undefined;
    runtime.blockedFailureFingerprint = undefined;
  }

  #scheduleAutoResume(sessionKey: string): void {
    const runtime = this.#getRuntimeSession(sessionKey);
    if (runtime.autoResumeTimer) {
      return;
    }

    runtime.autoResumeTimer = setTimeout(() => {
      runtime.autoResumeTimer = undefined;
      void this.#resumePendingDispatch(sessionKey, {
        forceReset: true
      }).catch((error) => {
        logger.warn("Failed to auto-resume pending Slack dispatch after recoverable turn failure", {
          sessionKey,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }, AUTO_RESUME_AFTER_FAILURE_MS);

    logger.warn("Scheduled automatic retry for pending Slack dispatch after recoverable turn failure", {
      sessionKey,
      delayMs: AUTO_RESUME_AFTER_FAILURE_MS
    });
  }

  async #resumePendingDispatch(sessionKey: string, options?: {
    readonly forceReset?: boolean | undefined;
  }): Promise<number> {
    const session = this.#sessions.listSessions().find((entry) => entry.key === sessionKey);
    if (!session) {
      return 0;
    }

    const pendingMessages = this.#inboundStore.listPendingMessages(session);
    if (pendingMessages.length === 0) {
      return 0;
    }

    if (!session.activeTurnId && options?.forceReset) {
      logger.warn("Force-resetting broker runtime state before resuming pending Slack dispatch", {
        sessionKey,
        pendingCount: pendingMessages.length
      });
      this.#resetRuntimeProcessing(sessionKey);
    }

    this.#enqueueDispatch(session, {
      kind: "dispatch_pending"
    });

    return pendingMessages.length;
  }

  async #recoverPendingSessionsOnBoot(): Promise<void> {
    const sessions = this.#sessions
      .listSessions()
      .filter((session) => !session.activeTurnId)
      .sort((left, right) => compareIsoTimestamp(right.updatedAt, left.updatedAt));

    let resumedSessionCount = 0;
    let resumedMessageCount = 0;
    let orphanedInflightDoneCount = 0;
    let orphanedInflightResetCount = 0;

    for (const session of sessions) {
      const reconciled = await this.#inboundStore.reconcileOrphanedInflightMessages(session);
      orphanedInflightDoneCount += reconciled.markedDoneCount;
      orphanedInflightResetCount += reconciled.resetToPendingCount;

      const resumedCount = await this.#resumePendingDispatch(session.key, {
        forceReset: true
      });

      if (resumedCount === 0) {
        continue;
      }

      resumedSessionCount += 1;
      resumedMessageCount += resumedCount;
    }

    if (resumedSessionCount > 0) {
      logger.warn("Recovered pending Slack dispatch backlog during broker startup", {
        resumedSessionCount,
        resumedMessageCount,
        orphanedInflightDoneCount,
        orphanedInflightResetCount
      });
    } else if (orphanedInflightDoneCount > 0 || orphanedInflightResetCount > 0) {
      logger.warn("Reconciled orphaned inflight Slack messages during broker startup", {
        orphanedInflightDoneCount,
        orphanedInflightResetCount
      });
    }
  }

  async #recoverDormantPendingSessions(): Promise<void> {
    const nowMs = Date.now();
    const sessions = this.#sessions
      .listSessions()
      .filter((session) => !session.activeTurnId)
      .sort((left, right) => compareIsoTimestamp(right.updatedAt, left.updatedAt));

    for (const session of sessions) {
      const runtime = this.#getRuntimeSession(session.key);
      if (runtime.processing) {
        continue;
      }

      const reconciled = await this.#inboundStore.reconcileOrphanedInflightMessages(session);
      if (reconciled.markedDoneCount > 0 || reconciled.resetToPendingCount > 0) {
        logger.warn("Reconciled orphaned inflight Slack messages for idle session", {
          sessionKey: session.key,
          markedDoneCount: reconciled.markedDoneCount,
          resetToPendingCount: reconciled.resetToPendingCount
        });
      }

      if (runtime.blockedUntilMs && runtime.blockedUntilMs > nowMs) {
        continue;
      }

      await this.#resumePendingDispatch(session.key);
    }
  }

  async #recoverPendingSyntheticMessages(): Promise<void> {
    const sessions = this.#sessions
      .listSessions()
      .sort((left, right) => compareIsoTimestamp(right.updatedAt, left.updatedAt));

    for (const session of sessions) {
      const pendingSyntheticMessages = this.#sessions.listInboundMessages({
        channelId: session.channelId,
        rootThreadTs: session.rootThreadTs,
        status: "pending",
        source: "background_job_event"
      });

      for (const message of pendingSyntheticMessages) {
        await this.#dispatchPersistedMessage(session, message.messageTs);
      }
    }
  }
}
