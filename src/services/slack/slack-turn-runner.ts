import type { CodexInputItem } from "../codex/app-server-client.js";
import { CodexBroker } from "../codex/codex-broker.js";
import { logger } from "../../logger.js";
import type {
  CodexTurnResult,
  SlackInputMessage,
  SlackSessionRecord
} from "../../types.js";
import { SessionManager } from "../session-manager.js";
import { SlackApi } from "./slack-api.js";
import { formatSlackMessageForCodex } from "./slack-message-format.js";
import { SlackInboundStore } from "./slack-inbound-store.js";
import {
  isMissingCodexThreadError,
  isRecoverableCodexTurnFailure
} from "./slack-conversation-utils.js";

export class SlackTurnRunner {
  readonly #codex: CodexBroker;
  readonly #slackApi: SlackApi;
  readonly #sessions: SessionManager;
  readonly #inboundStore: SlackInboundStore;

  constructor(options: {
    readonly codex: CodexBroker;
    readonly slackApi: SlackApi;
    readonly sessions: SessionManager;
    readonly inboundStore: SlackInboundStore;
  }) {
    this.#codex = options.codex;
    this.#slackApi = options.slackApi;
    this.#sessions = options.sessions;
    this.#inboundStore = options.inboundStore;
  }

  async steerActiveTurn(session: SlackSessionRecord, item: SlackInputMessage): Promise<void> {
    const enrichedItem = await this.#enrichMentionedUsers(item);
    const sender = enrichedItem.source !== "background_job_event" && enrichedItem.source !== "recovered_thread_batch" && enrichedItem.senderKind === "user"
      ? await this.#slackApi.getUserIdentity(enrichedItem.userId)
      : null;
    const formattedMessage = formatSlackMessageForCodex(enrichedItem, sender);
    const imageItems = await this.#buildImageInputItems(enrichedItem);
    await this.#codex.steer(
      session,
      [
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
      ]
    );
  }

  async buildTurnInput(message: SlackInputMessage): Promise<readonly CodexInputItem[]> {
    const enrichedMessage = await this.#enrichMentionedUsers(message);
    const sender = enrichedMessage.source !== "background_job_event" && enrichedMessage.source !== "recovered_thread_batch" && enrichedMessage.senderKind === "user"
      ? await this.#slackApi.getUserIdentity(enrichedMessage.userId)
      : null;
    const inputText = formatSlackMessageForCodex(enrichedMessage, sender);
    const imageItems = await this.#buildImageInputItems(enrichedMessage);
    return [
      createTextInputItem(inputText),
      ...imageItems
    ];
  }

  async steerReminder(session: SlackSessionRecord, text: string): Promise<void> {
    await this.#codex.steer(session, [createTextInputItem(text)]);
  }

  async runTurnWithRecovery(options: {
    readonly session: SlackSessionRecord;
    readonly sessionKey: string;
    readonly senderUserId: string;
    readonly input: readonly CodexInputItem[];
    readonly messageTsList: readonly string[];
  }): Promise<{
    readonly session: SlackSessionRecord;
    readonly result: CodexTurnResult;
  }> {
    let session = options.session;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const startedTurn = await this.#codex.startTurn(session, options.input);
      logger.debug("Codex turn started", {
        sessionKey: options.sessionKey,
        turnId: startedTurn.turnId,
        senderUserId: options.senderUserId,
        attempt: attempt + 1
      });
      session = await this.#sessions.setActiveTurnId(
        session.channelId,
        session.rootThreadTs,
        startedTurn.turnId
      );
      await this.#inboundStore.markMessagesInflightByTs(session, options.messageTsList, startedTurn.turnId);

      try {
        const result = await startedTurn.completion;
        logger.debug("Codex turn completed", {
          sessionKey: options.sessionKey,
          turnId: result.turnId,
          aborted: result.aborted,
          attempt: attempt + 1
        });
        session = await this.#inboundStore.markTurnBatchDone(session, startedTurn.turnId);
        session = await this.#sessions.setActiveTurnId(session.channelId, session.rootThreadTs, undefined);
        return {
          session,
          result
        };
      } catch (error) {
        const recovered = await this.#recoverTurnResult(session, startedTurn.turnId);

        if (recovered) {
          logger.warn("Recovered Codex turn result from thread snapshot after disconnect", {
            sessionKey: options.sessionKey,
            senderUserId: options.senderUserId,
            turnId: startedTurn.turnId,
            recoveredStatus: recovered.aborted ? "interrupted" : "completed"
          });
          session = await this.#inboundStore.markTurnBatchDone(session, startedTurn.turnId);
          session = await this.#sessions.setActiveTurnId(session.channelId, session.rootThreadTs, undefined);
          return {
            session,
            result: recovered
          };
        }

        await this.#inboundStore.resetTurnBatchToPending(session, startedTurn.turnId);
        session = await this.#sessions.setActiveTurnId(session.channelId, session.rootThreadTs, undefined);

        if (attempt === 1 || !isRecoverableCodexTurnFailure(error)) {
          throw error;
        }

        logger.warn("Codex turn lost during app-server disconnect; retrying once", {
          sessionKey: options.sessionKey,
          senderUserId: options.senderUserId,
          error: error instanceof Error ? error.message : String(error)
        });
        session = await this.#ensureCodexThreadInternal(session);
      }
    }

    throw new Error("Codex turn retry exhausted unexpectedly");
  }

  async readTurnSnapshot(
    session: SlackSessionRecord,
    turnId: string,
    options?: {
      readonly syncActiveTurn?: boolean | undefined;
      readonly treatMissingAsStale?: boolean | undefined;
    }
  ) {
    return await this.#codex.readTurnResult(session, turnId, options);
  }

  async ensureCodexThread(session: SlackSessionRecord): Promise<SlackSessionRecord> {
    return await this.#ensureCodexThreadInternal(session);
  }

  async interrupt(session: SlackSessionRecord): Promise<void> {
    await this.#codex.interrupt(session);
  }

  async #ensureCodexThreadInternal(session: SlackSessionRecord): Promise<SlackSessionRecord> {
    if (session.codexThreadId) {
      try {
        await this.#codex.ensureThread(session);
        return session;
      } catch (error) {
        if (!isMissingCodexThreadError(error)) {
          throw error;
        }

        logger.warn("Stored Codex thread id no longer exists; resetting broker session thread state", {
          sessionKey: session.key,
          codexThreadId: session.codexThreadId,
          error: error instanceof Error ? error.message : String(error)
        });

        session = await this.#sessions.setActiveTurnId(session.channelId, session.rootThreadTs, undefined);
        session = await this.#sessions.setCodexThreadId(session.channelId, session.rootThreadTs, undefined);
      }
    }

    const codexThreadId = await this.#codex.ensureThread(session);
    return await this.#sessions.setCodexThreadId(session.channelId, session.rootThreadTs, codexThreadId);
  }

  async #buildImageInputItems(message: SlackInputMessage): Promise<readonly CodexInputItem[]> {
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

      logger.warn("Failed to download Slack image attachment for Codex input", {
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
    if (message.mentionedUsers || !message.mentionedUserIds || message.mentionedUserIds.length === 0) {
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
  ): Promise<CodexTurnResult | null> {
    try {
      const snapshot = await this.#codex.readTurnResult(session, turnId, {
        syncActiveTurn: true
      });

      if (!snapshot) {
        return null;
      }

      if (snapshot.status === "completed") {
        return {
          threadId: session.codexThreadId ?? "",
          turnId,
          finalMessage: snapshot.finalMessage,
          aborted: false,
          generatedImages: snapshot.generatedImages
        };
      }

      if (snapshot.status === "interrupted") {
        return {
          threadId: session.codexThreadId ?? "",
          turnId,
          finalMessage: snapshot.finalMessage,
          aborted: true,
          generatedImages: snapshot.generatedImages
        };
      }

      if (snapshot.status === "failed") {
        throw new Error(snapshot.errorMessage ?? "Codex turn failed");
      }

      return null;
    } catch (error) {
      logger.warn("Failed to recover Codex turn result from thread snapshot", {
        sessionKey: session.key,
        turnId,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }
}

function createTextInputItem(text: string): CodexInputItem {
  return {
    type: "text",
    text,
    text_elements: []
  };
}
