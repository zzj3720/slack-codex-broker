import { AppServerClient } from "./app-server-client.js";
import { AppServerProcess } from "./app-server-process.js";
import type { SlackSessionRecord, SlackUserIdentity } from "../../types.js";
import type {
  AppServerAccountSummary,
  CodexInputItem,
  ReadTurnResultOptions,
  ReadTurnResult,
  StartedTurn
} from "./app-server-client.js";
import { logger } from "../../logger.js";
import { getPersonalMemoryPath } from "./codex-home.js";

export class CodexBroker {
  readonly #appServerProcess?: AppServerProcess;
  #client: AppServerClient;
  readonly #loadedThreadIds = new Set<string>();
  readonly #serviceName: string;
  readonly #brokerHttpBaseUrl: string;
  readonly #openAiApiKey?: string | undefined;
  readonly #codexAppServerUrl?: string | undefined;
  readonly #personalMemoryFilePath: string;
  readonly #reposRoot: string;
  #slackBotIdentity: SlackUserIdentity | null = null;
  #reconnectPromise: Promise<void> | undefined;
  #stopping = false;

  constructor(options: {
    readonly serviceName: string;
    readonly brokerHttpBaseUrl: string;
    readonly codexHome: string;
    readonly reposRoot: string;
    readonly hostCodexHomePath?: string | undefined;
    readonly codexAppServerPort: number;
    readonly codexAppServerUrl?: string | undefined;
    readonly codexAuthJsonPath?: string | undefined;
    readonly codexDisabledMcpServers: string[];
    readonly openAiApiKey?: string | undefined;
  }) {
    this.#serviceName = options.serviceName;
    this.#brokerHttpBaseUrl = options.brokerHttpBaseUrl;
    this.#openAiApiKey = options.openAiApiKey;
    this.#codexAppServerUrl = options.codexAppServerUrl;
    this.#personalMemoryFilePath = getPersonalMemoryPath(options.codexHome);
    this.#reposRoot = options.reposRoot;

    if (options.codexAppServerUrl) {
      this.#client = this.#createClient(options.codexAppServerUrl);
      this.#bindClient(this.#client);
      return;
    }

    this.#appServerProcess = new AppServerProcess({
      codexHome: options.codexHome,
      hostCodexHomePath: options.hostCodexHomePath,
      port: options.codexAppServerPort,
      authJsonPath: options.codexAuthJsonPath,
      disabledMcpServers: options.codexDisabledMcpServers,
      openAiApiKey: options.openAiApiKey
    });
    this.#client = this.#createClient(this.#appServerProcess.url);
    this.#bindClient(this.#client);
  }

  get client(): AppServerClient {
    return this.#client;
  }

  async start(): Promise<void> {
    this.#stopping = false;
    await this.#connectClient({
      restartProcess: true
    });
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    await this.#client.close();
    await this.#appServerProcess?.stop();
  }

  setSlackBotIdentity(identity: SlackUserIdentity | null): void {
    this.#slackBotIdentity = identity;
    this.#client.setSlackBotIdentity(identity);
  }

  async ensureThread(session: SlackSessionRecord): Promise<string> {
    if (session.codexThreadId && this.#loadedThreadIds.has(session.codexThreadId)) {
      return session.codexThreadId;
    }

    const threadId = await this.#withRecovery(() => this.#client.ensureThread(session));
    this.#loadedThreadIds.add(threadId);
    return threadId;
  }

  async startTurn(session: SlackSessionRecord, input: readonly CodexInputItem[]): Promise<StartedTurn> {
    if (!session.codexThreadId) {
      throw new Error(`Session ${session.key} has no Codex thread id`);
    }

    return await this.#withRecovery(() =>
      this.#client.startTurn(session.codexThreadId!, session.workspacePath, input)
    );
  }

  async steer(session: SlackSessionRecord, input: readonly CodexInputItem[]): Promise<void> {
    if (!session.codexThreadId || !session.activeTurnId) {
      throw new Error(`Session ${session.key} has no active Codex turn to steer`);
    }

    await this.#withRecovery(() =>
      this.#client.steerTurn({
        threadId: session.codexThreadId!,
        turnId: session.activeTurnId!,
        input
      })
    );
  }

  async interrupt(session: SlackSessionRecord): Promise<void> {
    if (!session.codexThreadId || !session.activeTurnId) {
      return;
    }

    await this.#withRecovery(() => this.#client.interruptTurn(session.codexThreadId!, session.activeTurnId!));
  }

  async readTurnResult(
    session: SlackSessionRecord,
    turnId: string,
    options?: ReadTurnResultOptions
  ): Promise<ReadTurnResult | null> {
    if (!session.codexThreadId) {
      return null;
    }

    return await this.#withRecovery(() => this.#client.readTurnResult(session.codexThreadId!, turnId, options));
  }

  async readAccountSummary(refreshToken = false): Promise<AppServerAccountSummary> {
    return await this.#withRecovery(() => this.#client.readAccountSummary(refreshToken));
  }

  async restartRuntime(reason = "admin runtime restart"): Promise<void> {
    await this.#connectClient({
      restartProcess: true,
      reason
    });
  }

  #createClient(url: string): AppServerClient {
    const client = new AppServerClient({
      url,
      serviceName: this.#serviceName,
      brokerHttpBaseUrl: this.#brokerHttpBaseUrl,
      openAiApiKey: this.#openAiApiKey,
      personalMemoryFilePath: this.#personalMemoryFilePath,
      reposRoot: this.#reposRoot
    });
    client.setSlackBotIdentity(this.#slackBotIdentity);
    return client;
  }

  #bindClient(client: AppServerClient): void {
    client.on("disconnected", (error) => {
      if (client !== this.#client) {
        return;
      }

      this.#loadedThreadIds.clear();
      if (this.#stopping) {
        return;
      }

      this.#handleClientDisconnect(error instanceof Error ? error : new Error(String(error)));
    });
  }

  #handleClientDisconnect(error: Error): void {
    void this.#recoverClient(error);
  }

  async #withRecovery<T>(operation: () => Promise<T>): Promise<T> {
    await this.#ensureConnected();

    try {
      return await operation();
    } catch (error) {
      if (!isRecoverableCodexConnectionError(error)) {
        throw error;
      }

      await this.#recoverClient(error instanceof Error ? error : new Error(String(error)));
      return await operation();
    }
  }

  async #ensureConnected(): Promise<void> {
    if (this.#client.isConnected()) {
      return;
    }

    await this.#recoverClient(new Error("Codex app-server websocket is not connected"));
  }

  async #recoverClient(error: Error): Promise<void> {
    if (!this.#reconnectPromise) {
      logger.warn("Recovering Codex app-server client", {
        reason: error.message
      });
      this.#reconnectPromise = (async () => {
        try {
          await this.#connectClient({
            restartProcess: false,
            reason: error.message
          });
        } catch (reconnectError) {
          logger.warn("Reconnect to existing Codex app-server failed; restarting process", {
            reason: error.message,
            reconnectError:
              reconnectError instanceof Error ? reconnectError.message : String(reconnectError)
          });
          await this.#connectClient({
            restartProcess: true,
            reason: error.message
          });
        }
      })().finally(() => {
        this.#reconnectPromise = undefined;
      });
    }

    await this.#reconnectPromise;
  }

  async #connectClient(options: {
    readonly restartProcess: boolean;
    readonly reason?: string | undefined;
  }): Promise<void> {
    this.#loadedThreadIds.clear();
    logger.info("Connecting Codex app-server client", {
      restartProcess: options.restartProcess,
      reason: options.reason ?? null
    });

    if (options.restartProcess) {
      if (this.#appServerProcess) {
        await this.#appServerProcess.restart();
      }
    } else {
      await this.#appServerProcess?.start();
    }

    const nextClient = this.#createClient(this.#appServerProcess?.url ?? this.#codexAppServerUrl!);
    this.#bindClient(nextClient);
    await nextClient.connect();
    await nextClient.ensureAuthenticated();
    this.#client = nextClient;
    logger.info("Codex app-server client connected", {
      url: this.#appServerProcess?.url ?? this.#codexAppServerUrl ?? null
    });
  }
}

function isRecoverableCodexConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    "Codex app-server websocket is not connected",
    "WebSocket is not open",
    "readyState 3",
    "socket hang up",
    "ECONNREFUSED",
    "closed"
  ].some((pattern) => message.includes(pattern));
}
