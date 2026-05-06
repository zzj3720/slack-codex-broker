import http from "node:http";
import { URL } from "node:url";

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
  if (method === "GET" && url.pathname === "/admin") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(renderAdminPage({
      serviceName: options.config.serviceName
    }));
    return true;
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

  if (method === "GET" && url.pathname === "/admin/api/audit") {
    respondJson(response, 200, await options.adminService.listAdminAuditEvents({
      operationId: readString(url.searchParams.get("operation_id")) ?? undefined
    }));
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

  if (method === "POST" && url.pathname.startsWith("/admin/api/auth-profiles/") && url.pathname.endsWith("/activate")) {
    const profileName = decodeURIComponent(url.pathname.slice("/admin/api/auth-profiles/".length, -"/activate".length));
    const body = await readAdminBody(request, response);
    if (!body) {
      return true;
    }

    await runAdminOperation(response, () =>
      options.adminService.activateAuthProfile({
        name: profileName,
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
