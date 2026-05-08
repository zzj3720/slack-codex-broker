import { logger } from "../../logger.js";
import type {
  AgentInputItem,
  AgentRuntime,
  AgentTurnResult
} from "../agent-runtime/types.js";
import type {
  PersistedAgentTurnStatus,
  PersistedAgentTurnUsage,
  SlackInputMessage,
  SlackSessionRecord
} from "../../types.js";
import { SessionManager } from "../session-manager.js";
import { SlackApi } from "./slack-api.js";
import { formatSlackMessageForAgent } from "./slack-message-format.js";
import { SlackInboundStore } from "./slack-inbound-store.js";
import {
  isMissingAgentSessionError,
  isRecoverableAgentTurnFailure
} from "./slack-conversation-utils.js";

export class SlackTurnRunner {
  readonly #agentRuntime: AgentRuntime;
  readonly #slackApi: SlackApi;
  readonly #sessions: SessionManager;
  readonly #inboundStore: SlackInboundStore;

  constructor(options: {
    readonly agentRuntime: AgentRuntime;
    readonly slackApi: SlackApi;
    readonly sessions: SessionManager;
    readonly inboundStore: SlackInboundStore;
  }) {
    this.#agentRuntime = options.agentRuntime;
    this.#slackApi = options.slackApi;
    this.#sessions = options.sessions;
    this.#inboundStore = options.inboundStore;
  }

  async submitAdditionalInput(session: SlackSessionRecord, item: SlackInputMessage): Promise<void> {
    const input = await this.#buildImmediateSlackInput(item);
    const result = await this.#agentRuntime.submitInput({
      session,
      input,
      inputId: inputIdForSessionInput(session, item.messageTs ?? "active", "additional"),
      source: agentInputSourceForSlackInput(item)
    });
    if (result.receipt.delivery !== "joined_active_turn") {
      throw new Error(`Expected active input delivery for ${session.key}, got ${result.receipt.delivery}`);
    }
  }

  async buildTurnInput(message: SlackInputMessage): Promise<readonly AgentInputItem[]> {
    const enrichedMessage = await this.#enrichMentionedUsers(message);
    const sender = enrichedMessage.source !== "background_job_event" && enrichedMessage.source !== "recovered_thread_batch" && enrichedMessage.senderKind === "user"
      ? await this.#slackApi.getUserIdentity(enrichedMessage.userId)
      : null;
    const inputText = formatSlackMessageForAgent(enrichedMessage, sender);
    const imageItems = await this.#buildImageInputItems(enrichedMessage);
    return [
      createTextInputItem(inputText),
      ...imageItems
    ];
  }

  async submitInputWithRecovery(options: {
    readonly session: SlackSessionRecord;
    readonly sessionKey: string;
    readonly senderUserId: string;
    readonly input: readonly AgentInputItem[];
    readonly messageTsList: readonly string[];
  }): Promise<{
    readonly session: SlackSessionRecord;
    readonly result: AgentTurnResult;
  }> {
    let session = options.session;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const submitted = await this.#agentRuntime.submitInput({
        session,
        input: options.input,
        inputId: inputIdForSessionInput(session, options.messageTsList.join(","), `turn-${attempt + 1}`),
        source: "slack_user"
      });
      if (submitted.receipt.delivery !== "started_turn" || !submitted.completion) {
        throw new Error(`Expected new turn delivery for queued input in ${session.key}, got ${submitted.receipt.delivery}`);
      }

      logger.debug("Agent turn started", {
        sessionKey: options.sessionKey,
        turnId: submitted.receipt.turnId,
        senderUserId: options.senderUserId,
        attempt: attempt + 1
      });
      session = await this.#sessions.setActiveTurnId(
        session.channelId,
        session.rootThreadTs,
        submitted.receipt.turnId
      );
      await this.#inboundStore.markMessagesInflightByTs(session, options.messageTsList, submitted.receipt.turnId);

      try {
        const result = await submitted.completion;
        logger.debug("Agent turn completed", {
          sessionKey: options.sessionKey,
          turnId: result.turnId,
          aborted: result.aborted,
          attempt: attempt + 1
        });
        await this.#persistTurnUsage(session, result);
        session = await this.#inboundStore.markTurnBatchDone(session, submitted.receipt.turnId);
        session = await this.#sessions.setActiveTurnId(session.channelId, session.rootThreadTs, undefined);
        return {
          session,
          result
        };
      } catch (error) {
        const recovered = await this.#recoverTurnResult(session, submitted.receipt.turnId);

        if (recovered) {
          logger.warn("Recovered agent turn result from runtime snapshot after disconnect", {
            sessionKey: options.sessionKey,
            senderUserId: options.senderUserId,
            turnId: submitted.receipt.turnId,
            recoveredStatus: recovered.aborted ? "interrupted" : "completed"
          });
          await this.#persistTurnUsage(session, recovered);
          session = await this.#inboundStore.markTurnBatchDone(session, submitted.receipt.turnId);
          session = await this.#sessions.setActiveTurnId(session.channelId, session.rootThreadTs, undefined);
          return {
            session,
            result: recovered
          };
        }

        const shouldStop = attempt === 1 || !isRecoverableAgentTurnFailure(error);
        if (shouldStop) {
          await this.#persistMissingTurnUsage(session, submitted.receipt.turnId, "failed");
        }

        await this.#inboundStore.resetTurnBatchToPending(session, submitted.receipt.turnId);
        session = await this.#sessions.setActiveTurnId(session.channelId, session.rootThreadTs, undefined);

        if (shouldStop) {
          throw error;
        }

        logger.warn("Agent turn lost during runtime disconnect; retrying once", {
          sessionKey: options.sessionKey,
          senderUserId: options.senderUserId,
          error: error instanceof Error ? error.message : String(error)
        });
        session = await this.#ensureAgentSessionInternal(session);
      }
    }

    throw new Error("Agent turn retry exhausted unexpectedly");
  }

  async readTurnSnapshot(
    session: SlackSessionRecord,
    turnId: string,
    options?: {
      readonly syncActiveTurn?: boolean | undefined;
      readonly treatMissingAsStale?: boolean | undefined;
    }
  ) {
    return await this.#agentRuntime.readTurn(session, turnId, options);
  }

  async ensureAgentSession(session: SlackSessionRecord): Promise<SlackSessionRecord> {
    return await this.#ensureAgentSessionInternal(session);
  }

  async interrupt(session: SlackSessionRecord): Promise<void> {
    await this.#agentRuntime.interrupt(session);
  }

  async #ensureAgentSessionInternal(session: SlackSessionRecord): Promise<SlackSessionRecord> {
    if (session.agentSessionId) {
      try {
        await this.#agentRuntime.ensureSession(session);
        return session;
      } catch (error) {
        if (!isMissingAgentSessionError(error)) {
          throw error;
        }

        logger.warn("Stored agent session id no longer exists; resetting broker session runtime state", {
          sessionKey: session.key,
          agentSessionId: session.agentSessionId,
          error: error instanceof Error ? error.message : String(error)
        });

        session = await this.#sessions.setActiveTurnId(session.channelId, session.rootThreadTs, undefined);
        session = await this.#sessions.setAgentSessionId(session.channelId, session.rootThreadTs, undefined);
      }
    }

    const agentSession = await this.#agentRuntime.ensureSession(session);
    return await this.#sessions.setAgentSessionId(session.channelId, session.rootThreadTs, agentSession.id);
  }

  async #buildImmediateSlackInput(message: SlackInputMessage): Promise<readonly AgentInputItem[]> {
    const enrichedItem = await this.#enrichMentionedUsers(message);
    const sender = enrichedItem.source !== "background_job_event" && enrichedItem.source !== "recovered_thread_batch" && enrichedItem.senderKind === "user"
      ? await this.#slackApi.getUserIdentity(enrichedItem.userId)
      : null;
    const formattedMessage = formatSlackMessageForAgent(enrichedItem, sender);
    const imageItems = await this.#buildImageInputItems(enrichedItem);
    return [
      createTextInputItem([
        enrichedItem.recoveryKind === "missed_thread_messages"
          ? "The broker detected Slack thread messages that were not previously delivered into the active turn."
          : "A newer Slack message arrived while the current turn is still active.",
        enrichedItem.recoveryKind === "missed_thread_messages"
          ? "Review the recovered batch, merge it into the current context, and decide whether you need to adjust the ongoing work or reply now."
          : "Treat it as the latest instruction and adjust the ongoing work accordingly.",
        "",
        formattedMessage
      ].join("\n")),
      ...imageItems
    ];
  }

  async #buildImageInputItems(message: SlackInputMessage): Promise<readonly AgentInputItem[]> {
    const images = [
      ...(message.images ?? []),
      ...((message.batchMessages ?? []).flatMap((entry) => entry.images ?? []))
    ];
    if (images.length === 0) {
      return [];
    }

    const downloaded = await Promise.allSettled(
      images.map(async (image) => ({
        type: "image" as const,
        url: await this.#slackApi.downloadImageAsDataUrl(image),
        fileId: image.fileId
      }))
    );

    return downloaded.flatMap((result) => {
      if (result.status === "fulfilled") {
        return [
          {
            type: "image" as const,
            url: result.value.url
          }
        ];
      }

      logger.warn("Failed to download Slack image attachment for agent input", {
        source: message.source,
        channelId: message.channelId,
        rootThreadTs: message.rootThreadTs,
        messageTs: message.messageTs,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason)
      });
      return [];
    });
  }

  async #enrichMentionedUsers(message: SlackInputMessage): Promise<SlackInputMessage> {
    if ((message.mentionedUsers?.length ?? 0) > 0 || !message.mentionedUserIds || message.mentionedUserIds.length === 0) {
      return message;
    }

    const mentionedUsers = (
      await Promise.all(message.mentionedUserIds.map((userId) => this.#slackApi.getUserIdentity(userId)))
    ).filter((user): user is NonNullable<typeof user> => user !== null);

    if (mentionedUsers.length === 0) {
      return message;
    }

    return {
      ...message,
      mentionedUsers
    };
  }

  async #recoverTurnResult(
    session: SlackSessionRecord,
    turnId: string
  ): Promise<AgentTurnResult | null> {
    try {
      const snapshot = await this.#agentRuntime.readTurn(session, turnId, {
        syncActiveTurn: true
      });

      if (!snapshot) {
        return null;
      }

      if (snapshot.status === "completed") {
        return {
          agentSessionId: session.agentSessionId ?? "",
          turnId,
          finalMessage: snapshot.finalMessage,
          aborted: false,
          generatedImages: snapshot.generatedImages,
          usage: snapshot.usage
        };
      }

      if (snapshot.status === "interrupted") {
        return {
          agentSessionId: session.agentSessionId ?? "",
          turnId,
          finalMessage: snapshot.finalMessage,
          aborted: true,
          generatedImages: snapshot.generatedImages,
          usage: snapshot.usage
        };
      }

      if (snapshot.status === "failed") {
        throw new Error(snapshot.errorMessage ?? "Agent turn failed");
      }

      return null;
    } catch (error) {
      logger.warn("Failed to recover agent turn result from runtime snapshot", {
        sessionKey: session.key,
        turnId,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  async #persistTurnUsage(session: SlackSessionRecord, result: AgentTurnResult): Promise<void> {
    const status: PersistedAgentTurnStatus = result.aborted ? "interrupted" : "completed";
    const usage = result.usage;
    await this.#upsertTurnUsage({
      turnId: result.turnId,
      sessionKey: session.key,
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs,
      agentSessionId: result.agentSessionId || session.agentSessionId,
      status,
      source: usage?.source ?? "missing",
      model: usage?.model,
      effort: usage?.effort,
      inputTokens: usage?.inputTokens ?? 0,
      cachedInputTokens: usage?.cachedInputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      reasoningTokens: usage?.reasoningTokens ?? 0,
      totalTokens: usage?.totalTokens ?? 0,
      rawUsage: usage?.rawUsage,
      startedAt: session.activeTurnId === result.turnId ? session.activeTurnStartedAt : undefined
    });
  }

  async #persistMissingTurnUsage(
    session: SlackSessionRecord,
    turnId: string,
    status: PersistedAgentTurnStatus
  ): Promise<void> {
    await this.#upsertTurnUsage({
      turnId,
      sessionKey: session.key,
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs,
      agentSessionId: session.agentSessionId,
      status,
      source: "missing",
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      startedAt: session.activeTurnId === turnId ? session.activeTurnStartedAt : undefined
    });
  }

  async #upsertTurnUsage(record: Omit<PersistedAgentTurnUsage, "createdAt" | "updatedAt" | "completedAt">): Promise<void> {
    const now = new Date().toISOString();
    await this.#sessions.upsertAgentTurnUsage({
      ...record,
      completedAt: now,
      createdAt: record.startedAt ?? now,
      updatedAt: now
    });
  }
}

function createTextInputItem(text: string): AgentInputItem {
  return {
    type: "text",
    text,
    text_elements: []
  };
}

function inputIdForSessionInput(session: SlackSessionRecord, scope: string, kind: string): string {
  return `${session.key}:${kind}:${scope || Date.now()}`;
}

function agentInputSourceForSlackInput(message: SlackInputMessage): "slack_user" | "broker_recovery" | "background_job" {
  if (message.source === "background_job_event") {
    return "background_job";
  }
  if (message.source === "recovered_thread_batch" || message.recoveryKind) {
    return "broker_recovery";
  }
  return "slack_user";
}
