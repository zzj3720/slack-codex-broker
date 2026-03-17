import http from "node:http";
import { URL } from "node:url";

import type { AppConfig } from "../config.js";
import type { AdminService } from "../services/admin-service.js";
import type { JobManager } from "../services/job-manager.js";
import type { SlackCodexBridge } from "../services/slack/slack-codex-bridge.js";
import { handleAdminRequest } from "./admin-routes.js";
import { handleJobRequest } from "./job-routes.js";
import { handleSlackRequest } from "./slack-routes.js";

export function createHttpHandler(options: {
  readonly adminService: AdminService;
  readonly bridge: SlackCodexBridge;
  readonly jobManager: JobManager;
  readonly config: AppConfig;
}): (request: http.IncomingMessage, response: http.ServerResponse) => void {
  return (request, response) => {
    void handleHttpRequest(request, response, options);
  };
}

async function handleHttpRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: {
    readonly adminService: AdminService;
    readonly bridge: SlackCodexBridge;
    readonly jobManager: JobManager;
    readonly config: AppConfig;
  }
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (await handleSlackRequest(method, url, request, response, options)) {
    return;
  }

  if (await handleJobRequest(method, url, request, response, options)) {
    return;
  }

  if (await handleAdminRequest(method, url, request, response, options)) {
    return;
  }

  if (method !== "GET") {
    response.writeHead(405, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: "method_not_allowed" }));
    return;
  }

  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true, service: options.config.serviceName }));
}
