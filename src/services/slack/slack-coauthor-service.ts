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
  inferGitHubAuthorFromSlackIdentity,
  isValidGitHubAuthor,
  normalizeEmail
} from "../git/github-author-utils.js";
import { SlackApi } from "./slack-api.js";

const PROMPT_COOLDOWN_MS = 5 * 60 * 1_000;
const COAUTHOR_CONFIGURE_ACTION_ID = "coauthor_configure";
const COAUTHOR_MODAL_CALLBACK_ID = "coauthor_confirm";
const CONTRIBUTOR_BLOCK_ID = "contributors";
const CONTRIBUTOR_ACTION_ID = "selected";
const COMMIT_BEHAVIOR_BLOCK_ID = "commit_behavior";
const COMMIT_BEHAVIOR_ACTION_ID = "selected";
const IGNORE_MISSING_OPTION_VALUE = "ignore_missing";

export interface ResolveCommitCoauthorsResult {
  readonly status: "noop" | "blocked" | "resolved";
  readonly sessionKey?: string | undefined;
  readonly message?: string | undefined;
  readonly errorCode?: string | undefined;
  readonly coAuthors?: readonly string[] | undefined;
}

interface CommitCoauthorCandidateStatus {
  readonly userId: string;
  readonly mention: string;
  readonly username?: string | undefined;
  readonly displayName?: string | undefined;
  readonly realName?: string | undefined;
  readonly email?: string | undefined;
  readonly githubAuthor?: string | undefined;
  readonly githubAuthorSource?: "manual" | "slack_inferred" | undefined;
  readonly selected: boolean;
}

interface CommitCoauthorStatus {
  readonly sessionKey: string;
  readonly channelId: string;
  readonly rootThreadTs: string;
  readonly workspacePath: string;
  readonly candidateRevision?: number | undefined;
  readonly selectionMode: "default_all_candidates" | "explicit";
  readonly ignoreMissing: boolean;
  readonly needsUserInput: boolean;
  readonly canCommitDirectly: boolean;
  readonly selectedUserIds: readonly string[];
  readonly resolvedCoAuthors: readonly string[];
  readonly missingSelectedUserIds: readonly string[];
  readonly candidates: readonly CommitCoauthorCandidateStatus[];
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

  async getCommitCoauthorStatus(cwd: string): Promise<CommitCoauthorStatus | null> {
    await this.#mappings.load();
    const session = this.#sessions.findSessionByWorkspace(cwd);
    if (!session) {
      return null;
    }

    return await this.#buildCommitCoauthorStatus(session);
  }

  async configureSessionCoauthors(options: {
    readonly cwd: string;
    readonly coauthors?: readonly string[] | undefined;
    readonly userIds?: readonly string[] | undefined;
    readonly ignoreMissing?: boolean | undefined;
    readonly mappings?: ReadonlyArray<{
      readonly slackUserId?: string | undefined;
      readonly slackUser?: string | undefined;
      readonly githubAuthor: string;
    }> | undefined;
  }): Promise<CommitCoauthorStatus | null> {
    await this.#mappings.load();
    let session = this.#sessions.findSessionByWorkspace(options.cwd);
    if (!session) {
      return null;
    }

    let status = await this.#buildCommitCoauthorStatus(session);

    for (const entry of options.mappings ?? []) {
      const slackUserId = entry.slackUserId?.trim() || this.#resolveUserReference(status, entry.slackUser);
      if (!slackUserId) {
        throw new Error(`Unable to resolve co-author mapping target: ${entry.slackUser ?? entry.slackUserId ?? "unknown"}`);
      }

      const slackIdentity = await this.#slackApi.getUserIdentity(slackUserId);
      await this.#mappings.upsertManualMapping({
        slackUserId,
        githubAuthor: entry.githubAuthor,
        slackIdentity: slackIdentity ?? undefined
      });
    }

    status = await this.#buildCommitCoauthorStatus(session);
    const selectedUserIds = this.#resolveRequestedUserIds(status, {
      coauthors: options.coauthors,
      userIds: options.userIds
    });

    if (selectedUserIds !== undefined || options.ignoreMissing !== undefined) {
      session = await this.#sessions.confirmCoAuthors(session.channelId, session.rootThreadTs, {
        userIds: selectedUserIds ?? status.selectedUserIds,
        candidateRevision: session.coAuthorCandidateRevision ?? 0,
        ignoreMissing: options.ignoreMissing ?? status.ignoreMissing
      });
      status = await this.#buildCommitCoauthorStatus(session);
    }

    return status;
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

    const status = await this.#buildCommitCoauthorStatus(session);
    if (status.selectedUserIds.length === 0) {
      return {
        status: "noop",
        sessionKey: session.key
      };
    }

    if (status.needsUserInput) {
      await this.#ensurePrompt(session, status);
    }

    const coAuthors = status.resolvedCoAuthors;
    const commitMessage = appendCoAuthorTrailers(options.commitMessage, {
      coAuthors,
      primaryAuthorEmail: options.primaryAuthorEmail
    });

    if (commitMessage === options.commitMessage) {
      return {
        status: "noop",
        sessionKey: session.key,
        coAuthors,
        message:
          status.missingSelectedUserIds.length > 0
            ? "Some selected co-authors are still missing GitHub author info and were skipped for this commit."
            : undefined
      };
    }

    return {
      status: "resolved",
      sessionKey: session.key,
      coAuthors,
      commitMessage,
      message:
        status.missingSelectedUserIds.length > 0
          ? "Known co-authors were appended. Unresolved co-authors were skipped for this commit."
          : undefined
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
    const ignoreMissing = readIgnoreMissingSelection(values);
    const invalidUserIds: string[] = [];

    await this.#mappings.load();
    for (const userId of selectedUserIds) {
      const githubAuthor = readGitHubAuthorInput(values, userId);
      if (!githubAuthor) {
        if (ignoreMissing) {
          continue;
        }
        invalidUserIds.push(userId);
        continue;
      }

      if (!isValidGitHubAuthor(githubAuthor)) {
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
      const invalidLabels = await Promise.all(
        invalidUserIds.map(async (invalidUserId) => describeSlackUser(
          await this.#slackApi.getUserIdentity(invalidUserId),
          invalidUserId
        ))
      );
      await this.#postSubmitResult(
        userId,
        session.key,
        `These selected co-authors need a valid GitHub author in \`Name <email>\` format: ${invalidLabels.join(", ")}. If Slack cannot infer an email for someone, enter it manually.`
      );
      return;
    }

    await this.#sessions.confirmCoAuthors(session.channelId, session.rootThreadTs, {
      userIds: selectedUserIds,
      candidateRevision: metadata.candidateRevision,
      ignoreMissing
    });
    await this.#postSubmitResult(
      userId,
      session.key,
      ignoreMissing
        ? "Co-author settings saved. Commits can continue and any unresolved co-authors will be skipped."
        : "Co-author mapping saved. The next commit retry can continue."
    );
  }

  async #ensurePrompt(session: SlackSessionRecord, status?: CommitCoauthorStatus): Promise<void> {
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

    const currentStatus = status ?? await this.#buildCommitCoauthorStatus(session);
    const missingNames = currentStatus.missingSelectedUserIds
      .map((userId) => currentStatus.candidates.find((candidate) => candidate.userId === userId))
      .filter((candidate): candidate is CommitCoauthorCandidateStatus => candidate !== undefined)
      .map((candidate) => describeSlackUser(candidate, candidate.userId));

    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            missingNames.length > 0
              ? `*Co-author info is incomplete:* commits can continue, but these co-authors are currently unresolved and will be skipped: ${missingNames.join(", ")}.`
              : "*Co-author review available:* known Slack identities will be appended automatically for this session's commits."
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
          text: "Review Slack co-author settings for this session.",
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
            text: "Choose which Slack participants should be written as GitHub co-authors for commits from this session. Known identities are used automatically; unresolved selections can be ignored if you want commits to continue without them."
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
        {
          type: "input",
          block_id: COMMIT_BEHAVIOR_BLOCK_ID,
          optional: true,
          label: {
            type: "plain_text",
            text: "Commit behavior"
          },
          element: {
            type: "checkboxes",
            action_id: COMMIT_BEHAVIOR_ACTION_ID,
            options: [
              {
                text: {
                  type: "plain_text",
                  text: "Allow commits to continue without unresolved co-authors"
                },
                value: IGNORE_MISSING_OPTION_VALUE
              }
            ],
            initial_options:
              session.coAuthorIgnoreMissingRevision === session.coAuthorCandidateRevision
                ? [
                    {
                      text: {
                        type: "plain_text",
                        text: "Allow commits to continue without unresolved co-authors"
                      },
                      value: IGNORE_MISSING_OPTION_VALUE
                    }
                  ]
                : []
          }
        },
        ...candidateUserIds.map((userId, index) => {
          const identity = identities[index];
          const initialValue =
            this.#mappings.getMapping(userId)?.githubAuthor ??
            (identity ? inferGitHubAuthorFromSlackIdentity(identity) : undefined) ??
            "";
          return {
            type: "input",
            block_id: authorBlockId(userId),
            optional: true,
            label: {
              type: "plain_text",
              text: `${describeSlackUser(identity, userId)} GitHub author`
            },
            hint: {
              type: "plain_text",
              text: buildGitHubAuthorHint(identity, Boolean(initialValue))
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

  async #buildCommitCoauthorStatus(session: SlackSessionRecord): Promise<CommitCoauthorStatus> {
    const candidateUserIds = session.coAuthorCandidateUserIds ?? [];
    const explicitSelection = session.coAuthorConfirmedRevision === session.coAuthorCandidateRevision;
    const selectedUserIds = explicitSelection
      ? (session.coAuthorConfirmedUserIds ?? [])
      : candidateUserIds;
    const ignoreMissing = session.coAuthorIgnoreMissingRevision === session.coAuthorCandidateRevision;
    const candidates = await Promise.all(candidateUserIds.map(async (userId) => {
      const identity = await this.#slackApi.getUserIdentity(userId);
      let mapping = this.#mappings.getMapping(userId);
      if (!mapping && identity) {
        mapping = await this.#mappings.recordObservedIdentity(identity) ?? undefined;
      }

      return {
        userId,
        mention: identity?.mention ?? `<@${userId}>`,
        username: identity?.username,
        displayName: identity?.displayName,
        realName: identity?.realName,
        email: identity?.email,
        githubAuthor: mapping?.githubAuthor,
        githubAuthorSource: mapping?.source,
        selected: selectedUserIds.includes(userId)
      } satisfies CommitCoauthorCandidateStatus;
    }));

    const selectedCandidates = candidates.filter((candidate) => candidate.selected);
    const missingSelectedUserIds = selectedCandidates
      .filter((candidate) => !candidate.githubAuthor)
      .map((candidate) => candidate.userId);
    const resolvedCoAuthors = selectedCandidates
      .map((candidate) => candidate.githubAuthor)
      .filter((value): value is string => Boolean(value));

    return {
      sessionKey: session.key,
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs,
      workspacePath: session.workspacePath,
      candidateRevision: session.coAuthorCandidateRevision,
      selectionMode: explicitSelection ? "explicit" : "default_all_candidates",
      ignoreMissing,
      needsUserInput: missingSelectedUserIds.length > 0 && !ignoreMissing,
      canCommitDirectly: missingSelectedUserIds.length === 0,
      selectedUserIds,
      resolvedCoAuthors,
      missingSelectedUserIds,
      candidates
    };
  }

  #resolveRequestedUserIds(
    status: CommitCoauthorStatus,
    options: {
      readonly coauthors?: readonly string[] | undefined;
      readonly userIds?: readonly string[] | undefined;
    }
  ): string[] | undefined {
    const resolved = new Set<string>();

    for (const userId of options.userIds ?? []) {
      const trimmed = userId.trim();
      if (!trimmed) {
        continue;
      }

      if (!status.candidates.some((candidate) => candidate.userId === trimmed)) {
        throw new Error(`Unknown co-author candidate: ${userId}`);
      }
      resolved.add(trimmed);
    }

    for (const reference of options.coauthors ?? []) {
      const userId = this.#resolveUserReference(status, reference);
      if (!userId) {
        throw new Error(`Unable to resolve co-author candidate: ${reference}`);
      }
      resolved.add(userId);
    }

    if ((options.userIds?.length ?? 0) === 0 && (options.coauthors?.length ?? 0) === 0) {
      return undefined;
    }

    return [...resolved];
  }

  #resolveUserReference(status: CommitCoauthorStatus, reference: string | undefined): string | undefined {
    const normalized = normalizeUserReference(reference);
    if (!normalized) {
      return undefined;
    }

    const matches = status.candidates.filter((candidate) => {
      const fields = [
        candidate.userId,
        candidate.mention,
        candidate.username,
        candidate.displayName,
        candidate.realName,
        candidate.email
      ];
      return fields.some((value) => normalizeUserReference(value) === normalized);
    });

    if (matches.length > 1) {
      throw new Error(`Ambiguous co-author reference: ${reference}`);
    }

    return matches[0]?.userId;
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

function readIgnoreMissingSelection(
  values: Record<string, Record<string, Record<string, unknown>>>
): boolean {
  const selectedOptions = values[COMMIT_BEHAVIOR_BLOCK_ID]?.[COMMIT_BEHAVIOR_ACTION_ID]?.selected_options;
  if (!Array.isArray(selectedOptions)) {
    return false;
  }

  return selectedOptions.some((entry) => {
    return readString((entry as { value?: string } | undefined)?.value) === IGNORE_MISSING_OPTION_VALUE;
  });
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

function buildGitHubAuthorHint(
  identity: {
    readonly email?: string | undefined;
  } | null | undefined,
  hasInitialValue: boolean
): string {
  if (hasInitialValue) {
    return "Used when this person is checked as a co-author.";
  }

  if (!normalizeEmail(identity?.email)) {
    return "Slack could not infer an email for this person. If checked, enter Name <email@example.com> manually.";
  }

  return "If checked, enter a GitHub author in the form Name <email@example.com>.";
}

function normalizeUserReference(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}
