import http from "node:http";
import { URL } from "node:url";

import type { JobManager } from "../services/job-manager.js";
import { logger } from "../logger.js";
import {
  parseJsonLike,
  readBoolean,
  readJsonBody,
  readString,
  respondJson
} from "./common.js";

export async function handleJobRequest(
  method: string,
  url: URL,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: {
    readonly jobManager: JobManager;
  }
): Promise<boolean> {
  if (method === "POST" && url.pathname === "/jobs/register") {
    await handleJobRegisterRequest(request, response, options);
    return true;
  }

  const matchedJobAction = matchJobAction(url.pathname);
  if (method === "POST" && matchedJobAction) {
    await handleJobActionRequest(request, response, options, matchedJobAction);
    return true;
  }

  return false;
}

async function handleJobRegisterRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: {
    readonly jobManager: JobManager;
  }
): Promise<void> {
  let body: Record<string, unknown>;

  try {
    body = await readJsonBody(request);
  } catch (error) {
    respondJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }
  logger.raw("http-requests", {
    method: "POST",
    path: "/jobs/register",
    body
  }, {
    channelId: readString(body.channel_id),
    rootThreadTs: readString(body.thread_ts)
  });

  const channelId = readString(body.channel_id);
  const rootThreadTs = readString(body.thread_ts);
  const kind = readString(body.kind);
  const script = readString(body.script);

  if (!channelId || !rootThreadTs || !kind || !script) {
    respondJson(response, 400, {
      ok: false,
      error: "missing_required_body",
      required: ["channel_id", "thread_ts", "kind", "script"]
    });
    return;
  }

  try {
    const job = await options.jobManager.registerJob({
      channelId,
      rootThreadTs,
      kind,
      script,
      cwd: readString(body.cwd) || undefined,
      shell: readString(body.shell) || undefined,
      restartOnBoot: readBoolean(body.restart_on_boot, true)
    });
    respondJson(response, 200, {
      ok: true,
      job: {
        id: job.id,
        token: job.token,
        status: job.status,
        kind: job.kind,
        cwd: job.cwd,
        shell: job.shell,
        scriptPath: job.scriptPath,
        restartOnBoot: job.restartOnBoot,
        channelId: job.channelId,
        rootThreadTs: job.rootThreadTs,
        createdAt: job.createdAt
      }
    });
  } catch (error) {
    respondJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function handleJobActionRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: {
    readonly jobManager: JobManager;
  },
  action: {
    readonly jobId: string;
    readonly action: "heartbeat" | "event" | "complete" | "fail" | "cancel";
  }
): Promise<void> {
  let body: Record<string, unknown>;

  try {
    body = await readJsonBody(request);
  } catch (error) {
    respondJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }
  logger.raw("http-requests", {
    method: "POST",
    path: `/jobs/${action.jobId}/${action.action}`,
    body
  }, {
    jobId: action.jobId
  });

  const token = readString(body.token);

  try {
    let job;

    switch (action.action) {
      case "heartbeat":
        if (!token) {
          throw new Error("missing_job_token");
        }
        job = await options.jobManager.heartbeatJob(action.jobId, token);
        break;
      case "event":
        if (!token) {
          throw new Error("missing_job_token");
        }
        if (!readString(body.event_kind) || !readString(body.summary)) {
          throw new Error("missing_required_body:event_kind,summary");
        }
        job = await options.jobManager.emitJobEvent(action.jobId, token, {
          eventKind: readString(body.event_kind)!,
          summary: readString(body.summary)!,
          detailsText: readString(body.details_text) || undefined,
          detailsJson: parseJsonLike(body.details_json)
        });
        break;
      case "complete":
        if (!token) {
          throw new Error("missing_job_token");
        }
        job = await options.jobManager.completeJob(action.jobId, token, {
          summary: readString(body.summary) || undefined,
          detailsText: readString(body.details_text) || undefined,
          detailsJson: parseJsonLike(body.details_json)
        });
        break;
      case "fail":
        if (!token) {
          throw new Error("missing_job_token");
        }
        job = await options.jobManager.failJob(action.jobId, token, {
          summary: readString(body.summary) || undefined,
          error: readString(body.error) || undefined,
          detailsText: readString(body.details_text) || undefined,
          detailsJson: parseJsonLike(body.details_json)
        });
        break;
      case "cancel":
        if (!token) {
          throw new Error("missing_job_token");
        }
        job = await options.jobManager.cancelJob(action.jobId, token);
        break;
    }

    respondJson(response, 200, {
      ok: true,
      job
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    respondJson(response, message.startsWith("missing_") || message === "invalid_job_token" ? 400 : 500, {
      ok: false,
      error: message
    });
  }
}

function matchJobAction(pathname: string): {
  readonly jobId: string;
  readonly action: "heartbeat" | "event" | "complete" | "fail" | "cancel";
} | null {
  const match = pathname.match(/^\/jobs\/([^/]+)\/(heartbeat|event|complete|fail|cancel)$/);
  if (!match) {
    return null;
  }

  const [, jobId, action] = match;
  if (!jobId || !action) {
    return null;
  }

  return {
    jobId,
    action: action as "heartbeat" | "event" | "complete" | "fail" | "cancel"
  };
}
