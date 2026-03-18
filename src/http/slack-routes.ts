import http from "node:http";
import { URL } from "node:url";

import type { AppConfig } from "../config.js";
import { logger } from "../logger.js";
import type { SlackCodexBridge } from "../services/slack/slack-codex-bridge.js";
import {
  readFormBody,
  respondJson
} from "./common.js";

export async function handleSlackRequest(
  method: string,
  url: URL,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: {
    readonly bridge: SlackCodexBridge;
    readonly config: AppConfig;
  }
): Promise<boolean> {
  if (method === "GET" && url.pathname === "/slack/thread-history") {
    await handleSlackThreadHistoryRequest(url, response, options);
    return true;
  }

  if (method === "GET" && url.pathname === "/slack/replay-thread-message") {
    await handleSlackReplayThreadMessageRequest(url, response, options);
    return true;
  }

  if (method === "POST" && url.pathname === "/slack/resume-pending-session") {
    await handleSlackResumePendingSessionRequest(request, response, options);
    return true;
  }

  if (method === "POST" && url.pathname === "/slack/post-message") {
    await handleSlackPostMessageRequest(request, response, options);
    return true;
  }

  if (method === "POST" && url.pathname === "/slack/post-state") {
    await handleSlackPostStateRequest(request, response, options);
    return true;
  }

  if (method === "POST" && url.pathname === "/slack/post-file") {
    await handleSlackPostFileRequest(request, response, options);
    return true;
  }

  return false;
}

async function handleSlackThreadHistoryRequest(
  url: URL,
  response: http.ServerResponse,
  options: {
    readonly bridge: SlackCodexBridge;
    readonly config: AppConfig;
  }
): Promise<void> {
  const channelId = url.searchParams.get("channel_id");
  const rootThreadTs = url.searchParams.get("thread_ts");

  if (!channelId || !rootThreadTs) {
    respondJson(response, 400, {
      ok: false,
      error: "missing_required_query",
      required: ["channel_id", "thread_ts"]
    });
    return;
  }

  const limitParam = url.searchParams.get("limit");
  const parsedLimit = limitParam == null ? undefined : Number(limitParam);

  if (limitParam != null && !Number.isFinite(parsedLimit)) {
    respondJson(response, 400, { ok: false, error: "invalid_limit" });
    return;
  }

  try {
    const result = await options.bridge.readThreadHistory({
      channelId,
      rootThreadTs,
      beforeMessageTs: url.searchParams.get("before_ts") ?? undefined,
      channelType: url.searchParams.get("channel_type") ?? undefined,
      limit: parsedLimit
    });
    const responseFormat = url.searchParams.get("format") ?? "json";

    if (responseFormat === "text") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end(result.formattedText ?? "No earlier Slack thread history matched the request.");
      return;
    }

    respondJson(response, 200, {
      ok: true,
      channelId,
      rootThreadTs,
      beforeMessageTs: url.searchParams.get("before_ts") ?? undefined,
      returnedCount: result.messages.length,
      hasMore: result.hasMore,
      maxLimit: options.config.slackHistoryApiMaxLimit,
      formattedText: result.formattedText,
      messages: result.messages
    });
  } catch (error) {
    respondJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function handleSlackReplayThreadMessageRequest(
  url: URL,
  response: http.ServerResponse,
  options: {
    readonly bridge: SlackCodexBridge;
  }
): Promise<void> {
  const channelId = url.searchParams.get("channel_id");
  const rootThreadTs = url.searchParams.get("thread_ts");
  const messageTs = url.searchParams.get("message_ts");

  if (!channelId || !rootThreadTs || !messageTs) {
    respondJson(response, 400, {
      ok: false,
      error: "missing_required_query",
      required: ["channel_id", "thread_ts", "message_ts"]
    });
    return;
  }

  try {
    const replayed = await options.bridge.replayThreadMessage({
      channelId,
      rootThreadTs,
      messageTs
    });

    if (!replayed) {
      respondJson(response, 404, {
        ok: false,
        error: "message_not_replayed"
      });
      return;
    }

    respondJson(response, 200, {
      ok: true,
      replayed
    });
  } catch (error) {
    respondJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function handleSlackPostMessageRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: {
    readonly bridge: SlackCodexBridge;
  }
): Promise<void> {
  let body: Record<string, string>;

  try {
    body = await readFormBody(request);
  } catch (error) {
    respondJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }
  logger.raw("http-requests", {
    method: "POST",
    path: "/slack/post-message",
    body
  }, {
    channelId: body.channel_id,
    rootThreadTs: body.thread_ts
  });

  const channelId = body.channel_id;
  const rootThreadTs = body.thread_ts;
  const text = body.text?.trim();
  const kind = body.kind?.trim();
  const reason = body.reason?.trim() || body.stop_reason?.trim() || undefined;

  if (!channelId || !rootThreadTs || !text) {
    respondJson(response, 400, {
      ok: false,
      error: "missing_required_body",
      required: ["channel_id", "thread_ts", "text"]
    });
    return;
  }

  if (kind && !["progress", "final", "block", "wait"].includes(kind)) {
    respondJson(response, 400, {
      ok: false,
      error: "invalid_kind",
      allowed: ["progress", "final", "block", "wait"]
    });
    return;
  }

  if ((kind === "block" || kind === "wait") && !reason) {
    respondJson(response, 400, {
      ok: false,
      error: "missing_reason",
      required: ["reason"]
    });
    return;
  }

  try {
    await options.bridge.postSlackMessage({
      channelId,
      rootThreadTs,
      text,
      kind: kind as "progress" | "final" | "block" | "wait" | undefined,
      reason
    });
    respondJson(response, 200, { ok: true });
  } catch (error) {
    respondJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function handleSlackPostStateRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: {
    readonly bridge: SlackCodexBridge;
  }
): Promise<void> {
  let body: Record<string, string>;

  try {
    body = await readFormBody(request);
  } catch (error) {
    respondJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  logger.raw("http-requests", {
    method: "POST",
    path: "/slack/post-state",
    body
  }, {
    channelId: body.channel_id,
    rootThreadTs: body.thread_ts
  });

  const channelId = body.channel_id;
  const rootThreadTs = body.thread_ts;
  const kind = body.kind?.trim();
  const reason = body.reason?.trim() || body.stop_reason?.trim() || undefined;

  if (!channelId || !rootThreadTs || !kind) {
    respondJson(response, 400, {
      ok: false,
      error: "missing_required_body",
      required: ["channel_id", "thread_ts", "kind"]
    });
    return;
  }

  if (kind !== "wait" && kind !== "block" && kind !== "final") {
    respondJson(response, 400, {
      ok: false,
      error: "invalid_kind",
      allowed: ["wait", "block", "final"]
    });
    return;
  }

  if ((kind === "wait" || kind === "block") && !reason) {
    respondJson(response, 400, {
      ok: false,
      error: "missing_reason",
      required: ["reason"]
    });
    return;
  }

  try {
    await options.bridge.postSlackState({
      channelId,
      rootThreadTs,
      kind: kind as "wait" | "block" | "final",
      reason
    });
    respondJson(response, 200, { ok: true });
  } catch (error) {
    respondJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function handleSlackResumePendingSessionRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: {
    readonly bridge: SlackCodexBridge;
  }
): Promise<void> {
  let body: Record<string, string>;

  try {
    body = await readFormBody(request);
  } catch (error) {
    respondJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  logger.raw("http-requests", {
    method: "POST",
    path: "/slack/resume-pending-session",
    body
  }, {
    channelId: body.channel_id,
    rootThreadTs: body.thread_ts
  });

  const channelId = body.channel_id;
  const rootThreadTs = body.thread_ts;
  const forceReset = body.force_reset !== "false";

  if (!channelId || !rootThreadTs) {
    respondJson(response, 400, {
      ok: false,
      error: "missing_required_body",
      required: ["channel_id", "thread_ts"]
    });
    return;
  }

  try {
    const result = await options.bridge.resumePendingSession({
      channelId,
      rootThreadTs,
      forceReset
    });

    if (!result) {
      respondJson(response, 404, {
        ok: false,
        error: "session_not_found"
      });
      return;
    }

    respondJson(response, 200, {
      ok: true,
      ...result
    });
  } catch (error) {
    respondJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function handleSlackPostFileRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: {
    readonly bridge: SlackCodexBridge;
  }
): Promise<void> {
  let body: Record<string, string>;

  try {
    body = await readFormBody(request);
  } catch (error) {
    respondJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }
  logger.raw("http-requests", {
    method: "POST",
    path: "/slack/post-file",
    body: {
      ...body,
      content_base64: body.content_base64 ? `[base64:${body.content_base64.length}]` : undefined
    }
  }, {
    channelId: body.channel_id,
    rootThreadTs: body.thread_ts
  });

  const channelId = body.channel_id;
  const rootThreadTs = body.thread_ts;
  const filePath = body.file_path?.trim() || undefined;
  const contentBase64 = body.content_base64?.trim() || undefined;
  const filename = body.filename?.trim() || undefined;
  const initialComment = (body.initial_comment ?? body.text)?.trim() || undefined;

  if (!channelId || !rootThreadTs || (!filePath && !contentBase64)) {
    respondJson(response, 400, {
      ok: false,
      error: "missing_required_body",
      required: ["channel_id", "thread_ts", "file_path|content_base64"]
    });
    return;
  }

  try {
    const uploaded = await options.bridge.postSlackFile({
      channelId,
      rootThreadTs,
      filePath,
      contentBase64,
      filename,
      title: body.title?.trim() || undefined,
      initialComment,
      altText: body.alt_text?.trim() || undefined,
      snippetType: body.snippet_type?.trim() || undefined,
      contentType: body.content_type?.trim() || undefined
    });
    respondJson(response, 200, {
      ok: true,
      file: uploaded
    });
  } catch (error) {
    respondJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
