import http from "node:http";
import { URL } from "node:url";

import type { AppConfig } from "../config.js";
import type { AdminService } from "../services/admin-service.js";
import { readJsonBody, respondJson } from "./common.js";

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
      tokenConfigured: Boolean(options.config.brokerAdminToken),
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

  if (method === "GET" && url.pathname === "/admin/api/status") {
    respondJson(response, 200, await options.adminService.getStatus());
    return true;
  }

  if (method === "POST" && url.pathname === "/admin/api/replace-auth") {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      respondJson(response, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
      return true;
    }

    const authJsonContent = typeof body.auth_json_content === "string" ? body.auth_json_content : undefined;
    const credentialsJsonContent =
      typeof body.credentials_json_content === "string" ? body.credentials_json_content : undefined;
    const configTomlContent = typeof body.config_toml_content === "string" ? body.config_toml_content : undefined;
    const allowActive = body.allow_active === true;

    if (!authJsonContent?.trim()) {
      respondJson(response, 400, {
        ok: false,
        error: "missing_required_body",
        required: ["auth_json_content"]
      });
      return true;
    }

    try {
      respondJson(
        response,
        200,
        await options.adminService.replaceAuthFiles({
          authJsonContent,
          credentialsJsonContent,
          configTomlContent,
          allowActive
        })
      );
    } catch (error) {
      respondJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return true;
  }

  return false;
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

function renderAdminPage(options: {
  readonly tokenConfigured: boolean;
  readonly serviceName: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(options.serviceName)} Admin</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #0d131a;
      --panel: #141d27;
      --panel-soft: #1b2632;
      --line: #2c3846;
      --text: #edf2f7;
      --muted: #9aa7b8;
      --accent: #38bdf8;
      --good: #4ade80;
      --warn: #fbbf24;
      --danger: #f87171;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --sans: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    body {
      margin: 0;
      background: radial-gradient(circle at top left, #172231 0%, #0d131a 52%);
      color: var(--text);
      font-family: var(--sans);
    }
    .wrap {
      max-width: 1320px;
      margin: 0 auto;
      padding: 24px;
    }
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      margin-bottom: 24px;
    }
    h1, h2 {
      margin: 0;
      font-weight: 650;
      letter-spacing: -0.02em;
    }
    h1 {
      font-size: 30px;
      margin-bottom: 8px;
    }
    p {
      margin: 0;
      color: var(--muted);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(12, minmax(0, 1fr));
      gap: 16px;
    }
    .card {
      background: rgba(20, 29, 39, 0.94);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 18px;
      padding: 18px;
      box-shadow: 0 12px 36px rgba(0,0,0,0.2);
    }
    .span-4 { grid-column: span 4; }
    .span-5 { grid-column: span 5; }
    .span-6 { grid-column: span 6; }
    .span-7 { grid-column: span 7; }
    .span-8 { grid-column: span 8; }
    .span-12 { grid-column: span 12; }
    .badge {
      display: inline-flex;
      border-radius: 999px;
      padding: 4px 10px;
      border: 1px solid var(--line);
      background: var(--panel-soft);
      font-size: 12px;
      font-weight: 700;
      gap: 6px;
      align-items: center;
    }
    .mono { font-family: var(--mono); }
    .muted { color: var(--muted); }
    .good { color: var(--good); }
    .warn { color: var(--warn); }
    .danger { color: var(--danger); }
    .actions {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      align-items: center;
    }
    button {
      border: 0;
      border-radius: 10px;
      background: var(--accent);
      color: white;
      padding: 10px 14px;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    button.secondary {
      background: var(--panel-soft);
      color: var(--text);
      border: 1px solid var(--line);
    }
    input[type="password"], input[type="file"] {
      width: 100%;
      box-sizing: border-box;
      border-radius: 10px;
      border: 1px solid var(--line);
      background: #0b1016;
      color: var(--text);
      padding: 10px 12px;
      font: inherit;
    }
    label {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 14px;
    }
    .form-grid {
      display: grid;
      gap: 12px;
      margin-top: 16px;
    }
    .checkbox {
      display: flex;
      gap: 8px;
      align-items: center;
      color: var(--text);
    }
    .list {
      display: grid;
      gap: 10px;
      margin-top: 14px;
    }
    .item {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 12px;
      background: rgba(255,255,255,0.02);
    }
    .item-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 8px;
      align-items: center;
    }
    .item-title {
      font-weight: 650;
      word-break: break-word;
    }
    .meta {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      color: var(--muted);
      font-size: 13px;
    }
    .kv {
      display: grid;
      grid-template-columns: 180px 1fr;
      gap: 8px 12px;
      margin-top: 14px;
    }
    .kv dt {
      color: var(--muted);
    }
    .kv dd {
      margin: 0;
      word-break: break-word;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 14px;
      font-size: 13px;
    }
    th, td {
      text-align: left;
      padding: 10px 8px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-weight: 600;
    }
    pre {
      margin: 0;
      padding: 12px;
      border-radius: 12px;
      background: #091018;
      overflow: auto;
      border: 1px solid var(--line);
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.45;
    }
    .status-line {
      min-height: 22px;
      color: var(--muted);
    }
    @media (max-width: 960px) {
      .span-4, .span-5, .span-6, .span-7, .span-8, .span-12 {
        grid-column: span 12;
      }
      .topbar {
        flex-direction: column;
      }
      .kv {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="topbar">
      <div>
        <h1>${escapeHtml(options.serviceName)} Admin</h1>
        <p>Inspect live session state and replace Codex auth files from inside the broker service.</p>
      </div>
      <div class="actions">
        <div class="badge">${options.tokenConfigured ? "Admin token configured" : "Admin token not configured"}</div>
        <button id="refresh-button" class="secondary">Refresh</button>
      </div>
    </div>

    <div class="grid">
      <section class="card span-4">
        <h2>Admin Access</h2>
        <div class="form-grid">
          <label>
            Admin token
            <input id="token-input" type="password" placeholder="${options.tokenConfigured ? "Required for API access" : "Optional"}" />
          </label>
          <div class="status-line" id="token-status"></div>
        </div>
      </section>

      <section class="card span-4">
        <h2>Service</h2>
        <dl class="kv" id="service-card"></dl>
      </section>

      <section class="card span-4">
        <h2>Account</h2>
        <div id="account-card" class="list"></div>
      </section>

      <section class="card span-5">
        <h2>Auth Files</h2>
        <div id="auth-files-card" class="list"></div>
      </section>

      <section class="card span-7">
        <h2>Replace Auth</h2>
        <div class="form-grid">
          <label>
            auth.json
            <input id="auth-json-file" type="file" accept=".json,application/json" />
          </label>
          <label>
            .credentials.json (optional)
            <input id="credentials-json-file" type="file" accept=".json,application/json" />
          </label>
          <label>
            config.toml (optional)
            <input id="config-toml-file" type="file" accept=".toml,text/plain" />
          </label>
          <label class="checkbox">
            <input id="allow-active" type="checkbox" />
            Allow replacing auth even if active sessions exist
          </label>
          <div class="actions">
            <button id="replace-button">Replace auth</button>
          </div>
          <div class="status-line" id="replace-status"></div>
        </div>
      </section>

      <section class="card span-8">
        <h2>Sessions</h2>
        <div id="sessions-panel" class="list"></div>
      </section>

      <section class="card span-4">
        <h2>Background Jobs</h2>
        <div id="jobs-panel" class="list"></div>
      </section>

      <section class="card span-12">
        <h2>Recent Broker Logs</h2>
        <pre id="logs-panel">Loading…</pre>
      </section>
    </div>
  </div>

  <script>
    const tokenKey = "broker-admin-token";
    const tokenConfigured = ${options.tokenConfigured ? "true" : "false"};
    const tokenInput = document.getElementById("token-input");
    const tokenStatus = document.getElementById("token-status");
    const refreshButton = document.getElementById("refresh-button");
    const replaceButton = document.getElementById("replace-button");
    const replaceStatus = document.getElementById("replace-status");

    tokenInput.value = localStorage.getItem(tokenKey) || "";

    function esc(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    function fmtTime(value) {
      if (!value) return "—";
      try {
        return new Date(value).toLocaleString();
      } catch {
        return String(value);
      }
    }

    function authHeaders(extra) {
      const headers = Object.assign({}, extra || {});
      const token = tokenInput.value.trim();
      if (token) {
        headers["x-admin-token"] = token;
      }
      return headers;
    }

    function persistToken() {
      localStorage.setItem(tokenKey, tokenInput.value.trim());
      if (tokenConfigured && !tokenInput.value.trim()) {
        tokenStatus.innerHTML = '<span class="warn">A token is required for API access.</span>';
      } else if (!tokenConfigured) {
        tokenStatus.innerHTML = '<span class="warn">No admin token is configured. Anyone who can reach this service can use these admin APIs.</span>';
      } else {
        tokenStatus.textContent = "";
      }
    }

    tokenInput.addEventListener("input", persistToken);
    persistToken();

    function renderService(data) {
      const card = document.getElementById("service-card");
      const service = data.service || {};
      card.innerHTML = [
        ["Service", esc(service.name || "—")],
        ["PID", esc(service.pid || "—")],
        ["Uptime", esc((service.uptimeSeconds || 0) + "s")],
        ["Started", esc(fmtTime(service.startedAt))],
        ["Port", esc(service.port || "—")],
        ["Session root", '<span class="mono">' + esc(service.sessionsRoot || "—") + "</span>"],
        ["Repos root", '<span class="mono">' + esc(service.reposRoot || "—") + "</span>"]
      ].map(([k, v]) => "<dt>" + k + "</dt><dd>" + v + "</dd>").join("");
    }

    function renderAccount(data) {
      const panel = document.getElementById("account-card");
      const account = data.account || {};
      if (!account.ok) {
        panel.innerHTML = '<div class="item danger">Account lookup failed: ' + esc(account.error || "unknown error") + "</div>";
        return;
      }

      const summary = account.account || {};
      panel.innerHTML = [
        '<div class="item"><div class="item-head"><div class="item-title">Runtime account</div></div><div class="meta"><span>type: ' + esc(summary.type || "—") + '</span><span>plan: ' + esc(summary.planType || "—") + '</span><span>email: ' + esc(summary.email || "—") + "</span></div></div>",
        account.quota
          ? '<pre>' + esc(JSON.stringify(account.quota, null, 2)) + "</pre>"
          : '<div class="item"><div class="muted">' + esc(account.note || "No quota or usage fields were exposed.") + "</div></div>"
      ].join("");
    }

    function renderAuthFiles(data) {
      const panel = document.getElementById("auth-files-card");
      const entries = [
        ["auth.json", data.authFiles.authJson],
        [".credentials.json", data.authFiles.credentialsJson],
        ["config.toml", data.authFiles.configToml]
      ];
      panel.innerHTML = entries.map(([name, file]) => {
        const meta = file.exists
          ? '<div class="meta"><span>size: ' + esc(file.size) + '</span><span>mtime: ' + esc(fmtTime(file.mtime)) + "</span></div>"
          : '<div class="meta"><span class="warn">missing</span></div>';
        return '<div class="item"><div class="item-head"><div class="item-title mono">' + esc(name) + "</div></div>" + meta + '<div class="muted mono">' + esc(file.path) + "</div></div>";
      }).join("");
    }

    function renderSessions(data) {
      const panel = document.getElementById("sessions-panel");
      const state = data.state || {};
      const active = state.activeSessions || [];
      const inbound = state.openInbound || [];
      const parts = [
        '<div class="item"><div class="item-head"><div class="item-title">Summary</div></div><div class="meta"><span>sessions: ' + esc(state.sessionCount || 0) + '</span><span>active: ' + esc(state.activeCount || 0) + '</span><span>open inbound: ' + esc(state.openInboundCount || 0) + "</span></div></div>"
      ];
      if (active.length > 0) {
        parts.push('<table><thead><tr><th>Session</th><th>Turn</th><th>Updated</th><th>Workspace</th></tr></thead><tbody>' +
          active.map((session) => '<tr><td class="mono">' + esc(session.key || "—") + '</td><td class="mono">' + esc(session.activeTurnId || "—") + '</td><td>' + esc(fmtTime(session.updatedAt)) + '</td><td class="mono">' + esc(session.workspacePath || "—") + "</td></tr>").join("") +
          "</tbody></table>");
      } else {
        parts.push('<div class="item"><div class="muted">No active sessions.</div></div>');
      }
      if (inbound.length > 0) {
        parts.push('<table><thead><tr><th>Status</th><th>Session</th><th>TS</th><th>Source</th><th>Preview</th></tr></thead><tbody>' +
          inbound.map((item) => '<tr><td>' + esc(item.status || "—") + '</td><td class="mono">' + esc(item.sessionKey || "—") + '</td><td class="mono">' + esc(item.messageTs || "—") + '</td><td>' + esc(item.source || "—") + '</td><td>' + esc(item.textPreview || "—") + "</td></tr>").join("") +
          "</tbody></table>");
      }
      panel.innerHTML = parts.join("");
    }

    function renderJobs(data) {
      const panel = document.getElementById("jobs-panel");
      const jobs = data.state.backgroundJobs || [];
      if (!jobs.length) {
        panel.innerHTML = '<div class="item"><div class="muted">No background jobs.</div></div>';
        return;
      }
      panel.innerHTML = jobs.map((job) =>
        '<div class="item"><div class="item-head"><div class="item-title mono">' + esc(job.id || "—") + '</div><div class="badge">' + esc(job.status || "—") + '</div></div><div class="meta"><span>' + esc(job.kind || "—") + '</span><span>' + esc(fmtTime(job.updatedAt)) + '</span></div><div class="muted mono">' + esc(job.cwd || "—") + "</div>" + (job.error ? '<div class="danger">' + esc(job.error) + "</div>" : "") + "</div>"
      ).join("");
    }

    function renderLogs(data) {
      document.getElementById("logs-panel").textContent = JSON.stringify(data.state.recentBrokerLogs || [], null, 2);
    }

    function render(data) {
      renderService(data);
      renderAccount(data);
      renderAuthFiles(data);
      renderSessions(data);
      renderJobs(data);
      renderLogs(data);
    }

    async function readOptionalFile(id) {
      const input = document.getElementById(id);
      const file = input.files && input.files[0];
      if (!file) return undefined;
      return await file.text();
    }

    async function refresh() {
      refreshButton.disabled = true;
      try {
        const response = await fetch("/admin/api/status", {
          headers: authHeaders()
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Failed to fetch status");
        render(payload);
      } catch (error) {
        document.getElementById("logs-panel").textContent = String(error && error.message ? error.message : error);
      } finally {
        refreshButton.disabled = false;
      }
    }

    refreshButton.addEventListener("click", refresh);

    replaceButton.addEventListener("click", async () => {
      replaceButton.disabled = true;
      replaceStatus.textContent = "Replacing auth and restarting the embedded Codex runtime…";
      try {
        const authJsonContent = await readOptionalFile("auth-json-file");
        if (!authJsonContent) {
          throw new Error("auth.json is required");
        }
        const response = await fetch("/admin/api/replace-auth", {
          method: "POST",
          headers: authHeaders({
            "content-type": "application/json"
          }),
          body: JSON.stringify({
            auth_json_content: authJsonContent,
            credentials_json_content: await readOptionalFile("credentials-json-file"),
            config_toml_content: await readOptionalFile("config-toml-file"),
            allow_active: document.getElementById("allow-active").checked
          })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Auth replacement failed");
        replaceStatus.innerHTML = '<span class="good">Auth updated.</span> The embedded Codex runtime was restarted.';
        render(payload.status);
      } catch (error) {
        replaceStatus.innerHTML = '<span class="danger">' + esc(error && error.message ? error.message : String(error)) + "</span>";
      } finally {
        replaceButton.disabled = false;
      }
    });

    refresh();
    setInterval(refresh, 10000);
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
