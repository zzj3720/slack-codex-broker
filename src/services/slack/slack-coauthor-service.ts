import { logger } from "../../logger.js";
import type {
  GitHubAuthorMappingRecord,
  SlackInputMessage,
  SlackSessionRecord,
  SlackUserIdentity
} from "../../types.js";
import { SessionManager } from "../session-manager.js";
import { GitHubAuthorMappingService } from "../github-author-mapping-service.js";
import {
  appendCoAuthorTrailers,
  isValidGitHubAuthor,
  normalizeEmail
} from "../git/github-author-utils.js";
import { SlackApi } from "./slack-api.js";

const PROMPT_COOLDOWN_MS = 5 * 60 * 1_000;
const COAUTHOR_CONFIGURE_ACTION_ID = "coauthor_configure";
const COAUTHOR_MODAL_CALLBACK_ID = "coauthor_confirm";
const CONTRIBUTOR_BLOCK_ID = "contributors";
const CONTRIBUTOR_ACTION_ID = "selected";

export interface ResolveCommitCoauthorsResult {
  readonly status: "noop" | "blocked" | "resolved";
  readonly sessionKey?: string | undefined;
  readonly message?: string | undefined;
  readonly errorCode?: string | undefined;
  readonly coAuthors?: readonly string[] | undefined;
}

export class SlackCoauthorService {
  readonly #sessions: SessionManager;
  readonly #slackApi: SlackApi;
  readonly #mappings: GitHubAuthorMappingService;

  constructor(options: {
    readonly sessions: SessionManager;
    readonly slackApi: SlackApi;
    readonly mappings: GitHubAuthorMappingService;
  }) {
    this.#sessions = options.sessions;
    this.#slackApi = options.slackApi;
    this.#mappings = options.mappings;
  }

  async noteIncomingSlackInput(
    session: SlackSessionRecord,
    input: SlackInputMessage
  ): Promise<SlackSessionRecord> {
    const identities = await this.#resolveContributorIdentities(input);
    for (const identity of identities) {
      await this.#mappings.recordObservedIdentity(identity);
    }

    if (identities.length === 0) {
      return session;
    }

    return await this.#sessions.addCoAuthorCandidates(
      session.channelId,
      session.rootThreadTs,
      identities.map((identity) => identity.userId)
    );
  }

  async listMappings(): Promise<GitHubAuthorMappingRecord[]> {
    await this.#mappings.load();
    return this.#mappings.listMappings();
  }

  async upsertManualMapping(options: {
    readonly slackUserId: string;
    readonly githubAuthor: string;
  }): Promise<GitHubAuthorMappingRecord> {
    await this.#mappings.load();
    const slackIdentity = await this.#slackApi.getUserIdentity(options.slackUserId);
    return await this.#mappings.upsertManualMapping({
      slackUserId: options.slackUserId,
      githubAuthor: options.githubAuthor,
      slackIdentity: slackIdentity ?? undefined
    });
  }

  async deleteMapping(slackUserId: string): Promise<void> {
    await this.#mappings.load();
    await this.#mappings.deleteMapping(slackUserId);
  }

  async handleInteractivePayload(payload: Record<string, unknown>): Promise<void> {
    const type = typeof payload.type === "string" ? payload.type : undefined;
    if (type === "block_actions") {
      await this.#handleBlockActions(payload);
      return;
    }

    if (type === "view_submission") {
      await this.#handleViewSubmission(payload);
    }
  }

  async resolveCommitCoauthors(options: {
    readonly cwd: string;
    readonly commitMessage: string;
    readonly primaryAuthorEmail?: string | undefined;
  }): Promise<ResolveCommitCoauthorsResult & {
    readonly commitMessage?: string | undefined;
  }> {
    await this.#mappings.load();
    const session = this.#sessions.findSessionByWorkspace(options.cwd);
    if (!session) {
      return {
        status: "noop"
      };
    }

    const candidateUserIds = session.coAuthorCandidateUserIds ?? [];
    if (candidateUserIds.length === 0) {
      return {
        status: "noop",
        sessionKey: session.key
      };
    }

    if (session.coAuthorConfirmedRevision !== session.coAuthorCandidateRevision) {
      await this.#ensurePrompt(session);
      return {
        status: "blocked",
        sessionKey: session.key,
        errorCode: "coauthor_confirmation_required",
        message: "Commit blocked by Slack co-author gate. Open the Slack thread and confirm co-authors, then retry the commit."
      };
    }

    const confirmedUserIds = session.coAuthorConfirmedUserIds ?? [];
    const mappings = await Promise.all(
      confirmedUserIds.map(async (userId) => {
        let mapping = this.#mappings.getMapping(userId);
        if (!mapping) {
          const identity = await this.#slackApi.getUserIdentity(userId);
          if (identity) {
            mapping = await this.#mappings.recordObservedIdentity(identity) ?? undefined;
          }
        }
        return mapping ?? null;
      })
    );

    const missingUserIds = confirmedUserIds.filter((userId, index) => !mappings[index]);
    if (missingUserIds.length > 0) {
      await this.#ensurePrompt(session);
      return {
        status: "blocked",
        sessionKey: session.key,
        errorCode: "coauthor_mapping_required",
        message: "Commit blocked by Slack co-author gate. At least one confirmed Slack contributor is still missing a GitHub author mapping."
      };
    }

    const coAuthors = mappings
      .filter((mapping): mapping is GitHubAuthorMappingRecord => mapping !== null)
      .map((mapping) => mapping.githubAuthor);
    const commitMessage = appendCoAuthorTrailers(options.commitMessage, {
      coAuthors,
      primaryAuthorEmail: options.primaryAuthorEmail
    });

    if (commitMessage === options.commitMessage) {
      return {
        status: "noop",
        sessionKey: session.key,
        coAuthors
      };
    }

    return {
      status: "resolved",
      sessionKey: session.key,
      coAuthors,
      commitMessage
    };
  }

  async #handleBlockActions(payload: Record<string, unknown>): Promise<void> {
    const triggerId = readString(payload.trigger_id);
    const actions = Array.isArray(payload.actions) ? payload.actions : [];
    const action = actions.find((entry) => {
      return entry && typeof entry === "object" && (entry as { action_id?: string }).action_id === COAUTHOR_CONFIGURE_ACTION_ID;
    }) as { value?: string } | undefined;

    if (!triggerId || !action?.value) {
      return;
    }

    const metadata = parsePrivateMetadata(action.value);
    if (!metadata) {
      return;
    }

    const session = this.#sessions.getSessionByKey(metadata.sessionKey);
    if (!session) {
      return;
    }

    await this.#mappings.load();
    const modalView = await this.#buildModalView(session);
    await this.#slackApi.openView({
      triggerId,
      view: modalView
    });
  }

  async #handleViewSubmission(payload: Record<string, unknown>): Promise<void> {
    const userId = readString((payload.user as { id?: string } | undefined)?.id);
    const view = payload.view as {
      private_metadata?: string;
      state?: {
        values?: Record<string, Record<string, Record<string, unknown>>>;
      };
    } | undefined;
    const metadata = parsePrivateMetadata(view?.private_metadata);
    if (!metadata) {
      return;
    }

    const session = this.#sessions.getSessionByKey(metadata.sessionKey);
    if (!session || session.coAuthorCandidateRevision !== metadata.candidateRevision) {
      await this.#postSubmitResult(userId, metadata.sessionKey, "Co-author candidates changed. Open the Slack prompt again before retrying the commit.");
      return;
    }

    const values = view?.state?.values ?? {};
    const selectedUserIds = readSelectedContributorUserIds(values);
    const invalidUserIds: string[] = [];

    await this.#mappings.load();
    for (const userId of selectedUserIds) {
      const githubAuthor = readGitHubAuthorInput(values, userId);
      if (!githubAuthor || !isValidGitHubAuthor(githubAuthor)) {
        invalidUserIds.push(userId);
        continue;
      }

      const slackIdentity = await this.#slackApi.getUserIdentity(userId);
      await this.#mappings.upsertManualMapping({
        slackUserId: userId,
        githubAuthor,
        slackIdentity: slackIdentity ?? undefined
      });
    }

    if (invalidUserIds.length > 0) {
      await this.#postSubmitResult(
        userId,
        session.key,
        "Some selected co-authors still have an invalid `Name <email>` value. Re-open the Slack prompt and fix them."
      );
      return;
    }

    await this.#sessions.confirmCoAuthors(session.channelId, session.rootThreadTs, {
      userIds: selectedUserIds,
      candidateRevision: metadata.candidateRevision
    });
    await this.#postSubmitResult(userId, session.key, "Co-author mapping saved. The next commit retry can continue.");
  }

  async #ensurePrompt(session: SlackSessionRecord): Promise<void> {
    const candidateRevision = session.coAuthorCandidateRevision;
    if (!candidateRevision || (session.coAuthorCandidateUserIds ?? []).length === 0) {
      return;
    }

    const promptAtMs = session.coAuthorPromptedAt ? Date.parse(session.coAuthorPromptedAt) : Number.NaN;
    const promptedRecently =
      session.coAuthorPromptRevision === candidateRevision &&
      Number.isFinite(promptAtMs) &&
      Date.now() - promptAtMs < PROMPT_COOLDOWN_MS;
    if (promptedRecently) {
      return;
    }

    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Git commit paused:* this Slack session needs co-author confirmation before the commit can go through."
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Configure co-authors"
            },
            action_id: COAUTHOR_CONFIGURE_ACTION_ID,
            value: JSON.stringify({
              session_key: session.key,
              candidate_revision: candidateRevision
            })
          }
        ]
      }
    ];

    let delivered = false;
    for (const userId of session.coAuthorCandidateUserIds ?? []) {
      try {
        await this.#slackApi.postEphemeral({
          channelId: session.channelId,
          threadTs: session.rootThreadTs,
          userId,
          text: "This commit is waiting on Slack co-author confirmation.",
          blocks
        });
        delivered = true;
      } catch (error) {
        logger.warn("Failed to post Slack co-author prompt", {
          sessionKey: session.key,
          userId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (delivered) {
      await this.#sessions.markCoAuthorPrompted(session.channelId, session.rootThreadTs, candidateRevision);
    }
  }

  async #buildModalView(session: SlackSessionRecord): Promise<Record<string, unknown>> {
    const candidateUserIds = session.coAuthorCandidateUserIds ?? [];
    const selectedUserIds = session.coAuthorConfirmedRevision === session.coAuthorCandidateRevision
      ? (session.coAuthorConfirmedUserIds ?? [])
      : candidateUserIds;
    const identities = await Promise.all(candidateUserIds.map(async (userId) => {
      const identity = await this.#slackApi.getUserIdentity(userId);
      if (identity) {
        await this.#mappings.recordObservedIdentity(identity);
      }
      return identity;
    }));
    const contributorOptions = candidateUserIds.map((userId, index) => {
      const identity = identities[index];
      return {
        text: {
          type: "plain_text",
          text: describeSlackUser(identity, userId)
        },
        value: userId
      };
    });

    return {
      type: "modal",
      callback_id: COAUTHOR_MODAL_CALLBACK_ID,
      private_metadata: JSON.stringify({
        session_key: session.key,
        candidate_revision: session.coAuthorCandidateRevision ?? 0
      }),
      title: {
        type: "plain_text",
        text: "Confirm co-authors"
      },
      submit: {
        type: "plain_text",
        text: "Save"
      },
      close: {
        type: "plain_text",
        text: "Cancel"
      },
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "Choose which Slack participants should be written as GitHub co-authors for commits from this session."
          }
        },
        {
          type: "input",
          block_id: CONTRIBUTOR_BLOCK_ID,
          label: {
            type: "plain_text",
            text: "Contributors"
          },
          element: {
            type: "checkboxes",
            action_id: CONTRIBUTOR_ACTION_ID,
            options: contributorOptions,
            initial_options: contributorOptions.filter((entry) => selectedUserIds.includes(String(entry.value)))
          }
        },
        ...candidateUserIds.map((userId, index) => {
          const identity = identities[index];
          const initialValue = this.#mappings.getMapping(userId)?.githubAuthor ?? "";
          return {
            type: "input",
            block_id: authorBlockId(userId),
            optional: true,
            label: {
              type: "plain_text",
              text: `${describeSlackUser(identity, userId)} GitHub author`
            },
            element: {
              type: "plain_text_input",
              action_id: "value",
              initial_value: initialValue,
              placeholder: {
                type: "plain_text",
                text: "Name <email@example.com>"
              }
            }
          };
        })
      ]
    };
  }

  async #resolveContributorIdentities(input: SlackInputMessage): Promise<readonly SlackUserIdentity[]> {
    const identities = new Map<string, Awaited<ReturnType<SlackApi["getUserIdentity"]>>>();

    if (input.senderKind === "user") {
      identities.set(input.userId, await this.#slackApi.getUserIdentity(input.userId));
    }

    for (const message of input.batchMessages ?? []) {
      if (message.senderKind !== "user") {
        continue;
      }

      const sender = message.sender ?? await this.#slackApi.getUserIdentity(message.userId);
      identities.set(message.userId, sender);
    }

    return [...identities.values()].filter((identity): identity is NonNullable<typeof identity> => identity !== null);
  }

  async #postSubmitResult(
    userId: string | undefined,
    sessionKey: string,
    text: string
  ): Promise<void> {
    if (!userId) {
      return;
    }

    const session = this.#sessions.getSessionByKey(sessionKey);
    if (!session) {
      return;
    }

    await this.#slackApi.postEphemeral({
      channelId: session.channelId,
      threadTs: session.rootThreadTs,
      userId,
      text
    }).catch((error) => {
      logger.warn("Failed to post Slack co-author modal result", {
        sessionKey,
        userId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parsePrivateMetadata(value: unknown): { sessionKey: string; candidateRevision: number } | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as {
      session_key?: string;
      candidate_revision?: number;
    };
    const sessionKey = readString(parsed.session_key);
    const candidateRevision = Number(parsed.candidate_revision);
    if (!sessionKey || !Number.isFinite(candidateRevision)) {
      return null;
    }

    return {
      sessionKey,
      candidateRevision
    };
  } catch {
    return null;
  }
}

function readSelectedContributorUserIds(
  values: Record<string, Record<string, Record<string, unknown>>>
): string[] {
  const selectedOptions = values[CONTRIBUTOR_BLOCK_ID]?.[CONTRIBUTOR_ACTION_ID]?.selected_options;
  if (!Array.isArray(selectedOptions)) {
    return [];
  }

  return selectedOptions
    .map((entry) => readString((entry as { value?: string } | undefined)?.value))
    .filter((value): value is string => Boolean(value));
}

function readGitHubAuthorInput(
  values: Record<string, Record<string, Record<string, unknown>>>,
  userId: string
): string | undefined {
  return readString(values[authorBlockId(userId)]?.value?.value);
}

function authorBlockId(userId: string): string {
  return `author__${userId}`;
}

function describeSlackUser(
  identity: {
    readonly userId: string;
    readonly displayName?: string | undefined;
    readonly realName?: string | undefined;
    readonly username?: string | undefined;
    readonly email?: string | undefined;
  } | null | undefined,
  fallbackUserId: string
): string {
  const label = identity?.realName || identity?.displayName || identity?.username || fallbackUserId;
  if (identity?.email) {
    return `${label} (${identity.email})`;
  }
  return label;
}
