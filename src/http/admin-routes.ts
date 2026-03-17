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

    if (!authJsonContent?.trim() && !credentialsJsonContent?.trim() && !configTomlContent?.trim()) {
      respondJson(response, 400, {
        ok: false,
        error: "missing_required_body",
        required: ["auth_json_content | credentials_json_content | config_toml_content"]
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
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(options.serviceName)} 控制台</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #ff972f;
      --bg-deep: #e57d17;
      --panel: #080808;
      --panel-soft: #0b0b0b;
      --panel-strong: #050505;
      --line: rgba(255, 155, 47, 0.15);
      --line-strong: rgba(255, 155, 47, 0.34);
      --text: #fff1de;
      --muted: #a08d75;
      --accent: #ff9b2f;
      --accent-soft: rgba(255, 155, 47, 0.14);
      --good: #31d88a;
      --good-soft: rgba(49, 216, 138, 0.12);
      --warn: #ffc155;
      --warn-soft: rgba(255, 193, 85, 0.14);
      --danger: #ff6e53;
      --danger-soft: rgba(255, 110, 83, 0.14);
      --mono: "SF Mono", "IBM Plex Mono", "JetBrains Mono", ui-monospace, Menlo, Monaco, Consolas, monospace;
      --sans: "SF Mono", "IBM Plex Mono", "JetBrains Mono", ui-monospace, Menlo, Monaco, Consolas, monospace;
    }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at 16% 14%, rgba(255, 203, 140, 0.32), transparent 0 18%),
        radial-gradient(circle at 84% 12%, rgba(255, 210, 150, 0.25), transparent 0 16%),
        linear-gradient(145deg, rgba(255,255,255,0.07) 0 4%, transparent 4% 15%, rgba(255,255,255,0.05) 15% 18%, transparent 18% 34%, rgba(255,255,255,0.06) 34% 37%, transparent 37% 100%),
        linear-gradient(180deg, var(--bg) 0%, var(--bg-deep) 100%);
      color: var(--text);
      font-family: var(--sans);
      letter-spacing: 0.01em;
    }
    .wrap {
      max-width: 1640px;
      margin: 0 auto;
      padding: 28px;
    }
    .dashboard {
      border: 1px solid rgba(255, 155, 47, 0.24);
      background: linear-gradient(180deg, rgba(8, 8, 8, 0.995), rgba(4, 4, 4, 0.995));
      border-radius: 16px;
      box-shadow:
        0 24px 70px rgba(82, 32, 0, 0.28),
        inset 0 0 0 1px rgba(255,255,255,0.02);
      padding: 12px;
    }
    h1, h2, h3 {
      margin: 0;
      font-weight: 650;
      letter-spacing: -0.02em;
    }
    h1 {
      font-size: 22px;
      margin-bottom: 0;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    h2 {
      font-size: 14px;
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    h3 {
      font-size: 13px;
      margin-bottom: 2px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    p {
      margin: 0;
      color: var(--muted);
      line-height: 1.35;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(12, minmax(0, 1fr));
      gap: 14px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 12px;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.015);
    }
    .span-4 { grid-column: span 4; }
    .span-5 { grid-column: span 5; }
    .span-6 { grid-column: span 6; }
    .span-7 { grid-column: span 7; }
    .span-8 { grid-column: span 8; }
    .span-12 { grid-column: span 12; }
    .headerbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-bottom: 10px;
      padding: 10px 12px;
      border-radius: 12px;
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.012);
    }
    .header-main {
      display: grid;
      gap: 4px;
      min-width: 0;
    }
    .header-subtitle {
      color: var(--muted);
      font-size: 11px;
      line-height: 1.3;
      text-transform: uppercase;
    }
    .header-meta {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .summary-strip {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 12px;
    }
    .summary-pill {
      background: var(--panel-soft);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 8px 10px;
      position: relative;
      overflow: hidden;
    }
    .summary-pill::before {
      content: "";
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 3px;
      background: var(--accent);
    }
    .summary-pill-label {
      color: var(--muted);
      font-size: 11px;
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .summary-pill-value {
      font-size: 18px;
      font-weight: 700;
      line-height: 1.2;
      color: var(--accent);
    }
    .summary-pill-detail {
      color: var(--muted);
      font-size: 11px;
      line-height: 1.35;
      margin-top: 4px;
    }
    .badge {
      display: inline-flex;
      border-radius: 999px;
      padding: 4px 8px;
      border: 1px solid var(--line-strong);
      background: rgba(255, 155, 47, 0.08);
      font-size: 11px;
      font-weight: 700;
      gap: 6px;
      align-items: center;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .badge.good { color: var(--good); background: var(--good-soft); }
    .badge.warn { color: var(--warn); background: var(--warn-soft); }
    .badge.danger { color: var(--danger); background: var(--danger-soft); }
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
      border-radius: 8px;
      background: var(--accent);
      color: #190b00;
      padding: 8px 11px;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
      transition: transform 120ms ease, opacity 120ms ease;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    button:hover {
      transform: translateY(-1px);
    }
    button:disabled {
      opacity: 0.55;
      cursor: default;
      transform: none;
    }
    button.secondary {
      background: transparent;
      color: var(--text);
      border: 1px solid var(--line);
    }
    input[type="password"], input[type="file"], textarea {
      width: 100%;
      box-sizing: border-box;
      border-radius: 8px;
      border: 1px solid var(--line);
      background: var(--panel-strong);
      color: var(--text);
      padding: 8px 10px;
      font: inherit;
    }
    textarea {
      min-height: 180px;
      resize: vertical;
      line-height: 1.4;
      font-family: var(--mono);
      font-size: 12px;
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
    .stack {
      display: grid;
      gap: 12px;
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
      margin-top: 10px;
    }
    .item {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 10px 12px;
      background: rgba(255,255,255,0.015);
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
    .item-text {
      margin-top: 8px;
      line-height: 1.55;
      word-break: break-word;
    }
    .meta {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      color: var(--muted);
      font-size: 13px;
    }
    .inline-grid {
      display: grid;
      gap: 10px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .triple-grid {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(3, minmax(0, 1fr));
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
      margin-top: 8px;
      font-size: 12px;
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
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-size: 10px;
    }
    pre {
      margin: 0;
      padding: 10px;
      border-radius: 10px;
      background: #050505;
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
    .section-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-bottom: 10px;
    }
    .section-copy {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
    }
    .hint {
      margin-top: 8px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.55;
    }
    .empty {
      padding: 12px;
      border-radius: 10px;
      border: 1px dashed var(--line-strong);
      color: var(--muted);
      background: rgba(255,255,255,0.01);
    }
    .log-list {
      display: grid;
      gap: 8px;
      margin-top: 10px;
    }
    .log-entry {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 8px 10px;
      background: rgba(255,255,255,0.012);
    }
    .log-entry.warn {
      border-color: rgba(251, 191, 36, 0.28);
      background: var(--warn-soft);
    }
    .log-entry.error {
      border-color: rgba(251, 113, 133, 0.34);
      background: var(--danger-soft);
    }
    .tiny {
      font-size: 12px;
      color: var(--muted);
    }
    .action-card {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 8px 10px;
      border-radius: 10px;
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.012);
    }
    .session-shell {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: rgba(255,255,255,0.01);
      overflow: hidden;
    }
    .session-shell[open] {
      border-color: var(--line-strong);
      background: rgba(255, 155, 47, 0.04);
    }
    .session-summary {
      list-style: none;
      cursor: pointer;
      display: grid;
      gap: 6px;
      padding: 8px 10px;
    }
    .session-summary::-webkit-details-marker {
      display: none;
    }
    .session-summary-top {
      display: grid;
      grid-template-columns: minmax(220px, 2.2fr) minmax(140px, .95fr) minmax(150px, 1fr) minmax(140px, .95fr) minmax(220px, 1.8fr);
      gap: 6px;
      align-items: start;
    }
    .session-summary-main {
      display: grid;
      gap: 4px;
      min-width: 0;
    }
    .session-summary-title {
      font-weight: 650;
      word-break: break-word;
      color: var(--accent);
    }
    .session-summary-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 10px;
      color: var(--muted);
      font-size: 11px;
    }
    .session-summary-side {
      display: grid;
      gap: 6px;
      align-content: start;
    }
    .session-counts {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .session-body {
      padding: 0 14px 14px;
      display: grid;
      gap: 8px;
    }
    .session-divider {
      height: 1px;
      background: var(--line);
    }
    dialog.admin-modal {
      border: 0;
      padding: 0;
      border-radius: 24px;
      width: min(760px, calc(100vw - 24px));
      background: transparent;
      color: inherit;
    }
    dialog.admin-modal::backdrop {
      background: rgba(3, 10, 18, 0.72);
      backdrop-filter: blur(6px);
    }
    .modal-card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 16px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.32);
      display: grid;
      gap: 12px;
    }
    .modal-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
    }
    .modal-copy {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.55;
    }
    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      flex-wrap: wrap;
    }
    .compact-kv {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .compact-stat {
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.012);
      border-radius: 8px;
      padding: 10px 12px;
    }
    .compact-stat-label {
      font-size: 11px;
      color: var(--muted);
      margin-bottom: 4px;
    }
    .compact-stat-value {
      font-size: 14px;
      font-weight: 650;
      word-break: break-word;
    }
    .session-toolbar {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
    }
    .session-toolbar input,
    .session-toolbar select {
      border-radius: 10px;
      border: 1px solid var(--line);
      background: var(--panel-strong);
      color: var(--text);
      padding: 8px 10px;
      font: inherit;
    }
    .session-toolbar input {
      min-width: 240px;
      flex: 1 1 280px;
    }
    .session-summary-cell {
      min-width: 0;
      display: grid;
      gap: 4px;
    }
    .session-summary-label {
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .session-summary-value {
      font-size: 12px;
      line-height: 1.3;
      word-break: break-word;
    }
    .session-summary-value.truncate {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .dense-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 0;
      font-size: 12px;
    }
    .dense-table th,
    .dense-table td {
      padding: 6px 5px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
    }
    .dense-table th {
      color: var(--muted);
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .dense-table td code,
    .dense-table td .mono {
      font-size: 11px;
    }
    .session-detail-grid {
      display: grid;
      grid-template-columns: 1.3fr 1fr;
      gap: 12px;
    }
    .subpanel {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 12px;
      background: rgba(255,255,255,0.01);
      display: grid;
      gap: 10px;
    }
    .subpanel-head {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: baseline;
    }
    .subpanel-title {
      font-size: 13px;
      font-weight: 650;
    }
    .subpanel-meta {
      color: var(--muted);
      font-size: 11px;
    }
    .dense-panels {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(360px, 1.15fr);
      gap: 14px;
      align-items: start;
    }
    .auth-file-list {
      display: grid;
      gap: 10px;
    }
    .auth-file-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: start;
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 12px;
      background: rgba(255,255,255,0.012);
    }
    .auth-file-main {
      display: grid;
      gap: 8px;
      min-width: 0;
    }
    .auth-file-head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .auth-file-title {
      font-size: 13px;
      font-weight: 650;
    }
    .auth-file-copy {
      font-size: 11px;
      color: var(--muted);
      line-height: 1.35;
    }
    .auth-file-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 12px;
      color: var(--muted);
      font-size: 12px;
    }
    .auth-file-path {
      font-size: 12px;
      line-height: 1.35;
      color: var(--muted);
      word-break: break-word;
    }
    .auth-file-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    @media (max-width: 960px) {
      .span-4, .span-5, .span-6, .span-7, .span-8, .span-12 {
        grid-column: span 12;
      }
      .headerbar {
        flex-direction: column;
        align-items: stretch;
      }
      .summary-strip {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .inline-grid {
        grid-template-columns: 1fr;
      }
      .triple-grid {
        grid-template-columns: 1fr;
      }
      .compact-kv {
        grid-template-columns: 1fr;
      }
      .kv {
        grid-template-columns: 1fr;
      }
      .session-summary-top {
        grid-template-columns: 1fr;
      }
      .session-detail-grid {
        grid-template-columns: 1fr;
      }
      .dense-panels {
        grid-template-columns: 1fr;
      }
      .auth-file-row {
        grid-template-columns: 1fr;
      }
      .auth-file-actions {
        justify-content: flex-start;
      }
    }
    @media (max-width: 640px) {
      .wrap {
        padding: 12px;
      }
      .summary-strip {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="dashboard">
      <div class="headerbar">
        <div class="header-main">
          <h1>${escapeHtml(options.serviceName)} Admin</h1>
          <div class="header-subtitle">live 状态、账号、session、后台任务、登录态切换都在这里。重点是快速扫一眼，不是看说明书。</div>
        </div>
        <div class="header-meta">
            <div class="badge ${options.tokenConfigured ? "good" : "warn"}">${options.tokenConfigured ? "已启用管理员令牌" : "未启用管理员令牌"}</div>
            <div class="badge">每 10 秒自动刷新</div>
            <div class="badge">也可以手动刷新</div>
        </div>
      </div>

      <section class="summary-strip">
        <div class="summary-pill">
          <div class="summary-pill-label">服务</div>
          <div class="summary-pill-value" id="summary-service">--</div>
          <div class="summary-pill-detail" id="summary-service-detail">正在读取服务信息…</div>
        </div>
        <div class="summary-pill">
          <div class="summary-pill-label">账号</div>
          <div class="summary-pill-value" id="summary-account">--</div>
          <div class="summary-pill-detail" id="summary-account-detail">正在读取账号信息…</div>
        </div>
        <div class="summary-pill">
          <div class="summary-pill-label">会话</div>
          <div class="summary-pill-value" id="summary-sessions">--</div>
          <div class="summary-pill-detail" id="summary-sessions-detail">正在读取会话状态…</div>
        </div>
        <div class="summary-pill">
          <div class="summary-pill-label">任务</div>
          <div class="summary-pill-value" id="summary-jobs">--</div>
          <div class="summary-pill-detail" id="summary-jobs-detail">正在读取后台任务…</div>
        </div>
      </section>

      <div class="grid">
      <section class="card span-12">
        <div class="section-head">
          <div>
            <h2>运行概览</h2>
            <div class="section-copy">固定状态都压在这里。登录文件直接在条目里看状态和替换，不再拆成第二块重复区域。</div>
          </div>
          <div class="actions">
            <input id="token-input" type="password" placeholder="${options.tokenConfigured ? "管理员令牌" : "当前可留空"}" style="width:220px" />
            <button id="refresh-button" class="secondary">刷新</button>
            <span class="tiny" id="last-refresh">还没有刷新</span>
          </div>
        </div>
        <div class="status-line" id="token-status"></div>
        <div class="dense-panels" style="margin-top:8px;">
          <div class="subpanel">
            <div class="subpanel-head"><div class="subpanel-title">服务</div></div>
            <div id="service-card"></div>
          </div>
          <div class="subpanel">
            <div class="subpanel-head"><div class="subpanel-title">账号</div></div>
            <div id="account-card"></div>
          </div>
          <div class="subpanel">
            <div class="subpanel-head"><div class="subpanel-title">登录文件</div></div>
            <div class="auth-file-list">
              <div class="auth-file-row">
                <div class="auth-file-main">
                  <div class="auth-file-head">
                    <div class="auth-file-title mono">auth.json</div>
                    <div id="auth-file-auth-badge"></div>
                  </div>
                  <div class="auth-file-copy">切运行账号。支持上传文件或直接粘贴完整 JSON。</div>
                  <div class="auth-file-meta" id="auth-file-auth-meta"></div>
                  <div class="auth-file-path mono" id="auth-file-auth-path"></div>
                </div>
                <div class="auth-file-actions">
                  <button id="open-auth-dialog">替换</button>
                  <div class="badge good">常用</div>
                </div>
              </div>
              <div class="auth-file-row">
                <div class="auth-file-main">
                  <div class="auth-file-head">
                    <div class="auth-file-title mono">.credentials.json</div>
                    <div id="auth-file-credentials-badge"></div>
                  </div>
                  <div class="auth-file-copy">MCP OAuth 凭据。只改这一个文件，不会碰 auth.json。</div>
                  <div class="auth-file-meta" id="auth-file-credentials-meta"></div>
                  <div class="auth-file-path mono" id="auth-file-credentials-path"></div>
                </div>
                <div class="auth-file-actions">
                  <button id="open-credentials-dialog" class="secondary">替换</button>
                  <div class="badge">MCP</div>
                </div>
              </div>
              <div class="auth-file-row">
                <div class="auth-file-main">
                  <div class="auth-file-head">
                    <div class="auth-file-title mono">config.toml</div>
                    <div id="auth-file-config-badge"></div>
                  </div>
                  <div class="auth-file-copy">模型、MCP、运行参数。支持上传文件或直接粘贴文本。</div>
                  <div class="auth-file-meta" id="auth-file-config-meta"></div>
                  <div class="auth-file-path mono" id="auth-file-config-path"></div>
                </div>
                <div class="auth-file-actions">
                  <button id="open-config-dialog" class="secondary">替换</button>
                  <div class="badge">配置</div>
                </div>
              </div>
            </div>
            <div class="hint">系统会先把被覆盖的旧文件备份到容器数据目录里的 <span class="mono">admin-backups/auth-switches</span>，然后再写入新文件。</div>
            <div class="status-line" id="replace-status"></div>
          </div>
        </div>
      </section>

      <section class="card span-12">
        <div class="section-head">
          <div>
            <h2>会话状态</h2>
            <div class="section-copy">这里改成高密度视图：先筛选，再扫摘要行，最后按需展开看消息和任务。</div>
          </div>
          <div class="session-toolbar">
            <input id="session-search" type="search" placeholder="搜索 session key / channel / workspace / snippet" />
            <select id="session-filter">
              <option value="all">全部</option>
              <option value="active">只看 active</option>
              <option value="inbound">只看有待处理消息</option>
              <option value="jobs">只看有运行中任务</option>
              <option value="issues">只看有失败任务</option>
            </select>
          </div>
        </div>
        <div id="sessions-panel" class="list"></div>
      </section>

      <section class="card span-12">
        <div class="section-head">
          <div>
            <h2>最近日志</h2>
            <div class="section-copy">这里只看最近的重要日志，用来快速判断断线、恢复、thread 漂移和 job 失败。</div>
          </div>
        </div>
        <div id="logs-panel" class="log-list"></div>
      </section>
      </div>
    </div>
  </div>

  <dialog id="auth-dialog" class="admin-modal">
    <div class="modal-card">
      <div class="modal-head">
        <div>
          <h2>替换 auth.json</h2>
          <div class="modal-copy">只改运行账号。你可以上传文件，或者直接粘贴完整的 <span class="mono">auth.json</span>。如果两者都提供，优先使用粘贴内容。</div>
        </div>
        <button id="close-auth-dialog" class="secondary" type="button">关闭</button>
      </div>
      <div class="stack">
        <label>
          auth.json 文件
          <input id="auth-json-file" type="file" accept=".json,application/json" />
        </label>
        <label>
          或者直接粘贴 auth.json
          <textarea id="auth-json-text" placeholder='把完整 auth.json 粘贴到这里。'></textarea>
        </label>
        <label class="checkbox">
          <input id="allow-active-auth" type="checkbox" />
          即使当前有活跃 session，也允许替换并打断它们
        </label>
      </div>
      <div class="modal-actions">
        <button id="submit-auth-dialog">应用 auth.json</button>
      </div>
      <div class="status-line" id="auth-dialog-status"></div>
    </div>
  </dialog>

  <dialog id="credentials-dialog" class="admin-modal">
    <div class="modal-card">
      <div class="modal-head">
        <div>
          <h2>替换 .credentials.json</h2>
          <div class="modal-copy">只改 MCP OAuth 凭据。支持上传文件，也支持直接粘贴完整 JSON。</div>
        </div>
        <button id="close-credentials-dialog" class="secondary" type="button">关闭</button>
      </div>
      <div class="stack">
        <label>
          .credentials.json 文件
          <input id="credentials-json-file" type="file" accept=".json,application/json" />
        </label>
        <label>
          或者直接粘贴 .credentials.json
          <textarea id="credentials-json-text" placeholder='把完整 .credentials.json 粘贴到这里。'></textarea>
        </label>
        <label class="checkbox">
          <input id="allow-active-credentials" type="checkbox" />
          即使当前有活跃 session，也允许替换并打断它们
        </label>
      </div>
      <div class="modal-actions">
        <button id="submit-credentials-dialog">应用 .credentials.json</button>
      </div>
      <div class="status-line" id="credentials-dialog-status"></div>
    </div>
  </dialog>

  <dialog id="config-dialog" class="admin-modal">
    <div class="modal-card">
      <div class="modal-head">
        <div>
          <h2>替换 config.toml</h2>
          <div class="modal-copy">只改运行配置。支持上传文件，也支持直接粘贴完整文本。</div>
        </div>
        <button id="close-config-dialog" class="secondary" type="button">关闭</button>
      </div>
      <div class="stack">
        <label>
          config.toml 文件
          <input id="config-toml-file" type="file" accept=".toml,text/plain" />
        </label>
        <label>
          或者直接粘贴 config.toml
          <textarea id="config-toml-text" placeholder='把完整 config.toml 粘贴到这里。'></textarea>
        </label>
        <label class="checkbox">
          <input id="allow-active-config" type="checkbox" />
          即使当前有活跃 session，也允许替换并打断它们
        </label>
      </div>
      <div class="modal-actions">
        <button id="submit-config-dialog">应用 config.toml</button>
      </div>
      <div class="status-line" id="config-dialog-status"></div>
    </div>
  </dialog>

  <script>
    const tokenKey = "broker-admin-token";
    const tokenConfigured = ${options.tokenConfigured ? "true" : "false"};
    const tokenInput = document.getElementById("token-input");
    const tokenStatus = document.getElementById("token-status");
    const refreshButton = document.getElementById("refresh-button");
    const replaceStatus = document.getElementById("replace-status");
    const lastRefresh = document.getElementById("last-refresh");
    const sessionSearch = document.getElementById("session-search");
    const sessionFilter = document.getElementById("session-filter");
    const authJsonText = document.getElementById("auth-json-text");
    const credentialsJsonText = document.getElementById("credentials-json-text");
    const configTomlText = document.getElementById("config-toml-text");
    let latestStatus = null;
    const dialogs = [
      ["auth-dialog", "open-auth-dialog", "close-auth-dialog"],
      ["credentials-dialog", "open-credentials-dialog", "close-credentials-dialog"],
      ["config-dialog", "open-config-dialog", "close-config-dialog"]
    ];

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

    function fmtDuration(totalSeconds) {
      const seconds = Number(totalSeconds || 0);
      if (!Number.isFinite(seconds) || seconds <= 0) return "刚启动";
      const parts = [];
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const remainingSeconds = seconds % 60;
      if (hours > 0) parts.push(hours + " 小时");
      if (minutes > 0) parts.push(minutes + " 分钟");
      if (hours === 0 && remainingSeconds > 0) parts.push(remainingSeconds + " 秒");
      return parts.join(" ");
    }

    function statusTone(status) {
      const value = String(status || "").toLowerCase();
      if (["running", "active", "ok", "completed"].includes(value)) return "good";
      if (["pending", "inflight", "starting", "cancelled"].includes(value)) return "warn";
      if (["failed", "error", "stopped"].includes(value)) return "danger";
      return "";
    }

    function renderBadge(label, tone) {
      const cls = tone ? "badge " + tone : "badge";
      return '<span class="' + cls + '">' + esc(label) + "</span>";
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
        tokenStatus.innerHTML = '<span class="warn">这个服务已开启管理员令牌，不填就无法调用 API。</span>';
      } else if (!tokenConfigured) {
        tokenStatus.innerHTML = '<span class="warn">当前没有管理员令牌。只要能访问这个端口的人，都能调用这些管理接口。</span>';
      } else {
        tokenStatus.innerHTML = '<span class="good">令牌已准备好，可以访问管理接口。</span>';
      }
    }

    tokenInput.addEventListener("input", persistToken);
    persistToken();

    function renderSummary(data) {
      const service = data.service || {};
      const state = data.state || {};
      const account = data.account || {};
      const runningJobs = Number(state.runningBackgroundJobCount || 0);
      const failedJobs = Number(state.failedBackgroundJobCount || 0);

      document.getElementById("summary-service").textContent = "在线";
      document.getElementById("summary-service-detail").textContent =
        "PID " + (service.pid || "—") + "，已运行 " + fmtDuration(service.uptimeSeconds || 0) + "。";

      const accountLabel = account.ok ? ((account.account && account.account.planType) || "已登录") : "异常";
      document.getElementById("summary-account").textContent = accountLabel;
      document.getElementById("summary-account-detail").textContent = account.ok
        ? (((account.account && account.account.email) || "未提供邮箱") + " · " + ((account.account && account.account.type) || "未知类型"))
        : ("账号读取失败：" + (account.error || "unknown error"));

      document.getElementById("summary-sessions").textContent =
        String(state.activeCount || 0) + " / " + String(state.sessionCount || 0);
      document.getElementById("summary-sessions-detail").textContent =
        "活跃 / 总会话，待处理 " + String(state.openInboundCount || 0) + "。";

      document.getElementById("summary-jobs").textContent = String(runningJobs);
      document.getElementById("summary-jobs-detail").textContent =
        "运行中任务，失败 " + String(failedJobs) + "。";
    }

    function renderService(data) {
      const card = document.getElementById("service-card");
      const service = data.service || {};
      card.innerHTML =
        '<div class="compact-kv">' +
          [
            ["服务名", esc(service.name || "—")],
            ["PID", esc(service.pid || "—")],
            ["运行时长", esc(fmtDuration(service.uptimeSeconds || 0))],
            ["端口", esc(service.port || "—")],
            ["启动时间", esc(fmtTime(service.startedAt))],
            ["管理员令牌", service.adminTokenConfigured ? "已配置" : "未配置"]
          ].map(([k, v]) =>
            '<div class="compact-stat"><div class="compact-stat-label">' + k + '</div><div class="compact-stat-value">' + v + "</div></div>"
          ).join("") +
        '</div>' +
        '<div class="list">' +
          [
            ["会话目录", service.sessionsRoot || "—"],
            ["仓库目录", service.reposRoot || "—"],
            ["Codex Home", service.codexHome || "—"]
          ].map(([k, v]) =>
            '<div class="item"><div class="item-head"><div class="item-title">' + esc(k) + '</div></div><div class="hint mono">' + esc(v) + "</div></div>"
          ).join("") +
        '</div>';
    }

    function renderAccount(data) {
      const panel = document.getElementById("account-card");
      const account = data.account || {};
      if (!account.ok) {
        panel.innerHTML = '<div class="item danger"><div class="item-title">账号读取失败</div><div class="item-text">' + esc(account.error || "unknown error") + "</div></div>";
        return;
      }

      const summary = account.account || {};
      panel.innerHTML = [
        '<div class="compact-kv">' +
          [
            ["套餐", summary.planType || "unknown"],
            ["类型", summary.type || "—"],
            ["邮箱", summary.email || "—"],
            ["额度", account.quota ? "已提供" : "未提供"]
          ].map(([k, v]) =>
            '<div class="compact-stat"><div class="compact-stat-label">' + esc(k) + '</div><div class="compact-stat-value">' + esc(v) + "</div></div>"
          ).join("") +
        '</div>',
        account.quota
          ? '<pre>' + esc(JSON.stringify(account.quota, null, 2)) + "</pre>"
          : '<div class="item"><div class="item-title">额度信息</div><div class="item-text muted">' + esc(account.note || "当前接口没有返回 quota 或 usage 字段。") + "</div></div>"
      ].join("");
    }

    function renderAuthFiles(data) {
      const entries = [
        ["auth", data.authFiles.authJson],
        ["credentials", data.authFiles.credentialsJson],
        ["config", data.authFiles.configToml]
      ];
      entries.forEach(([key, file]) => {
        const badgeNode = document.getElementById("auth-file-" + key + "-badge");
        const metaNode = document.getElementById("auth-file-" + key + "-meta");
        const pathNode = document.getElementById("auth-file-" + key + "-path");
        badgeNode.innerHTML = renderBadge(file.exists ? "已就位" : "缺失", file.exists ? "good" : "warn");
        metaNode.innerHTML = file.exists
          ? '<span>大小：' + esc(file.size) + ' bytes</span><span>更新时间：' + esc(fmtTime(file.mtime)) + "</span>"
          : '<span class="warn">文件不存在</span>';
        pathNode.textContent = file.path || "—";
      });
    }

    function summarizeSessionLead(session) {
      const inbound = session.openInbound || [];
      if (inbound.length > 0) {
        return inbound.map((item) => item.textPreview).filter(Boolean)[0] || "有待处理消息";
      }
      const jobs = session.backgroundJobs || [];
      if (jobs.length > 0) {
        const running = jobs.find((job) => job.status === "running") || jobs[0];
        return (running.kind || "job") + " · " + (running.status || "unknown");
      }
      return "当前无待处理项";
    }

    function renderDenseInboundTable(inbound) {
      if (!inbound.length) {
        return '<div class="empty">没有待处理消息。</div>';
      }
      return '<table class="dense-table"><thead><tr><th>状态</th><th>来源</th><th>消息</th><th>更新时间</th></tr></thead><tbody>' +
        inbound.map((item) =>
          '<tr>' +
            '<td>' + renderBadge(item.status || "unknown", statusTone(item.status)) + '</td>' +
            '<td><span class="mono">' + esc(item.source || "—") + '</span></td>' +
            '<td>' +
              '<div class="mono tiny">' + esc(item.messageTs || "—") + '</div>' +
              '<div>' + esc(item.textPreview || "—") + '</div>' +
            '</td>' +
            '<td>' + esc(fmtTime(item.updatedAt)) + '</td>' +
          '</tr>'
        ).join("") +
      "</tbody></table>";
    }

    function renderDenseJobsTable(jobs, totals) {
      if (!jobs.length) {
        return '<div class="empty">没有关联后台任务。</div>';
      }
      return '<table class="dense-table"><thead><tr><th>状态</th><th>类型</th><th>CWD</th><th>更新时间</th></tr></thead><tbody>' +
        jobs.map((job) =>
          '<tr>' +
            '<td>' + renderBadge(job.status || "unknown", statusTone(job.status)) + '</td>' +
            '<td><span class="mono">' + esc(job.kind || "—") + '</span></td>' +
            '<td>' +
              '<div class="mono">' + esc(job.cwd || "—") + '</div>' +
              (job.error ? '<div class="danger tiny" style="margin-top:4px;">' + esc(job.error) + '</div>' : "") +
            '</td>' +
            '<td>' + esc(fmtTime(job.updatedAt)) + '</td>' +
          '</tr>'
        ).join("") +
      "</tbody></table>" +
      (totals.total > jobs.length ? '<div class="hint">这里只显示最近 ' + esc(jobs.length) + ' 条，历史总数 ' + esc(totals.total) + '。</div>' : "");
    }

    function renderSessions(data) {
      const panel = document.getElementById("sessions-panel");
      const state = data.state || {};
      const allSessions = state.sessions || [];
      const needle = (sessionSearch.value || "").trim().toLowerCase();
      const mode = sessionFilter.value || "all";
      const sessions = allSessions.filter((session) => {
        const runningJobs = Number(session.runningBackgroundJobCount || 0);
        const failedJobs = Number(session.failedBackgroundJobCount || 0);
        const inboundCount = Number(session.openInboundCount || 0);
        if (mode === "active" && !session.activeTurnId) return false;
        if (mode === "inbound" && inboundCount === 0) return false;
        if (mode === "jobs" && runningJobs === 0) return false;
        if (mode === "issues" && failedJobs === 0) return false;
        if (!needle) return true;
        const haystack = [
          session.key,
          session.channelId,
          session.rootThreadTs,
          session.workspacePath,
          summarizeSessionLead(session),
          ...(session.openInbound || []).map((item) => item.textPreview || ""),
          ...(session.backgroundJobs || []).map((job) => [job.kind, job.cwd, job.error].filter(Boolean).join(" "))
        ].join("\\n").toLowerCase();
        return haystack.includes(needle);
      });
      const parts = [];
      if (sessions.length > 0) {
        parts.push(
          sessions.map((session) => {
            const jobs = session.backgroundJobs || [];
            const inbound = session.openInbound || [];
            const isActive = Boolean(session.activeTurnId);
            const runningJobs = Number(session.runningBackgroundJobCount || 0);
            const totalJobs = Number(session.backgroundJobCount || 0);
            const failedJobs = Number(session.failedBackgroundJobCount || 0);
            const turnBadge = isActive ? renderBadge("active", "good") : renderBadge("idle", "warn");
            const lead = summarizeSessionLead(session);
            return (
            '<details class="session-shell">' +
              '<summary class="session-summary">' +
                '<div class="session-summary-top">' +
                  '<div class="session-summary-main">' +
                    '<div class="session-summary-title mono">' + esc(session.key || "—") + '</div>' +
                    '<div class="session-summary-meta"><span>channel ' + esc(session.channelId || "—") + '</span><span>thread ' + esc(session.rootThreadTs || "—") + '</span></div>' +
                  '</div>' +
                  '<div class="session-summary-cell">' +
                    '<div class="session-summary-label">最近状态</div>' +
                    '<div class="session-summary-value">更新 ' + esc(fmtTime(session.updatedAt)) + '</div>' +
                    '<div class="session-summary-value">回复 ' + esc(fmtTime(session.lastSlackReplyAt)) + '</div>' +
                  '</div>' +
                  '<div class="session-summary-cell">' +
                    '<div class="session-summary-label">资源</div>' +
                    '<div class="session-summary-value">待处理 ' + esc(session.openInboundCount || 0) + ' · 运行中任务 ' + esc(runningJobs) + ' · 总任务 ' + esc(totalJobs) + '</div>' +
                    '<div class="session-summary-value">失败任务 ' + esc(failedJobs) + '</div>' +
                  '</div>' +
                  '<div class="session-summary-cell">' +
                    '<div class="session-summary-label">当前线索</div>' +
                    '<div class="session-summary-value truncate">' + esc(lead) + '</div>' +
                  '</div>' +
                  '<div class="session-summary-side">' +
                    turnBadge +
                    '<div class="tiny mono">' + esc(session.workspacePath || "—") + '</div>' +
                  '</div>' +
                '</div>' +
                '<div class="session-counts">' +
                  renderBadge("待处理 " + esc(session.openInboundCount || 0), Number(session.openInboundCount || 0) > 0 ? "warn" : "") +
                  renderBadge("运行中任务 " + esc(runningJobs), runningJobs > 0 ? "good" : "") +
                  renderBadge("总任务 " + esc(totalJobs), totalJobs > 0 ? "warn" : "") +
                  (failedJobs > 0 ? renderBadge("失败 " + esc(failedJobs), "danger") : "") +
                  (session.activeTurnId ? renderBadge("turn 已占用", "good") : renderBadge("当前空闲", "warn")) +
                '</div>' +
              '</summary>' +
              '<div class="session-body">' +
                '<div class="session-divider"></div>' +
                '<div class="meta"><span>工作目录：<span class="mono">' + esc(session.workspacePath || "—") + '</span></span>' +
                (session.activeTurnId ? '<span>turn：<span class="mono">' + esc(session.activeTurnId) + '</span></span>' : "") +
                '</div>' +
                '<div class="session-detail-grid">' +
                  '<div class="subpanel">' +
                    '<div class="subpanel-head"><div class="subpanel-title">待处理消息</div><div class="subpanel-meta">当前 ' + esc(inbound.length) + ' 条</div></div>' +
                    renderDenseInboundTable(inbound) +
                  '</div>' +
                  '<div class="subpanel">' +
                    '<div class="subpanel-head"><div class="subpanel-title">后台任务</div><div class="subpanel-meta">运行中 ' + esc(runningJobs) + ' / 总计 ' + esc(totalJobs) + (failedJobs > 0 ? ' / 失败 ' + esc(failedJobs) : '') + '</div></div>' +
                    renderDenseJobsTable(jobs, { total: totalJobs }) +
                  '</div>' +
                '</div>' +
              '</div>' +
            "</details>"
            );
          }).join("")
        );
      } else {
        parts.push('<div class="empty">当前筛选条件下没有 session。</div>');
      }
      panel.innerHTML = parts.join("");
    }

    function renderLogs(data) {
      const logs = data.state.recentBrokerLogs || [];
      const panel = document.getElementById("logs-panel");
      if (!logs.length) {
        panel.innerHTML = '<div class="empty">最近没有抓到 broker 日志。</div>';
        return;
      }
      panel.innerHTML = logs.map((entry) => {
        const level = String(entry.level || "info").toLowerCase();
        const tone = level === "warn" ? "warn" : level === "error" ? "error" : "";
        const meta = entry.meta ? '<details><summary class="tiny">展开 meta</summary><pre>' + esc(JSON.stringify(entry.meta, null, 2)) + "</pre></details>" : "";
        return '<div class="log-entry ' + tone + '">' +
          '<div class="item-head"><div class="item-title">' + esc(entry.message || entry.raw || "log") + '</div>' + renderBadge(level, tone) + '</div>' +
          '<div class="meta"><span>' + esc(fmtTime(entry.ts)) + "</span></div>" +
          meta +
        "</div>";
      }).join("");
    }

    function render(data) {
      latestStatus = data;
      renderSummary(data);
      renderService(data);
      renderAccount(data);
      renderAuthFiles(data);
      renderSessions(data);
      renderLogs(data);
    }

    async function readOptionalFile(id) {
      const input = document.getElementById(id);
      const file = input.files && input.files[0];
      if (!file) return undefined;
      return await file.text();
    }

    function bindDialog(dialogId, openId, closeId) {
      const dialog = document.getElementById(dialogId);
      document.getElementById(openId).addEventListener("click", () => {
        if (typeof dialog.showModal === "function") {
          dialog.showModal();
        }
      });
      document.getElementById(closeId).addEventListener("click", () => dialog.close());
      dialog.addEventListener("click", (event) => {
        const rect = dialog.getBoundingClientRect();
        const inside =
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom;
        if (!inside) {
          dialog.close();
        }
      });
    }

    async function replaceSingleFile(options) {
      const button = document.getElementById(options.buttonId);
      const statusNode = document.getElementById(options.statusId);
      const dialog = document.getElementById(options.dialogId);
      button.disabled = true;
      statusNode.textContent = "正在写入新文件，并重启容器里的 Codex runtime…";
      replaceStatus.textContent = "";
      try {
        const pastedValue = options.textareaId ? document.getElementById(options.textareaId).value.trim() : "";
        const fileValue = options.fileInputId ? await readOptionalFile(options.fileInputId) : undefined;
        const content = pastedValue || fileValue;
        if (!content) {
          throw new Error("请先提供要替换的文件内容。");
        }
        const payload = {
          auth_json_content: undefined,
          credentials_json_content: undefined,
          config_toml_content: undefined,
          allow_active: document.getElementById(options.allowActiveId).checked
        };
        payload[options.payloadKey] = content;
        const response = await fetch("/admin/api/replace-auth", {
          method: "POST",
          headers: authHeaders({
            "content-type": "application/json"
          }),
          body: JSON.stringify(payload)
        });
        const result = await response.json();
        if (!response.ok) {
          throw new Error(result.error || "替换失败");
        }
        statusNode.innerHTML = '<span class="good">' + esc(options.successMessage) + "</span>";
        replaceStatus.innerHTML = '<span class="good">' + esc(options.successMessage) + "</span>";
        render(result.status);
        lastRefresh.textContent = "上次刷新：" + new Date().toLocaleTimeString();
        if (typeof dialog.close === "function") {
          dialog.close();
        }
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        statusNode.innerHTML = '<span class="danger">' + esc(message) + "</span>";
        replaceStatus.innerHTML = '<span class="danger">' + esc(message) + "</span>";
      } finally {
        button.disabled = false;
      }
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
        lastRefresh.textContent = "上次刷新：" + new Date().toLocaleTimeString();
      } catch (error) {
        document.getElementById("logs-panel").innerHTML =
          '<div class="empty danger">读取状态失败：' + esc(error && error.message ? error.message : String(error)) + "</div>";
      } finally {
        refreshButton.disabled = false;
      }
    }

    refreshButton.addEventListener("click", refresh);
    sessionSearch.addEventListener("input", () => {
      if (latestStatus) renderSessions(latestStatus);
    });
    sessionFilter.addEventListener("change", () => {
      if (latestStatus) renderSessions(latestStatus);
    });
    dialogs.forEach(([dialogId, openId, closeId]) => bindDialog(dialogId, openId, closeId));

    document.getElementById("submit-auth-dialog").addEventListener("click", () =>
      replaceSingleFile({
        dialogId: "auth-dialog",
        buttonId: "submit-auth-dialog",
        statusId: "auth-dialog-status",
        textareaId: "auth-json-text",
        fileInputId: "auth-json-file",
        allowActiveId: "allow-active-auth",
        payloadKey: "auth_json_content",
        successMessage: "auth.json 已替换完成，内置 Codex runtime 已重启。"
      })
    );

    document.getElementById("submit-credentials-dialog").addEventListener("click", () =>
      replaceSingleFile({
        dialogId: "credentials-dialog",
        buttonId: "submit-credentials-dialog",
        statusId: "credentials-dialog-status",
        textareaId: "credentials-json-text",
        fileInputId: "credentials-json-file",
        allowActiveId: "allow-active-credentials",
        payloadKey: "credentials_json_content",
        successMessage: ".credentials.json 已替换完成，内置 Codex runtime 已重启。"
      })
    );

    document.getElementById("submit-config-dialog").addEventListener("click", () =>
      replaceSingleFile({
        dialogId: "config-dialog",
        buttonId: "submit-config-dialog",
        statusId: "config-dialog-status",
        textareaId: "config-toml-text",
        fileInputId: "config-toml-file",
        allowActiveId: "allow-active-config",
        payloadKey: "config_toml_content",
        successMessage: "config.toml 已替换完成，内置 Codex runtime 已重启。"
      })
    );

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
