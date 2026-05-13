import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";

import type { AppConfig } from "../config.js";
import type { AdminService } from "../services/admin-service.js";
import { readJsonBody, readString, respondJson } from "./common.js";
import { renderAdminPage } from "./admin-page.js";

export async function handleAdminRequest(
  method: string,
  url: URL,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: {
    readonly adminService: AdminService;
    readonly config: AppConfig;
  }
): Promise<boolean> {
  if (method === "GET" && isAdminSpaRoute(url.pathname)) {
    return serveAdminSpaIndex(response, options.config);
  }

  if (method === "GET" && url.pathname.startsWith("/admin/assets/")) {
    return serveAdminAsset(url, response);
  }

  if (!url.pathname.startsWith("/admin/api/")) {
    return false;
  }

  if (!isAuthorizedAdminRequest(request, options.config)) {
    respondJson(response, 401, {
      ok: false,
      error: "admin_auth_required"
    });
    return true;
  }

  if (method === "GET" && url.pathname === "/admin/api/overview") {
    respondJson(response, 200, await options.adminService.getOverview());
    return true;
  }

  if (method === "GET" && url.pathname === "/admin/api/sessions") {
    respondJson(response, 200, await options.adminService.listSessionSummaries());
    return true;
  }

  if (method === "GET" && url.pathname.startsWith("/admin/api/sessions/") && url.pathname.endsWith("/timeline")) {
    const sessionKey = decodeURIComponent(url.pathname.slice(
      "/admin/api/sessions/".length,
      -"/timeline".length
    ));
    if (!sessionKey || sessionKey.includes("/")) {
      return false;
    }

    respondJson(response, 200, await options.adminService.getSessionTimeline(sessionKey));
    return true;
  }

  if (method === "GET" && url.pathname.startsWith("/admin/api/sessions/") && url.pathname.endsWith("/github-identity")) {
    const sessionKey = decodeURIComponent(url.pathname.slice(
      "/admin/api/sessions/".length,
      -"/github-identity".length
    ));
    if (!sessionKey || sessionKey.includes("/")) {
      return false;
    }

    const result = await options.adminService.getSessionGitHubIdentity(sessionKey);
    respondJson(response, result.ok === false ? 404 : 200, result);
    return true;
  }

  if (
    method === "POST" &&
    url.pathname.startsWith("/admin/api/sessions/") &&
    url.pathname.endsWith("/github-oauth/device/start")
  ) {
    const sessionKey = decodeURIComponent(url.pathname.slice(
      "/admin/api/sessions/".length,
      -"/github-oauth/device/start".length
    ));
    if (!sessionKey || sessionKey.includes("/")) {
      return false;
    }

    await runAdminOperation(response, () =>
      options.adminService.startSessionGitHubDeviceAuthorization(sessionKey)
    );
    return true;
  }

  if (method === "GET" && url.pathname.startsWith("/admin/api/github-oauth/device/")) {
    const deviceAuthorizationId = decodeURIComponent(url.pathname.slice("/admin/api/github-oauth/device/".length));
    if (!deviceAuthorizationId || deviceAuthorizationId.includes("/")) {
      return false;
    }

    await runAdminOperation(response, () =>
      options.adminService.pollGitHubDeviceAuthorization(deviceAuthorizationId)
    );
    return true;
  }

  if (method === "POST" && url.pathname.startsWith("/admin/api/sessions/") && url.pathname.endsWith("/auth-profile")) {
    const sessionKey = decodeURIComponent(url.pathname.slice(
      "/admin/api/sessions/".length,
      -"/auth-profile".length
    ));
    if (!sessionKey || sessionKey.includes("/")) {
      return false;
    }

    const body = await readAdminBody(request, response);
    if (!body) {
      return true;
    }

    const name = readString(body.name);
    const mode = readString(body.mode);
    const autoMode = mode === "auto";
    if (!name && !autoMode) {
      respondJson(response, 400, {
        ok: false,
        error: "missing_required_body",
        required: ["name", "mode=auto"]
      });
      return true;
    }

    await runAdminOperation(response, () =>
      options.adminService.switchSessionAuthProfile({
        sessionKey,
        ...(autoMode ? { mode: "auto" as const } : { name })
      })
    );
    return true;
  }

  if (method === "POST" && url.pathname.startsWith("/admin/api/sessions/") && url.pathname.endsWith("/reset")) {
    const sessionKey = decodeURIComponent(url.pathname.slice(
      "/admin/api/sessions/".length,
      -"/reset".length
    ));
    if (!sessionKey || sessionKey.includes("/")) {
      return false;
    }

    await runAdminOperation(response, () =>
      options.adminService.resetSession({
        sessionKey
      })
    );
    return true;
  }

  if (method === "GET" && url.pathname === "/admin/api/preflight") {
    respondJson(response, 200, await options.adminService.getOperationPreflight({
      operation: readString(url.searchParams.get("operation")) ?? "unknown"
    }));
    return true;
  }

  if (method === "GET" && url.pathname === "/admin/api/operations") {
    respondJson(response, 200, await options.adminService.listAdminOperations());
    return true;
  }

  if (method === "GET" && url.pathname === "/admin/api/usage") {
    respondJson(response, 200, await options.adminService.getUsageOverview());
    return true;
  }

  if (method === "GET" && url.pathname === "/admin/api/audit") {
    respondJson(response, 200, await options.adminService.listAdminAuditEvents({
      operationId: readString(url.searchParams.get("operation_id")) ?? undefined
    }));
    return true;
  }

  if (method === "GET" && url.pathname === "/admin/api/events") {
    streamAdminEvents(request, response, options.adminService, url);
    return true;
  }

  if (method === "GET" && url.pathname === "/admin/api/status") {
    respondJson(response, 200, await options.adminService.getStatus());
    return true;
  }

  if (method === "POST" && url.pathname === "/admin/api/auth-profiles") {
    const body = await readAdminBody(request, response);
    if (!body) {
      return true;
    }

    const name = readString(body.name) ?? undefined;
    const authJsonContent = readString(body.auth_json_content);
    if (!authJsonContent) {
      respondJson(response, 400, {
        ok: false,
        error: "missing_required_body",
        required: ["auth_json_content"]
      });
      return true;
    }

    await runAdminOperation(response, () =>
      options.adminService.addAuthProfile({
        name,
        authJsonContent
      })
    );
    return true;
  }

  if (method === "POST" && url.pathname === "/admin/api/auth-profiles/device-code/start") {
    await runAdminOperation(response, () =>
      options.adminService.startAuthProfileDeviceCode()
    );
    return true;
  }

  if (method === "POST" && url.pathname === "/admin/api/auth-profiles/device-code/complete") {
    const body = await readAdminBody(request, response);
    if (!body) {
      return true;
    }

    const name = readString(body.name) ?? undefined;
    const deviceAuthId = readString(body.device_auth_id);
    const userCode = readString(body.user_code);
    const retryAfterSeconds = readPositiveNumber(body.retry_after_seconds);
    if (!deviceAuthId || !userCode) {
      respondJson(response, 400, {
        ok: false,
        error: "missing_required_body",
        required: ["device_auth_id", "user_code"]
      });
      return true;
    }

    await runAdminOperation(response, () =>
      options.adminService.completeAuthProfileDeviceCode({
        name,
        deviceAuthId,
        userCode,
        retryAfterSeconds
      })
    );
    return true;
  }

  if (method === "POST" && url.pathname === "/admin/api/github-authors") {
    const body = await readAdminBody(request, response);
    if (!body) {
      return true;
    }

    const slackUserId = readString(body.slack_user_id);
    const githubAuthor = readString(body.github_author);
    if (!slackUserId || !githubAuthor) {
      respondJson(response, 400, {
        ok: false,
        error: "missing_required_body",
        required: ["slack_user_id", "github_author"]
      });
      return true;
    }

    await runAdminOperation(response, () =>
      options.adminService.upsertGitHubAuthorMapping({
        slackUserId,
        githubAuthor
      })
    );
    return true;
  }

  if (method === "POST" && url.pathname === "/admin/api/deploy") {
    const body = await readAdminBody(request, response);
    if (!body) {
      return true;
    }

    const ref = readString(body.ref);
    if (!ref) {
      respondJson(response, 400, {
        ok: false,
        error: "missing_required_body",
        required: ["ref"]
      });
      return true;
    }

    await runAdminOperation(response, () =>
      options.adminService.deployRelease({
        ref,
        allowActive: body.allow_active === true
      })
    );
    return true;
  }

  if (method === "POST" && url.pathname === "/admin/api/rollback") {
    const body = await readAdminBody(request, response);
    if (!body) {
      return true;
    }

    await runAdminOperation(response, () =>
      options.adminService.rollbackRelease({
        ref: readString(body.ref) ?? undefined,
        allowActive: body.allow_active === true
      })
    );
    return true;
  }

  if (method === "DELETE" && url.pathname.startsWith("/admin/api/auth-profiles/")) {
    const profileName = decodeURIComponent(url.pathname.slice("/admin/api/auth-profiles/".length));
    if (!profileName || profileName.includes("/")) {
      return false;
    }

    await runAdminOperation(response, () =>
      options.adminService.deleteAuthProfile({
        name: profileName
      })
    );
    return true;
  }

  if (method === "DELETE" && url.pathname.startsWith("/admin/api/github-authors/")) {
    const slackUserId = decodeURIComponent(url.pathname.slice("/admin/api/github-authors/".length));
    if (!slackUserId || slackUserId.includes("/")) {
      return false;
    }

    await runAdminOperation(response, () =>
      options.adminService.deleteGitHubAuthorMapping({
        slackUserId
      })
    );
    return true;
  }

  return false;
}

async function serveAdminSpaIndex(response: http.ServerResponse, config: AppConfig): Promise<boolean> {
  if (process.env.ADMIN_UI_DEV_ORIGIN) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(renderAdminPage({
      serviceName: config.serviceName
    }));
    return true;
  }

  const indexPath = await findAdminSpaIndex();
  if (indexPath) {
    const html = await fs.readFile(indexPath, "utf8");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(html);
    return true;
  }

  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(renderAdminPage({
    serviceName: config.serviceName
  }));
  return true;
}

async function findAdminSpaIndex(): Promise<string | null> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "..", "..", "admin-ui", "index.html"),
    path.resolve(moduleDir, "..", "..", "dist", "admin-ui", "index.html")
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  return null;
}

async function serveAdminAsset(url: URL, response: http.ServerResponse): Promise<boolean> {
  const assetName = decodeURIComponent(url.pathname.slice("/admin/assets/".length));
  if (!assetName || assetName.includes("\0")) {
    return false;
  }

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const assetRoots = [
    path.resolve(moduleDir, "..", "..", "admin-ui", "assets"),
    path.resolve(moduleDir, "..", "..", "dist", "admin-ui", "assets")
  ];

  for (const assetRoot of assetRoots) {
    const assetPath = path.resolve(assetRoot, assetName);
    if (!assetPath.startsWith(`${assetRoot}${path.sep}`)) {
      continue;
    }

    try {
      const content = await fs.readFile(assetPath);
      response.writeHead(200, {
        "content-type": contentTypeForAsset(assetPath),
        "cache-control": "no-store"
      });
      response.end(content);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: false, error: "admin_asset_not_found" }));
  return true;
}

function isAdminSpaRoute(pathname: string): boolean {
  return pathname === "/admin" || pathname === "/admin/" || pathname.startsWith("/admin/sessions/");
}

function contentTypeForAsset(assetPath: string): string {
  const extension = path.extname(assetPath).toLowerCase();
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".js") return "text/javascript; charset=utf-8";
  if (extension === ".map") return "application/json; charset=utf-8";
  if (extension === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

async function readAdminBody(
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<Record<string, unknown> | null> {
  try {
    return await readJsonBody(request);
  } catch (error) {
    respondJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

function readPositiveNumber(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : Number.NaN;
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

async function runAdminOperation(
  response: http.ServerResponse,
  operation: () => Promise<Record<string, unknown>>
): Promise<void> {
  try {
    respondJson(response, 200, await operation());
  } catch (error) {
    respondJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function streamAdminEvents(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  adminService: AdminService,
  url: URL
): void {
  let cursor = readEventCursor(url, request);
  let closed = false;
  let draining = false;

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  response.flushHeaders?.();

  const interval = setInterval(() => {
    void drain();
  }, 500);

  request.on("close", () => {
    closed = true;
    clearInterval(interval);
  });

  void drain();

  async function drain(): Promise<void> {
    if (closed || draining) {
      return;
    }
    draining = true;
    try {
      const payload = await adminService.listRealtimeEvents({
        afterSequence: cursor,
        limit: 100
      });
      const events = Array.isArray(payload.events) ? payload.events as Array<Record<string, unknown>> : [];
      for (const event of events) {
        const sequence = Number(event.sequence);
        if (!Number.isFinite(sequence)) {
          continue;
        }
        cursor = Math.max(cursor, sequence);
        response.write(`id: ${sequence}\n`);
        response.write("event: admin-event\n");
        response.write(`data: ${JSON.stringify({ ok: true, event })}\n\n`);
      }
    } catch (error) {
      response.write("event: admin-error\n");
      response.write(`data: ${JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })}\n\n`);
    } finally {
      draining = false;
    }
  }
}

function readEventCursor(url: URL, request: http.IncomingMessage): number {
  const fromQuery = Number(url.searchParams.get("after") ?? "");
  if (Number.isFinite(fromQuery) && fromQuery >= 0) {
    return Math.floor(fromQuery);
  }
  const fromHeader = request.headers["last-event-id"];
  const value = Array.isArray(fromHeader) ? fromHeader.at(-1) : fromHeader;
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function isAuthorizedAdminRequest(request: http.IncomingMessage, config: AppConfig): boolean {
  if (!config.brokerAdminToken) {
    return true;
  }

  const fromHeader = request.headers["x-admin-token"];
  if (typeof fromHeader === "string" && fromHeader === config.brokerAdminToken) {
    return true;
  }

  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length) === config.brokerAdminToken;
  }

  return false;
}
