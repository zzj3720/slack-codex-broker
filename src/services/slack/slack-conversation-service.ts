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
  SlackThreadMessage
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
  isBeforeSlackTs,
  isMissingActiveTurnSteerError,
  isSlackMessageAfterCursor,
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
}

interface PendingDispatchRequest {
  readonly kind: "dispatch_pending";
  readonly recoveryKind?: "socket_ready_missed_messages" | undefined;
}

const ACTIVE_TURN_RECONCILE_INTERVAL_MS = 15_000;

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
    await this.#recoverPendingSyntheticMessages();
    this.#startActiveTurnReconciler();
  }

  async stop(): Promise<void> {
    this.#stopActiveTurnReconciler();
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

  async acceptBackgroundJobEvent(options: {
    readonly channelId: string;
    readonly rootThreadTs: string;
    readonly payload: BackgroundJobEventPayload;
  }): Promise<void> {
    const session = this.#sessions.getSession(options.channelId, options.rootThreadTs);
    if (!session) {
      throw new Error(`Unknown session for background job event: ${options.channelId}:${options.rootThreadTs}`);
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
  }): Promise<void> {
    for (const chunk of chunkSlackMessage(options.text)) {
      await this.#postBotThreadMessage(options.channelId, options.rootThreadTs, chunk);
    }
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

    return await this.#slackApi.uploadThreadFile({
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
    }, ACTIVE_TURN_RECONCILE_INTERVAL_MS);
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
        await this.#reconcileSingleActiveTurn(session);
      } catch (error) {
        logger.warn("Failed to reconcile live Codex turn state", {
          sessionKey: session.key,
          turnId: session.activeTurnId ?? null,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
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

  async #postBotThreadMessage(channelId: string, rootThreadTs: string, text: string): Promise<string | undefined> {
    const ts = await this.#slackApi.postThreadMessage(channelId, rootThreadTs, text);
    if (ts) {
      this.#selfMessageFilter.rememberPostedMessageTs(ts);
    }
    return ts;
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
        await this.#turnRunner.steerActiveTurn(latestSession, input);
        await this.#inboundStore.markMessagesInflight(latestSession, [pendingMessage], latestSession.activeTurnId);
        logger.debug("Steered persisted Slack message into active Codex turn", {
          sessionKey: session.key,
          turnId: latestSession.activeTurnId,
          source: input.source,
          userId: input.userId
        });
        return;
      } catch (error) {
        logger.warn("Failed to steer persisted Slack message into active Codex turn; falling back to queue", {
          sessionKey: session.key,
          turnId: latestSession.activeTurnId,
          messageTs,
          error: error instanceof Error ? error.message : String(error)
        });

        if (isMissingActiveTurnSteerError(error)) {
          logger.warn("Detected stale active Codex turn; resetting broker runtime state", {
            sessionKey: session.key,
            turnId: latestSession.activeTurnId,
            messageTs
          });
          await this.#sessions.resetInflightMessages(
            latestSession.channelId,
            latestSession.rootThreadTs,
            latestSession.activeTurnId
          );
          latestSession = await this.#sessions.setActiveTurnId(
            latestSession.channelId,
            latestSession.rootThreadTs,
            undefined
          );
          this.#resetRuntimeProcessing(session.key);
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

        await this.#turnRunner.steerActiveTurn(latestSession, input);
        await this.#inboundStore.markMessagesInflight(latestSession, pendingMessages, latestSession.activeTurnId);
        return pendingMessages.length;
      } catch (error) {
        logger.warn("Failed to steer recovered Slack backlog into active Codex turn; queuing backlog", {
          sessionKey: session.key,
          turnId: latestSession.activeTurnId,
          recoveryKind,
          error: error instanceof Error ? error.message : String(error)
        });

        if (isMissingActiveTurnSteerError(error)) {
          await this.#sessions.resetInflightMessages(
            latestSession.channelId,
            latestSession.rootThreadTs,
            latestSession.activeTurnId
          );
          latestSession = await this.#sessions.setActiveTurnId(
            latestSession.channelId,
            latestSession.rootThreadTs,
            undefined
          );
          this.#resetRuntimeProcessing(session.key);
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
      } catch (error) {
        if (runtime.generation !== generation) {
          return;
        }

        await this.#postBotThreadMessage(
          session.channelId,
          session.rootThreadTs,
          `Codex run failed: ${error instanceof Error ? error.message : String(error)}`
        );
        await this.#sessions.setActiveTurnId(session.channelId, session.rootThreadTs, undefined);
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

  async #resumePendingDispatch(sessionKey: string): Promise<void> {
    const session = this.#sessions.listSessions().find((entry) => entry.key === sessionKey);
    if (!session) {
      return;
    }

    if (this.#inboundStore.listPendingMessages(session).length === 0) {
      return;
    }

    this.#enqueueDispatch(session, {
      kind: "dispatch_pending"
    });
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
