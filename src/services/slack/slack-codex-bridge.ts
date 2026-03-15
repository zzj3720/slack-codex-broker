import type { AppConfig } from "../../config.js";
import { logger } from "../../logger.js";
import type {
  BackgroundJobEventPayload,
  ResolvedSlackThreadMessage,
  SlackSessionRecord,
  SlackUserIdentity
} from "../../types.js";
import { CodexBroker } from "../codex/codex-broker.js";
import { SessionManager } from "../session-manager.js";
import {
  type ParsedSlackEvent,
  isSlackMessageEffectivelyEmpty,
  parseSlackEvent
} from "./slack-event-parser.js";
import { SlackApi } from "./slack-api.js";
import { SlackConversationService } from "./slack-conversation-service.js";
import { SlackSelfMessageFilter } from "./slack-self-filter.js";
import { SlackSocketModeClient } from "./socket-mode-client.js";

export class SlackCodexBridge {
  readonly #config: AppConfig;
  readonly #sessions: SessionManager;
  readonly #codex: CodexBroker;
  readonly #slackApi: SlackApi;
  readonly #slackSocket: SlackSocketModeClient;
  readonly #selfMessageFilter = new SlackSelfMessageFilter();
  readonly #conversations: SlackConversationService;
  #botUserId = "";
  #botIdentity: SlackUserIdentity | null = null;

  constructor(options: {
    readonly config: AppConfig;
    readonly sessions: SessionManager;
    readonly codex: CodexBroker;
  }) {
    this.#config = options.config;
    this.#sessions = options.sessions;
    this.#codex = options.codex;
    this.#slackApi = new SlackApi({
      baseUrl: this.#config.slackApiBaseUrl,
      appToken: this.#config.slackAppToken,
      botToken: this.#config.slackBotToken
    });
    this.#slackSocket = new SlackSocketModeClient({
      api: this.#slackApi,
      socketOpenPath: this.#config.slackSocketOpenUrl
    });
    this.#conversations = new SlackConversationService({
      config: this.#config,
      sessions: this.#sessions,
      codex: this.#codex,
      slackApi: this.#slackApi,
      selfMessageFilter: this.#selfMessageFilter
    });
  }

  async start(): Promise<void> {
    await this.#sessions.load();
    await this.#codex.start();

    const auth = await this.#slackApi.authTest();
    this.#botUserId = auth.userId;
    this.#selfMessageFilter.setIdentity(auth);
    this.#conversations.setBotUserId(auth.userId);

    this.#botIdentity = await this.#slackApi.getUserIdentity(this.#botUserId);
    this.#codex.setSlackBotIdentity(this.#botIdentity);

    await this.#conversations.start();

    this.#slackSocket.on("ready", () => {
      void this.#conversations.recoverMissedThreadMessages("socket_ready");
    });
    this.#slackSocket.on("events_api", (payload) => {
      void this.#handleEventsApi(payload as {
        readonly event?: Record<string, any>;
        readonly event_id?: string;
      });
    });

    await this.#slackSocket.start();
  }

  async stop(): Promise<void> {
    await this.#slackSocket.stop();
    await this.#conversations.stop();
    await this.#codex.stop();
  }

  async readThreadHistory(options: {
    readonly channelId: string;
    readonly rootThreadTs: string;
    readonly beforeMessageTs?: string | undefined;
    readonly limit?: number | undefined;
    readonly channelType?: string | undefined;
  }): Promise<{
    readonly messages: readonly ResolvedSlackThreadMessage[];
    readonly formattedText?: string | undefined;
    readonly hasMore: boolean;
  }> {
    return await this.#conversations.readThreadHistory(options);
  }

  async replayThreadMessage(options: {
    readonly channelId: string;
    readonly rootThreadTs: string;
    readonly messageTs: string;
  }) {
    return await this.#conversations.replayThreadMessage(options);
  }

  async acceptBackgroundJobEvent(options: {
    readonly channelId: string;
    readonly rootThreadTs: string;
    readonly payload: BackgroundJobEventPayload;
  }): Promise<void> {
    await this.#conversations.acceptBackgroundJobEvent(options);
  }

  async postSlackMessage(options: {
    readonly channelId: string;
    readonly rootThreadTs: string;
    readonly text: string;
  }): Promise<void> {
    await this.#conversations.postSlackMessage(options);
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
  }) {
    return await this.#conversations.postSlackFile(options);
  }

  async #handleEventsApi(payload: {
    readonly event?: Record<string, any>;
    readonly event_id?: string;
  }): Promise<void> {
    if (!payload.event || !payload.event_id) {
      return;
    }

    if (this.#sessions.hasProcessedEvent(payload.event_id)) {
      return;
    }

    try {
      await this.#routeSlackEvent(payload.event);
      await this.#sessions.markProcessedEvent(payload.event_id);
    } catch (error) {
      logger.error("Failed to process Slack event", {
        eventId: payload.event_id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async #routeSlackEvent(event: Record<string, any>): Promise<void> {
    if (this.#selfMessageFilter.shouldIgnoreEvent(event)) {
      return;
    }

    const parsed = parseSlackEvent(event, this.#botUserId);
    if (!parsed) {
      return;
    }

    switch (parsed.route) {
      case "app_mention":
        await this.#handleInteractiveSessionEvent(parsed, {
          createSession: true,
          preloadHistory: parsed.rootThreadTs !== parsed.messageTs
        });
        return;
      case "direct_message":
        if (parsed.controlText === "-stop" && (parsed.input.images?.length ?? 0) === 0) {
          const existing = this.#sessions.getSession(parsed.channelId, parsed.rootThreadTs);
          if (existing) {
            await this.#handleStop(existing);
          }
          return;
        }

        await this.#handleInteractiveSessionEvent(parsed, {
          createSession: true,
          preloadHistory: false
        });
        return;
      case "thread_reply": {
        const session = this.#sessions.getSession(parsed.channelId, parsed.rootThreadTs);
        if (!session) {
          return;
        }

        if (this.#conversations.isAlreadyHandled(session, parsed.messageTs)) {
          return;
        }

        if (parsed.controlText === "-stop" && (parsed.input.images?.length ?? 0) === 0) {
          await this.#handleStop(session);
          return;
        }

        if (isSlackMessageEffectivelyEmpty(parsed.input.text, parsed.input.images, parsed.input.slackMessage)) {
          return;
        }

        await this.#conversations.acceptInboundMessage(session, parsed.input);
        return;
      }
      default:
        return;
    }
  }

  async #handleInteractiveSessionEvent(
    parsed: ParsedSlackEvent,
    options: {
      readonly createSession: boolean;
      readonly preloadHistory: boolean;
    }
  ): Promise<void> {
    const existing = this.#sessions.getSession(parsed.channelId, parsed.rootThreadTs);
    let session = options.createSession
      ? await this.#sessions.ensureSession(parsed.channelId, parsed.rootThreadTs)
      : existing;

    if (!session) {
      return;
    }

    if (this.#conversations.isAlreadyHandled(session, parsed.messageTs)) {
      return;
    }

    if (!existing) {
      await this.#conversations.postSlackMessage({
        channelId: parsed.channelId,
        rootThreadTs: parsed.rootThreadTs,
        text: `Session ready. Workspace \`${session.workspacePath}\`. Shared repos live under \`${this.#config.reposRoot}\`.`
      });
    }

    session = await this.#conversations.ensureCodexThread(session);

    if (isSlackMessageEffectivelyEmpty(parsed.input.text, parsed.input.images, parsed.input.slackMessage)) {
      return;
    }

    const history = !existing && options.preloadHistory && parsed.messageTs
      ? await this.#conversations.readThreadHistory({
        channelId: parsed.channelId,
        channelType: parsed.channelType,
        rootThreadTs: parsed.rootThreadTs,
        beforeMessageTs: parsed.messageTs,
        limit: this.#config.slackInitialThreadHistoryCount
      })
      : undefined;

    await this.#conversations.acceptInboundMessage(session, {
      ...parsed.input,
      contextText: history?.formattedText
    });
  }

  async #handleStop(session: SlackSessionRecord): Promise<void> {
    const stopped = await this.#conversations.stopActiveTurn(session);
    await this.#conversations.postSlackMessage({
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs,
      text: stopped ? "Stopped the current run." : "No active run to stop."
    });
  }
}
