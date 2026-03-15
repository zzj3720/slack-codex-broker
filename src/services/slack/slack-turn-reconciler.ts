import { logger } from "../../logger.js";
import type { SlackSessionRecord } from "../../types.js";
import { SessionManager } from "../session-manager.js";
import { SlackInboundStore } from "./slack-inbound-store.js";
import { SlackTurnRunner } from "./slack-turn-runner.js";

export class SlackTurnReconciler {
  readonly #sessions: SessionManager;
  readonly #turnRunner: SlackTurnRunner;
  readonly #inboundStore: SlackInboundStore;

  constructor(options: {
    readonly sessions: SessionManager;
    readonly turnRunner: SlackTurnRunner;
    readonly inboundStore: SlackInboundStore;
  }) {
    this.#sessions = options.sessions;
    this.#turnRunner = options.turnRunner;
    this.#inboundStore = options.inboundStore;
  }

  async reconcileSingleActiveTurn(
    session: SlackSessionRecord
  ): Promise<"cleared" | "retained"> {
    if (!session.codexThreadId || !session.activeTurnId) {
      await this.#sessions.setActiveTurnId(session.channelId, session.rootThreadTs, undefined);
      return "cleared";
    }

    const hydratedSession = await this.#turnRunner.ensureCodexThread(session);
    const activeTurnId = hydratedSession.activeTurnId!;
    const snapshot = await this.#turnRunner.readTurnSnapshot(hydratedSession, activeTurnId, {
      syncActiveTurn: true,
      treatMissingAsStale: true
    });

    if (!snapshot) {
      logger.warn("Clearing stale active Codex turn after snapshot reconciliation", {
        sessionKey: session.key,
        turnId: activeTurnId,
        reason: "turn_missing_from_snapshot"
      });
      await this.#inboundStore.resetTurnBatchToPending(hydratedSession, activeTurnId);
      await this.#sessions.setActiveTurnId(
        hydratedSession.channelId,
        hydratedSession.rootThreadTs,
        undefined
      );
      return "cleared";
    }

    if (snapshot.status === "inProgress" || snapshot.status === "unknown") {
      return "retained";
    }

    logger.info("Reconciling terminal Codex turn state from snapshot", {
      sessionKey: session.key,
      turnId: activeTurnId,
      status: snapshot.status
    });

    if (snapshot.status === "completed" || snapshot.status === "interrupted") {
      await this.#inboundStore.markTurnBatchDone(hydratedSession, activeTurnId);
    } else {
      await this.#inboundStore.resetTurnBatchToPending(hydratedSession, activeTurnId);
    }

    await this.#sessions.setActiveTurnId(
      hydratedSession.channelId,
      hydratedSession.rootThreadTs,
      undefined
    );
    return "cleared";
  }
}
