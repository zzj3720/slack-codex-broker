export interface SlackSessionRecord {
  readonly key: string;
  readonly channelId: string;
  readonly channelName?: string | undefined;
  readonly channelType?: string | undefined;
  readonly rootThreadTs: string;
  readonly workspacePath: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly agentSessionId?: string | undefined;
  readonly activeTurnId?: string | undefined;
  readonly activeTurnStartedAt?: string | undefined;
  readonly lastObservedMessageTs?: string | undefined;
  readonly lastDeliveredMessageTs?: string | undefined;
  readonly lastSlackReplyAt?: string | undefined;
  readonly sessionPageLinkPostedAt?: string | undefined;
  readonly authProfileName?: string | undefined;
  readonly authProfileBoundAt?: string | undefined;
  readonly authBlockedAt?: string | undefined;
  readonly authBlockReason?: string | undefined;
  readonly authBlockedNoticePostedAt?: string | undefined;
  readonly lastTurnSignalTurnId?: string | undefined;
  readonly lastTurnSignalKind?: SlackTurnSignalKind | undefined;
  readonly lastTurnSignalReason?: string | undefined;
  readonly lastTurnSignalAt?: string | undefined;
  readonly coAuthorCandidateUserIds?: readonly string[] | undefined;
  readonly coAuthorCandidateRevision?: number | undefined;
  readonly coAuthorConfirmedUserIds?: readonly string[] | undefined;
  readonly coAuthorConfirmedRevision?: number | undefined;
  readonly coAuthorIgnoreMissingRevision?: number | undefined;
  readonly coAuthorPromptRevision?: number | undefined;
  readonly coAuthorPromptedAt?: string | undefined;
}

export type JsonLike =
  | null
  | boolean
  | number
  | string
  | JsonLike[]
  | { [key: string]: JsonLike };

export interface PersistedState {
  readonly sessions: SlackSessionRecord[];
  readonly processedEventIds: string[];
  readonly inboundMessages: PersistedInboundMessage[];
  readonly backgroundJobs: PersistedBackgroundJob[];
}

export type PersistedInboundMessageStatus = "pending" | "inflight" | "done";
export type SlackInboundSource = "app_mention" | "direct_message" | "thread_reply";
export type SyntheticInboundSource = "background_job_event" | "unexpected_turn_stop";
export type PersistedInboundSource = SlackInboundSource | SyntheticInboundSource;
export type PersistedSlackEventStatus = "pending" | "done";

export interface PersistedSlackEvent {
  readonly eventId: string;
  readonly payload: JsonLike;
  readonly status: PersistedSlackEventStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type SlackTurnSignalKind = "progress" | "final" | "block" | "wait";

export interface BackgroundJobEventPayload {
  readonly jobId: string;
  readonly jobKind: string;
  readonly eventKind: string;
  readonly summary: string;
  readonly detailsText?: string | undefined;
  readonly detailsJson?: JsonLike | undefined;
}

export interface UnexpectedTurnStopPayload {
  readonly turnId: string;
  readonly reason: string;
}

export interface PersistedInboundMessage {
  readonly key: string;
  readonly sessionKey: string;
  readonly channelId: string;
  readonly channelType?: string | undefined;
  readonly rootThreadTs: string;
  readonly messageTs: string;
  readonly source: PersistedInboundSource;
  readonly userId: string;
  readonly text: string;
  readonly senderKind?: SlackSenderKind | undefined;
  readonly botId?: string | undefined;
  readonly appId?: string | undefined;
  readonly senderUsername?: string | undefined;
  readonly mentionedUserIds?: readonly string[] | undefined;
  readonly mentionedUsers?: readonly SlackUserIdentity[] | undefined;
  readonly contextText?: string | undefined;
  readonly images?: readonly SlackImageAttachment[] | undefined;
  readonly slackMessage?: JsonLike | undefined;
  readonly backgroundJob?: BackgroundJobEventPayload | undefined;
  readonly unexpectedTurnStop?: UnexpectedTurnStopPayload | undefined;
  readonly status: PersistedInboundMessageStatus;
  readonly batchId?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type PersistedBackgroundJobStatus =
  | "registered"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface PersistedBackgroundJob {
  readonly id: string;
  readonly token: string;
  readonly sessionKey: string;
  readonly channelId: string;
  readonly rootThreadTs: string;
  readonly kind: string;
  readonly shell: string;
  readonly cwd: string;
  readonly scriptPath: string;
  readonly restartOnBoot: boolean;
  readonly status: PersistedBackgroundJobStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string | undefined;
  readonly heartbeatAt?: string | undefined;
  readonly completedAt?: string | undefined;
  readonly cancelledAt?: string | undefined;
  readonly exitCode?: number | undefined;
  readonly error?: string | undefined;
  readonly lastEventAt?: string | undefined;
  readonly lastEventKind?: string | undefined;
  readonly lastEventSummary?: string | undefined;
}

export type AdminOperationKind =
  | "deploy"
  | "rollback"
  | "auth_profile_add"
  | "auth_profile_delete"
  | "auth_profile_activate"
  | "session_auth_profile_switch"
  | "github_author_upsert"
  | "github_author_delete";

export type AdminOperationStatus = "running" | "succeeded" | "failed";

export interface PersistedAdminOperation {
  readonly id: string;
  readonly kind: AdminOperationKind;
  readonly status: AdminOperationStatus;
  readonly request: JsonLike;
  readonly result?: JsonLike | undefined;
  readonly error?: string | undefined;
  readonly actor?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string | undefined;
  readonly completedAt?: string | undefined;
}

export interface PersistedAdminAuditEvent {
  readonly id: string;
  readonly operationId?: string | undefined;
  readonly action: AdminOperationKind | string;
  readonly status: AdminOperationStatus | "started";
  readonly detail?: JsonLike | undefined;
  readonly actor?: string | undefined;
  readonly createdAt: string;
}

export interface PersistedAdminEvent {
  readonly sequence: number;
  readonly kind: string;
  readonly scope: "global" | "session";
  readonly sessionKey?: string | undefined;
  readonly entityId?: string | undefined;
  readonly payload: JsonLike;
  readonly createdAt: string;
}

export type AgentTurnUsageSource = "exact" | "estimated" | "missing";
export type PersistedAgentTurnStatus = "completed" | "interrupted" | "failed";

export interface AgentTurnTokenUsage {
  readonly source: AgentTurnUsageSource;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly rawUsage?: JsonLike | undefined;
}

export interface PersistedAgentTurnUsage {
  readonly turnId: string;
  readonly sessionKey: string;
  readonly channelId: string;
  readonly rootThreadTs: string;
  readonly agentSessionId?: string | undefined;
  readonly status: PersistedAgentTurnStatus;
  readonly source: AgentTurnUsageSource;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  readonly rawUsage?: JsonLike | undefined;
  readonly startedAt?: string | undefined;
  readonly completedAt?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PersistedAgentTraceEvent {
  readonly id: string;
  readonly sessionKey: string;
  readonly source: "broker" | "agent_runtime";
  readonly type: string;
  readonly at: string;
  readonly sequence: number;
  readonly title: string;
  readonly summary: string;
  readonly detail?: string | undefined;
  readonly status?: string | undefined;
  readonly role?: string | undefined;
  readonly toolName?: string | undefined;
  readonly callId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly detailTruncated?: boolean | undefined;
  readonly detailOriginalChars?: number | undefined;
  readonly metadata?: JsonLike | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SlackInputMessage {
  readonly channelId: string;
  readonly channelType?: string | undefined;
  readonly rootThreadTs: string;
  readonly messageTs?: string | undefined;
  readonly source: PersistedInboundSource | "recovered_thread_batch";
  readonly userId: string;
  readonly text: string;
  readonly senderKind?: SlackSenderKind | undefined;
  readonly botId?: string | undefined;
  readonly appId?: string | undefined;
  readonly senderUsername?: string | undefined;
  readonly mentionedUserIds?: readonly string[] | undefined;
  readonly mentionedUsers?: readonly SlackUserIdentity[] | undefined;
  readonly contextText?: string | undefined;
  readonly images?: readonly SlackImageAttachment[] | undefined;
  readonly slackMessage?: JsonLike | undefined;
  readonly backgroundJob?: BackgroundJobEventPayload | undefined;
  readonly unexpectedTurnStop?: UnexpectedTurnStopPayload | undefined;
  readonly recoveryKind?: "missed_thread_messages" | undefined;
  readonly batchMessages?: readonly SlackBatchInputMessage[] | undefined;
}

export interface SlackUserIdentity {
  readonly userId: string;
  readonly mention: string;
  readonly username?: string | undefined;
  readonly displayName?: string | undefined;
  readonly realName?: string | undefined;
  readonly email?: string | undefined;
}

export type GitHubAuthorMappingSource = "manual" | "slack_inferred";

export interface GitHubAuthorMappingRecord {
  readonly slackUserId: string;
  readonly githubAuthor: string;
  readonly source: GitHubAuthorMappingSource;
  readonly slackIdentity: SlackUserIdentity;
  readonly updatedAt: string;
}

export interface SlackBatchInputMessage {
  readonly messageTs?: string | undefined;
  readonly source: PersistedInboundSource;
  readonly userId: string;
  readonly text: string;
  readonly senderKind?: SlackSenderKind | undefined;
  readonly botId?: string | undefined;
  readonly appId?: string | undefined;
  readonly senderUsername?: string | undefined;
  readonly mentionedUserIds?: readonly string[] | undefined;
  readonly mentionedUsers?: readonly SlackUserIdentity[] | undefined;
  readonly images?: readonly SlackImageAttachment[] | undefined;
  readonly slackMessage?: JsonLike | undefined;
  readonly backgroundJob?: BackgroundJobEventPayload | undefined;
  readonly unexpectedTurnStop?: UnexpectedTurnStopPayload | undefined;
  readonly sender?: SlackUserIdentity | null | undefined;
}

export type SlackSenderKind = "user" | "bot" | "app" | "unknown";

export interface SlackImageAttachment {
  readonly fileId: string;
  readonly name?: string | undefined;
  readonly title?: string | undefined;
  readonly mimetype?: string | undefined;
  readonly filetype?: string | undefined;
  readonly size?: number | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly url: string;
  readonly localPath?: string | undefined;
  readonly downloadError?: string | undefined;
}

export interface SlackThreadMessage {
  readonly channelId: string;
  readonly channelType?: string | undefined;
  readonly rootThreadTs: string;
  readonly messageTs: string;
  readonly userId: string;
  readonly text: string;
  readonly senderKind?: SlackSenderKind | undefined;
  readonly botId?: string | undefined;
  readonly appId?: string | undefined;
  readonly senderUsername?: string | undefined;
  readonly mentionedUserIds?: readonly string[] | undefined;
  readonly images?: readonly SlackImageAttachment[] | undefined;
  readonly slackMessage?: JsonLike | undefined;
}

export interface ResolvedSlackThreadMessage extends SlackThreadMessage {
  readonly sender: SlackUserIdentity | null;
  readonly mentionedUsers?: readonly SlackUserIdentity[];
}

export interface GeneratedImageArtifact {
  readonly id: string;
  readonly contentBase64?: string | undefined;
  readonly contentType?: string | undefined;
  readonly savedPath?: string | undefined;
  readonly revisedPrompt?: string | undefined;
}
