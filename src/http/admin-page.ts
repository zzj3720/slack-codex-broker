export function renderAdminPage(options: {
  readonly serviceName: string;
}): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(options.serviceName)} 管理台</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #07090c;
      --panel: #10141a;
      --panel-soft: #151b23;
      --panel-strong: #1d2630;
      --line: #27313c;
      --line-strong: #405161;
      --text: #eef3f6;
      --muted: #8b9aa7;
      --amber: #f6a23a;
      --cyan: #52c7d8;
      --green: #4bd28f;
      --red: #ff7468;
      --purple: #b792ff;
      --mono: "IBM Plex Mono", "SF Mono", "JetBrains Mono", ui-monospace, monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: var(--mono);
      font-size: 13px;
      line-height: 1.45;
    }
    .shell {
      max-width: 1640px;
      min-width: 980px;
      margin: 0 auto;
      padding: 18px;
    }
    .topbar {
      display: grid;
      grid-template-columns: minmax(260px, 1fr) auto;
      gap: 16px;
      align-items: end;
      padding-bottom: 14px;
      border-bottom: 1px solid var(--line-strong);
    }
    h1 {
      margin: 0;
      color: var(--text);
      font-size: 20px;
      letter-spacing: 0;
      text-transform: uppercase;
    }
    .subtitle {
      margin-top: 5px;
      color: var(--muted);
      font-size: 11px;
    }
    .top-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 10px;
      flex-wrap: wrap;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 28px;
      padding: 5px 8px;
      border: 1px solid var(--line);
      color: var(--muted);
      background: #090c10;
      font-size: 10px;
      text-transform: uppercase;
      white-space: nowrap;
    }
    button {
      min-height: 30px;
      border: 1px solid var(--line-strong);
      background: var(--panel-strong);
      color: var(--text);
      padding: 6px 11px;
      font-family: inherit;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
      text-transform: uppercase;
    }
    button:hover { border-color: var(--cyan); color: var(--cyan); }
    button.primary { border-color: var(--amber); background: var(--amber); color: #111; }
    button.secondary { background: transparent; color: var(--cyan); border-color: var(--cyan); }
    button.danger { background: transparent; color: var(--red); border-color: var(--red); }
    button:disabled { opacity: 0.5; cursor: default; }

    .command-grid {
      display: grid;
      grid-template-columns: minmax(360px, 1fr) minmax(360px, 1.1fr) minmax(320px, 0.9fr);
      gap: 12px;
      margin: 16px 0;
    }
    .panel {
      border: 1px solid var(--line);
      background: var(--panel);
      min-width: 0;
    }
    .panel-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      min-height: 38px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--line);
      background: var(--panel-soft);
    }
    .panel-title {
      color: var(--text);
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .panel-body { padding: 12px; }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 1px;
      border: 1px solid var(--line);
      background: var(--line);
    }
    .metric {
      min-height: 76px;
      padding: 10px 12px;
      background: #0b0f14;
    }
    .metric-label {
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
      margin-bottom: 5px;
    }
    .metric-value {
      color: var(--text);
      font-size: 24px;
      font-weight: 800;
      white-space: nowrap;
    }
    .metric-value.good { color: var(--green); }
    .metric-value.warn { color: var(--amber); }
    .metric-value.danger { color: var(--red); }
    .metric-detail {
      margin-top: 4px;
      color: var(--muted);
      font-size: 11px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .risk-strip {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
      margin-bottom: 12px;
    }
    .risk-cell {
      border: 1px solid var(--line);
      background: #0b0f14;
      padding: 9px;
    }
    .risk-number {
      font-size: 20px;
      font-weight: 800;
      color: var(--amber);
    }
    .risk-label {
      margin-top: 3px;
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
    }
    .risk-copy {
      min-height: 48px;
      padding: 10px;
      border: 1px solid var(--line);
      color: var(--muted);
      background: #0b0f14;
      font-size: 12px;
    }
    .operation-list {
      display: grid;
      gap: 8px;
    }
    .operation-row {
      display: grid;
      grid-template-columns: auto 1fr auto;
      gap: 10px;
      align-items: center;
      padding: 10px;
      border: 1px solid var(--line);
      background: #0b0f14;
    }
    .operation-main { min-width: 0; }
    .operation-title {
      color: var(--text);
      font-weight: 800;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .operation-detail {
      margin-top: 3px;
      color: var(--muted);
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .audit-list {
      display: grid;
      gap: 5px;
      margin-top: 10px;
      color: var(--muted);
      font-size: 11px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      padding: 2px 7px;
      border: 1px solid currentColor;
      font-size: 10px;
      font-weight: 800;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .badge.good { color: var(--green); }
    .badge.warn { color: var(--amber); }
    .badge.danger { color: var(--red); }
    .badge.info { color: var(--cyan); }
    .badge.purple { color: var(--purple); }

    .workspace {
      display: grid;
      grid-template-columns: minmax(620px, 1fr) 420px;
      gap: 16px;
      align-items: start;
    }
    .stack { display: grid; gap: 16px; }
    .toolbar {
      display: grid;
      grid-template-columns: minmax(240px, 1fr) 120px;
      gap: 10px;
      padding: 12px;
      border-bottom: 1px solid var(--line);
      background: #0b0f14;
    }
    input, textarea, select {
      width: 100%;
      min-height: 32px;
      border: 1px solid var(--line);
      background: #07090c;
      color: var(--text);
      padding: 7px 9px;
      font-family: inherit;
      font-size: 12px;
    }
    textarea { min-height: 140px; resize: vertical; }
    input:focus, textarea:focus, select:focus {
      outline: 1px solid var(--cyan);
      border-color: var(--cyan);
    }
    .session-list { display: grid; }
    .session-table-header,
    .session-summary {
      display: grid;
      grid-template-columns: minmax(180px, 1.2fr) 120px minmax(150px, 0.8fr) minmax(220px, 1fr) 76px;
      gap: 12px;
      align-items: center;
    }
    .session-table-header {
      padding: 9px 12px;
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
      border-bottom: 1px solid var(--line);
      background: #0b0f14;
    }
    .session-row {
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    .session-summary {
      padding: 12px;
      cursor: pointer;
    }
    .session-summary:hover { background: #131a22; }
    .session-key {
      color: var(--cyan);
      font-weight: 800;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .session-channel {
      margin-top: 4px;
      color: var(--muted);
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .session-body {
      padding: 14px 12px 16px;
      border-top: 1px solid var(--line);
      background: #090c10;
    }
    .session-inspector {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 12px;
      margin-top: 12px;
    }
    .mini-panel {
      border: 1px solid var(--line);
      background: #0b0f14;
      min-width: 0;
    }
    .mini-title {
      padding: 7px 9px;
      border-bottom: 1px solid var(--line);
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
    }
    .mini-body { padding: 9px; }
    .timeline {
      display: grid;
      gap: 7px;
    }
    .timeline-event {
      display: grid;
      grid-template-columns: 86px auto 1fr;
      gap: 8px;
      align-items: baseline;
      min-height: 26px;
      color: var(--muted);
      font-size: 11px;
    }
    .timeline-event strong {
      color: var(--text);
      font-size: 12px;
    }
    .table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    .table th {
      text-align: left;
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
      padding: 4px 6px;
      border-bottom: 1px solid var(--line);
    }
    .table td {
      padding: 6px;
      border-bottom: 1px solid rgba(255,255,255,0.04);
      vertical-align: top;
    }
    .maintenance-grid {
      display: grid;
      gap: 10px;
    }
    .profile-row {
      display: grid;
      gap: 8px;
      padding: 11px;
      border: 1px solid var(--line);
      background: #0b0f14;
    }
    .profile-row.is-active {
      border-color: var(--cyan);
      background: rgba(82, 199, 216, 0.06);
    }
    .profile-line {
      display: flex;
      gap: 8px;
      align-items: baseline;
      flex-wrap: wrap;
      min-width: 0;
    }
    .profile-account {
      color: var(--text);
      font-weight: 800;
      overflow-wrap: anywhere;
    }
    .profile-plan,
    .summary-detail {
      color: var(--muted);
      font-size: 11px;
    }
    .profile-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .quota-grid {
      display: grid;
      gap: 5px;
    }
    .quota-line {
      display: grid;
      grid-template-columns: 60px 88px 1fr;
      gap: 8px;
      color: var(--muted);
      font-size: 11px;
    }
    .quota-line strong { color: var(--text); }
    .deploy-actions {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      margin-bottom: 8px;
    }
    .release-stack {
      display: grid;
      gap: 8px;
      margin-top: 10px;
    }
    .release-row {
      border: 1px solid var(--line);
      background: #0b0f14;
      padding: 10px;
    }
    .log-list {
      max-height: 260px;
      overflow: auto;
      font-size: 11px;
    }
    .log-entry {
      display: grid;
      grid-template-columns: 76px 1fr;
      gap: 8px;
      padding: 6px 12px;
      border-bottom: 1px solid rgba(255,255,255,0.04);
    }
    .log-entry.warn { color: var(--amber); }
    .log-entry.error { color: var(--red); }
    dialog {
      width: 620px;
      max-width: 92vw;
      padding: 0;
      border: 1px solid var(--cyan);
      background: var(--panel);
      color: var(--text);
    }
    dialog::backdrop { background: rgba(0,0,0,0.72); }
    .modal-content {
      display: grid;
      gap: 14px;
      padding: 18px;
    }
    @media (max-width: 1120px) {
      .shell { min-width: 0; }
      .command-grid, .workspace { grid-template-columns: 1fr; }
      .session-table-header { display: none; }
      .session-summary { grid-template-columns: 1fr; }
      .session-inspector { grid-template-columns: 1fr; }
      .toolbar { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div>
        <h1>${escapeHtml(options.serviceName)} 管理台</h1>
        <div class="subtitle">会话、发布风险、账号状态和管理操作的资源控制台。</div>
      </div>
      <div class="top-actions">
        <span class="pill">刷新：10 秒</span>
        <span class="pill" id="last-refresh">就绪</span>
        <button id="refresh-button" class="secondary">刷新</button>
      </div>
    </header>

    <div class="command-grid">
      <section class="panel">
        <div class="panel-head">
          <div class="panel-title">运行状态</div>
          <span id="summary-service-badge" class="badge info">同步中</span>
        </div>
        <div class="panel-body">
          <div class="metric-grid">
            <div class="metric">
              <div class="metric-label">服务</div>
              <div class="metric-value good" id="summary-service">--</div>
              <div class="metric-detail" id="summary-service-detail">...</div>
            </div>
            <div class="metric">
              <div class="metric-label">账号</div>
              <div class="metric-value" id="summary-account">--</div>
              <div class="metric-detail" id="summary-account-detail">...</div>
            </div>
            <div class="metric">
              <div class="metric-label">会话</div>
              <div class="metric-value warn" id="summary-sessions">--</div>
              <div class="metric-detail" id="summary-sessions-detail">...</div>
            </div>
            <div class="metric">
              <div class="metric-label">任务</div>
              <div class="metric-value" id="summary-jobs">--</div>
              <div class="metric-detail" id="summary-jobs-detail">...</div>
            </div>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div class="panel-title">发布风险门禁</div>
          <span id="risk-badge" class="badge info">检查中</span>
        </div>
        <div class="panel-body">
          <div id="risk-panel"></div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div class="panel-title">操作记录</div>
          <span class="badge purple">审计</span>
        </div>
        <div class="panel-body">
          <div id="operations-panel" class="operation-list"></div>
          <div id="audit-panel" class="audit-list"></div>
        </div>
      </section>
    </div>

    <div class="workspace">
      <main class="stack">
        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">会话工作队列</div>
            <span class="summary-detail">待处理：<span id="session-open-count">0</span>（人：<span id="session-human-count">0</span> 系统：<span id="session-system-count">0</span>）</span>
          </div>
          <div class="toolbar">
            <input id="session-search" type="search" placeholder="筛选会话..." />
            <select id="session-filter">
              <option value="all">全部</option>
              <option value="active">活跃</option>
              <option value="inbound">有待处理消息</option>
              <option value="jobs">有运行任务</option>
              <option value="issues">有问题</option>
            </select>
          </div>
          <div class="session-table-header">
            <div>会话 / 频道</div>
            <div>状态 / Slack</div>
            <div>消息 / 任务</div>
            <div>当前线索</div>
            <div>操作</div>
          </div>
          <div id="sessions-panel" class="session-list"></div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">系统日志</div>
          </div>
          <div id="logs-panel" class="log-list"></div>
        </section>
      </main>

      <aside class="stack">
        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">发布</div>
            <button id="deploy-release-button" class="primary">发布</button>
          </div>
          <div class="panel-body">
            <div class="deploy-actions">
              <input id="deploy-ref-input" type="text" placeholder="提交 / 分支 / 标签" />
              <button id="rollback-release-button" class="secondary">回滚</button>
            </div>
            <div id="deploy-panel"></div>
            <div id="deploy-status" class="summary-detail" style="margin-top:8px;"></div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">认证档案</div>
            <button id="open-add-profile-dialog">新增</button>
          </div>
          <div id="auth-profiles-panel" class="panel-body maintenance-grid"></div>
          <div id="replace-status" class="summary-detail" style="padding:0 12px 12px;"></div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">GitHub 作者映射</div>
            <button id="open-github-author-dialog">新增</button>
          </div>
          <div class="toolbar" style="grid-template-columns:1fr; border-top:0;">
            <input id="github-author-search" type="search" placeholder="筛选作者..." />
          </div>
          <div id="github-authors-panel" class="panel-body maintenance-grid"></div>
          <div id="github-authors-status" class="summary-detail" style="padding:0 12px 12px;"></div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">运行信息</div>
          </div>
          <div id="service-card" class="panel-body summary-detail"></div>
        </section>
      </aside>
    </div>
  </div>

  <dialog id="add-profile-dialog"><div class="modal-content">
    <div class="panel-title">新增认证档案</div>
    <input id="profile-auth-file" type="file" accept="application/json,.json" />
    <textarea id="profile-auth-text" placeholder="在这里粘贴 auth.json..."></textarea>
    <div style="display:flex; gap:8px; justify-content:flex-end;">
      <button id="close-add-profile-dialog" class="secondary">取消</button>
      <button id="submit-add-profile-dialog" class="primary">保存</button>
    </div>
    <div id="add-profile-status" class="summary-detail"></div>
  </div></dialog>

  <dialog id="github-author-dialog"><div class="modal-content">
    <div class="panel-title">GitHub 作者映射</div>
    <input id="github-author-slack-user-id" type="text" placeholder="Slack 用户 ID（U123...）" />
    <input id="github-author-value" type="text" placeholder="姓名 <email@example.com>" />
    <div style="display:flex; gap:8px; justify-content:flex-end;">
      <button id="close-github-author-dialog" class="secondary">取消</button>
      <button id="submit-github-author-dialog" class="primary">保存</button>
    </div>
    <div id="github-author-dialog-status" class="summary-detail"></div>
  </div></dialog>

  <script>
    const refreshButton = document.getElementById("refresh-button");
    const replaceStatus = document.getElementById("replace-status");
    const deployStatus = document.getElementById("deploy-status");
    const githubAuthorsStatus = document.getElementById("github-authors-status");
    const lastRefresh = document.getElementById("last-refresh");
    const sessionSearch = document.getElementById("session-search");
    const sessionFilter = document.getElementById("session-filter");
    const githubAuthorSearch = document.getElementById("github-author-search");
    const addProfileDialog = document.getElementById("add-profile-dialog");
    const githubAuthorDialog = document.getElementById("github-author-dialog");
    const deployRefInput = document.getElementById("deploy-ref-input");
    const uiStateStorageKey = "admin-ui-state:" + window.location.pathname;
    const deferredUiStatePersistMs = 150;
    const sessionDetailCache = new Map();
    let latestStatus = null;
    let uiState = loadUiState();
    let uiStatePersistTimer = null;

    function esc(value) {
      return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
    }
    function defaultUiState() {
      return { sessionSearch: "", sessionFilter: "all", expandedSessionKeys: [] };
    }
    function normalizeUiState(value) {
      const next = value && typeof value === "object" ? value : {};
      const sessionFilterValue = ["all", "active", "inbound", "jobs", "issues"].includes(String(next.sessionFilter || "")) ? String(next.sessionFilter) : "all";
      const sessionSearchValue = typeof next.sessionSearch === "string" ? next.sessionSearch : "";
      const expandedSessionKeys = Array.isArray(next.expandedSessionKeys) ? [...new Set(next.expandedSessionKeys.map((item) => String(item)).filter(Boolean))] : [];
      return { sessionSearch: sessionSearchValue, sessionFilter: sessionFilterValue, expandedSessionKeys };
    }
    function loadUiState() {
      try {
        const raw = window.localStorage.getItem(uiStateStorageKey);
        return raw ? normalizeUiState(JSON.parse(raw)) : defaultUiState();
      } catch {
        return defaultUiState();
      }
    }
    function cancelScheduledUiStatePersistence() {
      if (uiStatePersistTimer == null) return;
      window.clearTimeout(uiStatePersistTimer);
      uiStatePersistTimer = null;
    }
    function persistUiState() {
      cancelScheduledUiStatePersistence();
      try { window.localStorage.setItem(uiStateStorageKey, JSON.stringify(uiState)); } catch {}
    }
    function scheduleUiStatePersistence() {
      cancelScheduledUiStatePersistence();
      uiStatePersistTimer = window.setTimeout(() => {
        uiStatePersistTimer = null;
        persistUiState();
      }, deferredUiStatePersistMs);
    }
    function updateUiState(patch, options) {
      uiState = normalizeUiState(Object.assign({}, uiState, patch || {}));
      if (options?.deferPersist) {
        scheduleUiStatePersistence();
        return;
      }
      persistUiState();
    }
    function isSessionExpanded(sessionKey) {
      return uiState.expandedSessionKeys.includes(String(sessionKey));
    }
    function updateSessionExpansion(sessionKey, expanded) {
      const next = new Set(uiState.expandedSessionKeys);
      if (expanded) next.add(String(sessionKey)); else next.delete(String(sessionKey));
      updateUiState({ expandedSessionKeys: [...next] });
    }
    function pruneExpandedSessionKeys(sessionKeys) {
      const allowedKeys = new Set((sessionKeys || []).map((sessionKey) => String(sessionKey)));
      const expandedSessionKeys = uiState.expandedSessionKeys.filter((sessionKey) => allowedKeys.has(sessionKey));
      if (expandedSessionKeys.length === uiState.expandedSessionKeys.length) return;
      updateUiState({ expandedSessionKeys });
    }
    function authHeaders(extra) {
      return Object.assign({}, extra || {});
    }
    function fmtTime(value) {
      if (!value) return "--";
      try { return new Date(value).toLocaleTimeString(); } catch { return String(value); }
    }
    function fmtDateTime(value) {
      if (!value) return "--";
      try { return new Date(value).toLocaleString(); } catch { return String(value); }
    }
    function fmtDuration(sec) {
      const s = Number(sec || 0);
      if (s <= 0) return "刚启动";
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      return (h > 0 ? h + " 小时 " : "") + m + " 分钟";
    }
    function formatRelativeDuration(ms) {
      const absMs = Math.abs(ms);
      const m = Math.round(absMs / 60000);
      if (m < 60) return m + " 分钟";
      const h = Math.round(absMs / 3600000);
      if (h < 48) return h + " 小时";
      return Math.round(absMs / 86400000) + " 天";
    }
    function formatResetTime(sec) {
      if (sec == null) return "未知";
      const delta = (Number(sec) * 1000) - Date.now();
      const rel = formatRelativeDuration(delta);
      return delta > 0 ? rel + "后" : rel + "前";
    }
    function clampPercent(value) {
      return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    }
    function statusTone(status) {
      const v = String(status || "").toLowerCase();
      if (["succeeded", "running", "active", "ok", "completed", "done"].includes(v)) return "good";
      if (["pending", "inflight", "registered", "starting", "idle", "started", "wait"].includes(v)) return "warn";
      if (["failed", "error", "stopped", "cancelled"].includes(v)) return "danger";
      if (["deploy", "rollback"].includes(v)) return "info";
      return "";
    }
    function statusLabel(value) {
      const labels = {
        active: "活跃",
        idle: "空闲",
        ok: "正常",
        running: "运行中",
        registered: "已注册",
        pending: "待处理",
        inflight: "处理中",
        done: "已完成",
        completed: "已完成",
        succeeded: "成功",
        failed: "失败",
        error: "错误",
        stopped: "已停止",
        cancelled: "已取消",
        started: "已开始",
        starting: "启动中",
        wait: "等待",
        final: "结束",
        block: "阻塞",
        progress: "进展",
        inspect: "查看",
        session: "会话",
        admin: "管理",
        audit: "审计",
        unknown: "未知",
        combined: "合并模式"
      };
      const key = String(value || "").toLowerCase();
      return labels[key] || String(value || "");
    }
    function operationLabel(value) {
      const labels = {
        deploy: "发布",
        rollback: "回滚",
        auth_profile_add: "新增认证档案",
        auth_profile_delete: "删除认证档案",
        auth_profile_activate: "切换认证档案",
        github_author_upsert: "保存 GitHub 作者",
        github_author_delete: "删除 GitHub 作者"
      };
      return labels[String(value || "")] || String(value || "");
    }
    function sourceLabel(value) {
      const labels = {
        app_mention: "提及",
        direct_message: "私信",
        thread_reply: "线程回复",
        background_job_event: "后台任务事件",
        unexpected_turn_stop: "异常停止"
      };
      return labels[String(value || "")] || String(value || "");
    }
    function renderBadge(label, tone) {
      return '<span class="badge ' + esc(tone || statusTone(label)) + '">' + esc(statusLabel(label)) + "</span>";
    }
    function pickOperationLabel(operation) {
      return operation?.request?.ref || operation?.request?.name || operation?.request?.slackUserId || operation?.id || "-";
    }

    function renderSummary(data) {
      const s = data.service || {};
      const st = data.state || {};
      const a = data.account || {};
      document.getElementById("summary-service").textContent = "在线";
      document.getElementById("summary-service-detail").textContent = "PID " + (s.pid || "-") + " · 运行 " + fmtDuration(s.uptimeSeconds);
      document.getElementById("summary-service-badge").textContent = statusLabel(s.mode || "admin");
      document.getElementById("summary-account").textContent = a.ok ? (a.account?.planType || "已登录") : "异常";
      document.getElementById("summary-account-detail").textContent = a.ok ? (a.account?.email || "无邮箱") : (a.error || "账号不可用");
      document.getElementById("summary-sessions").textContent = (st.activeCount || 0) + "/" + (st.sessionCount || 0);
      document.getElementById("summary-sessions-detail").textContent = "待处理：" + (st.openInboundCount || 0) + "（人：" + (st.openHumanInboundCount || 0) + " 系统：" + (st.openSystemInboundCount || 0) + "）";
      document.getElementById("summary-jobs").textContent = st.runningBackgroundJobCount || 0;
      document.getElementById("summary-jobs-detail").textContent = "失败：" + (st.failedBackgroundJobCount || 0);
      document.getElementById("session-open-count").textContent = st.openInboundCount || 0;
      document.getElementById("session-human-count").textContent = st.openHumanInboundCount || 0;
      document.getElementById("session-system-count").textContent = st.openSystemInboundCount || 0;
    }

    function renderRiskPanel(data) {
      const st = data.state || {};
      const active = Number(st.activeCount || 0);
      const open = Number(st.openInboundCount || 0);
      const running = Number(st.runningBackgroundJobCount || 0);
      const safe = active + open + running === 0;
      const badge = document.getElementById("risk-badge");
      badge.textContent = safe ? "安全" : "需要确认";
      badge.className = "badge " + (safe ? "good" : "warn");
      document.getElementById("risk-panel").innerHTML =
        '<div class="risk-strip">' +
          '<div class="risk-cell"><div class="risk-number">' + active + '</div><div class="risk-label">活跃回合</div></div>' +
          '<div class="risk-cell"><div class="risk-number">' + open + '</div><div class="risk-label">待处理消息</div></div>' +
          '<div class="risk-cell"><div class="risk-number">' + running + '</div><div class="risk-label">运行任务</div></div>' +
        '</div>' +
        '<div class="risk-copy">' + (safe
          ? '当前没有活跃工作，发布和回滚不需要额外确认。'
          : '发布和回滚会中断正在进行的管理工作，执行前必须显式确认。') + '</div>';
    }

    function renderOperations(data) {
      const operationsPanel = document.getElementById("operations-panel");
      const auditPanel = document.getElementById("audit-panel");
      const operations = data.operations || [];
      const events = data.auditEvents || [];
      if (!operations.length) {
        operationsPanel.innerHTML = '<div class="summary-detail">暂无管理操作</div>';
      } else {
        operationsPanel.innerHTML = operations.slice(0, 5).map((operation) =>
          '<div class="operation-row">' +
            renderBadge(operation.status || "unknown", statusTone(operation.status)) +
            '<div class="operation-main">' +
              '<div class="operation-title">' + esc(operationLabel(operation.kind)) + '</div>' +
              '<div class="operation-detail">' + esc(pickOperationLabel(operation)) + '</div>' +
            '</div>' +
            '<div class="summary-detail">' + esc(fmtTime(operation.updatedAt)) + '</div>' +
          '</div>'
        ).join("");
      }
      auditPanel.innerHTML = events.length
        ? events.slice(0, 6).map((event) => '<div>' + esc(fmtTime(event.createdAt) + " · " + operationLabel(event.action) + " · " + statusLabel(event.status)) + '</div>').join("")
        : "";
    }

    function renderService(data) {
      const s = data.service || {};
      document.getElementById("service-card").innerHTML =
        '<div style="display:grid; gap:6px;">' +
          '<div>名称：' + esc(s.name) + '</div>' +
          '<div>模式：' + esc(statusLabel(s.mode)) + '</div>' +
          '<div>端口：' + esc(s.port) + '</div>' +
          '<div>启动：' + esc(fmtDateTime(s.startedAt)) + '</div>' +
          '<div style="word-break:break-all;">会话目录：' + esc(s.sessionsRoot) + '</div>' +
          '<div style="word-break:break-all;">CODEX_HOME: ' + esc(s.codexHome) + '</div>' +
        '</div>';
    }

    function renderReleaseCard(label, release) {
      if (!release?.targetPath) return '<div class="summary-detail">' + esc(label + "：无") + "</div>";
      const metadata = release.metadata || {};
      const heading = metadata.shortRevision || metadata.revision || release.targetPath.split("/").pop() || "release";
      return '<div class="release-row">' +
        '<div class="profile-line"><span class="profile-account">' + esc(label + "：" + heading) + '</span><span class="profile-plan">' + esc(metadata.branch || "detached") + '</span></div>' +
        '<div class="summary-detail">' + esc(metadata.builtAt ? fmtDateTime(metadata.builtAt) : release.targetPath) + '</div>' +
      '</div>';
    }
    function renderDeployment(data) {
      const deployment = data.deployment;
      const panel = document.getElementById("deploy-panel");
      if (!deployment) {
        panel.innerHTML = '<div class="summary-detail">Worker 发布状态不可用</div>';
        return;
      }
      const admin = deployment.admin || {};
      const worker = deployment.worker || {};
      panel.innerHTML =
        '<div style="display:flex; gap:6px; flex-wrap:wrap;">' +
          renderBadge(admin.launchdLoaded ? "管理进程已加载" : "管理进程未运行", admin.launchdLoaded ? "good" : "danger") +
          renderBadge(admin.healthOk ? "管理 HTTP 正常" : "管理 HTTP 异常", admin.healthOk ? "good" : "danger") +
          renderBadge(worker.launchdLoaded ? "工作进程已加载" : "工作进程未运行", worker.launchdLoaded ? "good" : "danger") +
          renderBadge(worker.healthOk ? "HTTP 正常" : "HTTP 异常", worker.healthOk ? "good" : "danger") +
          renderBadge(worker.readyOk ? "Codex 就绪" : "Codex 异常", worker.readyOk ? "good" : "danger") +
        '</div>' +
        '<div class="release-stack">' +
          renderReleaseCard("当前版本", deployment.currentRelease) +
          renderReleaseCard("上一版本", deployment.previousRelease) +
        '</div>';
    }

    function renderProfileQuota(rateLimits) {
      if (!rateLimits || !rateLimits.ok) return '<div class="summary-detail">' + esc(rateLimits?.error || "额度不可用") + '</div>';
      const snapshot = rateLimits.rateLimits || {};
      const primary = snapshot.primary;
      const secondary = snapshot.secondary;
      return '<div class="quota-grid">' +
        '<div class="quota-line"><span>5 小时</span><strong>' + esc(primary ? "剩余 " + String(100 - clampPercent(primary.usedPercent)) + "%" : "--") + '</strong><span>' + esc(primary ? formatResetTime(primary.resetsAt) : "不可用") + '</span></div>' +
        '<div class="quota-line"><span>每周</span><strong>' + esc(secondary ? "剩余 " + String(100 - clampPercent(secondary.usedPercent)) + "%" : "--") + '</strong><span>' + esc(secondary ? formatResetTime(secondary.resetsAt) : "不可用") + '</span></div>' +
      '</div>';
    }
    function renderAuthProfiles(data) {
      const authProfiles = data.authProfiles || {};
      const profiles = [...(authProfiles.profiles || [])].sort((left, right) => {
        if (left.active !== right.active) return left.active ? -1 : 1;
        return String(right.mtime || "").localeCompare(String(left.mtime || ""));
      });
      const panel = document.getElementById("auth-profiles-panel");
      if (!profiles.length) {
        panel.innerHTML = '<div class="summary-detail">暂无认证档案</div>';
        return;
      }
      panel.innerHTML = profiles.map((profile) => {
        const account = profile.account || {};
        const email = account.ok ? (account.account?.email || "未知账号") : "账号异常";
        const plan = account.ok ? (account.account?.planType || account.account?.type || "ChatGPT") : (account.error || "账号不可用");
        return '<div class="profile-row' + (profile.active ? " is-active" : "") + '">' +
          '<div class="profile-line"><span class="profile-account">' + esc(email) + '</span><span class="profile-plan">' + esc(plan) + '</span>' + (profile.active ? renderBadge("active", "info") : "") + '</div>' +
          renderProfileQuota(profile.rateLimits) +
          '<div class="profile-actions">' +
            '<button class="secondary" data-activate-profile="' + esc(profile.name) + '"' + (profile.active ? " disabled" : "") + '>使用</button>' +
            '<button class="danger" data-delete-profile="' + esc(profile.name) + '"' + (profile.active ? " disabled" : "") + '>删除</button>' +
          '</div>' +
        '</div>';
      }).join("");
      document.querySelectorAll("[data-activate-profile]").forEach((button) => {
        button.addEventListener("click", async () => {
          const name = button.getAttribute("data-activate-profile");
          if (!name) return;
          const allowActive = await confirmInterruptRisk("auth_profile_activate", "切换认证档案");
          if (allowActive == null) return;
          await activateProfile(name, allowActive);
        });
      });
      document.querySelectorAll("[data-delete-profile]").forEach((button) => {
        button.addEventListener("click", async () => {
          const name = button.getAttribute("data-delete-profile");
          if (!name || !window.confirm("删除认证档案 " + name + "？")) return;
          await deleteProfile(name);
        });
      });
    }

    function renderGitHubAuthors(data) {
      const mappings = [...(data.githubAuthorMappings?.mappings || [])];
      const panel = document.getElementById("github-authors-panel");
      const query = String(githubAuthorSearch.value || "").toLowerCase();
      const filtered = mappings.filter((mapping) => {
        if (!query) return true;
        return [mapping.slackUserId, mapping.githubAuthor, mapping.slackIdentity?.displayName, mapping.slackIdentity?.realName, mapping.slackIdentity?.username, mapping.slackIdentity?.email].some((value) => String(value || "").toLowerCase().includes(query));
      });
      if (!filtered.length) {
        panel.innerHTML = '<div class="summary-detail">暂无 GitHub 作者映射</div>';
        return;
      }
      panel.innerHTML = filtered.map((mapping) => {
        const identity = mapping.slackIdentity || {};
        const label = identity.realName || identity.displayName || identity.username || mapping.slackUserId;
        const detail = [mapping.slackUserId, identity.email].filter(Boolean).join(" · ");
        return '<div class="profile-row">' +
          '<div class="profile-line"><span class="profile-account">' + esc(label) + '</span><span class="profile-plan">' + esc(detail || mapping.slackUserId) + '</span>' + renderBadge(mapping.source === "manual" ? "手动" : "自动", mapping.source === "manual" ? "good" : "warn") + '</div>' +
          '<div class="summary-detail">' + esc(mapping.githubAuthor) + '</div>' +
          '<div class="summary-detail">更新：' + esc(fmtDateTime(mapping.updatedAt)) + '</div>' +
          '<div class="profile-actions">' +
            '<button class="secondary" data-edit-github-author="' + esc(mapping.slackUserId) + '" data-edit-github-author-value="' + esc(mapping.githubAuthor) + '">编辑</button>' +
            '<button class="danger" data-delete-github-author="' + esc(mapping.slackUserId) + '">删除</button>' +
          '</div>' +
        '</div>';
      }).join("");
      document.querySelectorAll("[data-edit-github-author]").forEach((button) => {
        button.addEventListener("click", () => {
          document.getElementById("github-author-dialog-status").textContent = "";
          document.getElementById("github-author-slack-user-id").value = button.getAttribute("data-edit-github-author") || "";
          document.getElementById("github-author-value").value = button.getAttribute("data-edit-github-author-value") || "";
          githubAuthorDialog.showModal();
        });
      });
      document.querySelectorAll("[data-delete-github-author]").forEach((button) => {
        button.addEventListener("click", async () => {
          const slackUserId = button.getAttribute("data-delete-github-author");
          if (!slackUserId || !window.confirm("删除 " + slackUserId + " 的 GitHub 作者映射？")) return;
          await deleteGitHubAuthorMapping(slackUserId);
        });
      });
    }

    function summarizeSessionLead(s) {
      if (s.lastTurnSignalKind) return statusLabel(s.lastTurnSignalKind) + "：" + (s.lastTurnSignalReason || "");
      if (s.openInbound?.length) return s.openInbound[0].textPreview || "新消息";
      if (s.backgroundJobs?.length) {
        const r = s.backgroundJobs.find((j) => j.status === "running") || s.backgroundJobs[0];
        return (r.kind || "任务") + "（" + statusLabel(r.status || "?") + "）";
      }
      return "空闲";
    }
    function renderSessions(data) {
      const panel = document.getElementById("sessions-panel");
      const list = data.state?.sessions || [];
      pruneExpandedSessionKeys(list.map((session) => session.key));
      const query = (sessionSearch.value || "").toLowerCase();
      const mode = sessionFilter.value;
      const filtered = list.filter((s) => {
        if (mode === "active" && !s.activeTurnId) return false;
        if (mode === "inbound" && !s.openInboundCount) return false;
        if (mode === "jobs" && !s.runningBackgroundJobCount) return false;
        if (mode === "issues" && !s.failedBackgroundJobCount) return false;
        if (!query) return true;
        return [s.key, s.channelId, s.workspacePath].some((v) => String(v || "").toLowerCase().includes(query));
      });
      if (!filtered.length) {
        panel.innerHTML = '<div style="padding:18px; color:var(--muted); text-align:center;">没有匹配的会话</div>';
        return;
      }
      panel.innerHTML = filtered.map((s) => {
        const isActive = !!s.activeTurnId;
        const lead = summarizeSessionLead(s);
        const expanded = isSessionExpanded(s.key);
        return '<details class="session-row" data-session-key="' + esc(s.key) + '"' + (expanded ? " open" : "") + '>' +
          '<summary class="session-summary">' +
            '<div><div class="session-key">' + esc(s.key) + '</div><div class="session-channel">' + esc(s.channelId) + ' · ' + esc(s.workspacePath || "") + '</div></div>' +
            '<div>' + renderBadge(isActive ? "active" : "idle", isActive ? "good" : "warn") + '<div class="summary-detail">更新：' + esc(fmtTime(s.updatedAt)) + '</div></div>' +
            '<div><strong>待处理：' + (s.openInboundCount || 0) + '（人：' + (s.openHumanInboundCount || 0) + ' 系统：' + (s.openSystemInboundCount || 0) + '）</strong><div class="summary-detail">任务：' + (s.runningBackgroundJobCount || 0) + '</div></div>' +
            '<div class="summary-detail" title="' + esc(lead) + '">' + esc(lead) + '</div>' +
            '<div>' + renderBadge("inspect", "info") + '</div>' +
          '</summary>' +
          '<div class="session-body">' +
            '<div class="summary-detail">工作目录：' + esc(s.workspacePath) + '</div>' +
            '<div class="session-inspector">' +
              '<div class="mini-panel"><div class="mini-title">时间线</div><div class="mini-body"><div class="timeline" data-session-timeline="' + esc(s.key) + '">' + renderTimelinePlaceholder(s) + '</div></div></div>' +
              '<div class="mini-panel"><div class="mini-title">消息 / 任务</div><div class="mini-body">' + renderInboundTable(s.openInbound) + renderJobsTable(s.backgroundJobs) + '</div></div>' +
            '</div>' +
          '</div>' +
        '</details>';
      }).join("");
      panel.querySelectorAll(".session-row").forEach((row) => {
        row.addEventListener("toggle", () => {
          const sessionKey = row.getAttribute("data-session-key");
          if (!sessionKey) return;
          updateSessionExpansion(sessionKey, row.open);
          if (row.open) loadSessionTimeline(sessionKey, row);
        });
        if (row.open) loadSessionTimeline(row.getAttribute("data-session-key"), row);
      });
    }
    function renderTimelinePlaceholder(session) {
      return '<div class="timeline-event"><span>' + esc(fmtTime(session.createdAt)) + '</span>' + renderBadge("session", "info") + '<strong>已创建</strong></div>';
    }
    function renderTimelineEvents(events) {
      if (!events?.length) return '<div class="summary-detail">暂无时间线事件</div>';
      return events.slice(0, 12).map((event) =>
        '<div class="timeline-event">' +
          '<span>' + esc(fmtTime(event.at)) + '</span>' +
          renderBadge(event.status || event.type, statusTone(event.status || event.type)) +
          '<strong>' + esc(event.summary || event.type) + '</strong>' +
        '</div>'
      ).join("");
    }
    async function loadSessionTimeline(sessionKey, row) {
      if (!sessionKey) return;
      const target = row.querySelector('[data-session-timeline="' + window.CSS.escape(sessionKey) + '"]');
      if (!target) return;
      if (sessionDetailCache.has(sessionKey)) {
        target.innerHTML = renderTimelineEvents(sessionDetailCache.get(sessionKey));
        return;
      }
      target.innerHTML = '<div class="summary-detail">正在加载时间线...</div>';
      try {
        const response = await fetch("/admin/api/sessions/" + encodeURIComponent(sessionKey) + "/timeline", { headers: authHeaders() });
        const payload = await parseResponse(response);
        const events = payload.events || [];
        sessionDetailCache.set(sessionKey, events);
        target.innerHTML = renderTimelineEvents(events);
      } catch (error) {
        target.innerHTML = '<div class="summary-detail">' + esc(error instanceof Error ? error.message : String(error)) + '</div>';
      }
    }
    function renderInboundTable(items) {
      if (!items?.length) return '<div class="summary-detail" style="margin-bottom:8px;">没有待处理消息</div>';
      return '<table class="table"><thead><tr><th>来源</th><th>消息</th></tr></thead><tbody>' +
        items.map((i) => '<tr><td>' + esc(sourceLabel(i.source)) + '</td><td>' + esc(i.textPreview) + '</td></tr>').join("") +
        '</tbody></table>';
    }
    function renderJobsTable(jobs) {
      if (!jobs?.length) return '<div class="summary-detail">没有任务</div>';
      return '<table class="table" style="margin-top:10px;"><thead><tr><th>状态</th><th>类型</th></tr></thead><tbody>' +
        jobs.slice(0, 5).map((j) => '<tr><td>' + renderBadge(j.status, statusTone(j.status)) + '</td><td>' + esc(j.kind) + '</td></tr>').join("") +
        '</tbody></table>';
    }
    function renderLogs(data) {
      const logs = data.state?.recentBrokerLogs || [];
      const panel = document.getElementById("logs-panel");
      if (!logs.length) {
        panel.innerHTML = '<div style="padding:12px; color:var(--muted)">暂无日志</div>';
        return;
      }
      panel.innerHTML = logs.map((entry) => {
        const tone = statusTone(entry.level);
        return '<div class="log-entry ' + tone + '"><span>' + esc(fmtTime(entry.ts)) + '</span><span>' + esc(entry.message || entry.raw || "") + '</span></div>';
      }).join("");
    }

    function render(data) {
      latestStatus = data;
      renderSummary(data);
      renderRiskPanel(data);
      renderOperations(data);
      renderService(data);
      renderDeployment(data);
      renderAuthProfiles(data);
      renderGitHubAuthors(data);
      renderSessions(data);
      renderLogs(data);
    }
    async function parseResponse(response) {
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) throw new Error(payload.error || response.statusText || "请求失败");
      return payload;
    }
    async function loadPreflight(operation) {
      const response = await fetch("/admin/api/preflight?operation=" + encodeURIComponent(operation), { headers: authHeaders() });
      return await parseResponse(response);
    }
    async function confirmInterruptRisk(operation, verb) {
      const preflight = await loadPreflight(operation);
      if (preflight.safe) return false;
      const detail = "活跃：" + (preflight.activeCount || 0) + " · 待处理：" + (preflight.openInboundCount || 0) + " · 运行任务：" + (preflight.runningBackgroundJobCount || 0);
      return window.confirm(verb + " 会中断正在进行的管理工作。" + detail + "。继续？") ? true : null;
    }

    async function refresh() {
      refreshButton.disabled = true;
      try {
        const response = await fetch("/admin/api/status", { headers: authHeaders() });
        render(await parseResponse(response));
        lastRefresh.textContent = "已同步：" + new Date().toLocaleTimeString();
      } catch (error) {
        lastRefresh.textContent = "错误：" + (error instanceof Error ? error.message : String(error));
      } finally {
        refreshButton.disabled = false;
      }
    }
    async function activateProfile(name, allowActive) {
      replaceStatus.textContent = "正在切换认证档案...";
      try {
        const response = await fetch("/admin/api/auth-profiles/" + encodeURIComponent(name) + "/activate", {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ allow_active: allowActive })
        });
        const payload = await parseResponse(response);
        render(payload.status);
        replaceStatus.innerHTML = '<span style="color:var(--green)">认证档案已切换</span>';
      } catch (error) {
        replaceStatus.innerHTML = '<span style="color:var(--red)">' + esc(error instanceof Error ? error.message : String(error)) + '</span>';
      }
    }
    async function deleteProfile(name) {
      replaceStatus.textContent = "正在删除认证档案...";
      try {
        const response = await fetch("/admin/api/auth-profiles/" + encodeURIComponent(name), { method: "DELETE", headers: authHeaders() });
        const payload = await parseResponse(response);
        render(payload.status);
        replaceStatus.innerHTML = '<span style="color:var(--green)">认证档案已删除</span>';
      } catch (error) {
        replaceStatus.innerHTML = '<span style="color:var(--red)">' + esc(error instanceof Error ? error.message : String(error)) + '</span>';
      }
    }
    async function submitAddProfile() {
      const status = document.getElementById("add-profile-status");
      const fileInput = document.getElementById("profile-auth-file");
      const textArea = document.getElementById("profile-auth-text");
      const submitButton = document.getElementById("submit-add-profile-dialog");
      status.textContent = "正在保存...";
      submitButton.disabled = true;
      try {
        const content = textArea.value.trim() || (fileInput.files[0] ? await fileInput.files[0].text() : "");
        if (!content) throw new Error("必须提供 auth.json");
        const response = await fetch("/admin/api/auth-profiles", {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ auth_json_content: content })
        });
        const payload = await parseResponse(response);
        render(payload.status);
        status.innerHTML = '<span style="color:var(--green)">认证档案已保存</span>';
        replaceStatus.innerHTML = '<span style="color:var(--green)">认证档案已保存</span>';
        addProfileDialog.close();
        fileInput.value = "";
        textArea.value = "";
      } catch (error) {
        status.innerHTML = '<span style="color:var(--red)">' + esc(error instanceof Error ? error.message : String(error)) + '</span>';
      } finally {
        submitButton.disabled = false;
      }
    }
    async function deployRelease() {
      const ref = deployRefInput.value.trim();
      if (!ref) {
        deployStatus.innerHTML = '<span style="color:var(--red)">必须填写发布目标</span>';
        return;
      }
      try {
        const allowActive = await confirmInterruptRisk("deploy", "发布");
        if (allowActive == null) return;
        deployStatus.textContent = "正在发布...";
        const response = await fetch("/admin/api/deploy", {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ ref, allow_active: allowActive })
        });
        const payload = await parseResponse(response);
        render(payload.status);
        deployStatus.innerHTML = '<span style="color:var(--green)">已发布 ' + esc(ref) + " · 操作 " + esc(payload.operation?.id || "") + '</span>';
      } catch (error) {
        deployStatus.innerHTML = '<span style="color:var(--red)">' + esc(error instanceof Error ? error.message : String(error)) + '</span>';
      }
    }
    async function rollbackRelease() {
      try {
        const allowActive = await confirmInterruptRisk("rollback", "回滚");
        if (allowActive == null) return;
        deployStatus.textContent = "正在回滚...";
        const response = await fetch("/admin/api/rollback", {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ allow_active: allowActive })
        });
        const payload = await parseResponse(response);
        render(payload.status);
        deployStatus.innerHTML = '<span style="color:var(--green)">已回滚 · 操作 ' + esc(payload.operation?.id || "") + '</span>';
      } catch (error) {
        deployStatus.innerHTML = '<span style="color:var(--red)">' + esc(error instanceof Error ? error.message : String(error)) + '</span>';
      }
    }
    async function submitGitHubAuthorMapping() {
      const slackUserId = document.getElementById("github-author-slack-user-id").value.trim();
      const githubAuthor = document.getElementById("github-author-value").value.trim();
      const status = document.getElementById("github-author-dialog-status");
      const submitButton = document.getElementById("submit-github-author-dialog");
      status.textContent = "正在保存...";
      submitButton.disabled = true;
      try {
        if (!slackUserId || !githubAuthor) throw new Error("必须填写 Slack 用户 ID 和 GitHub 作者");
        const response = await fetch("/admin/api/github-authors", {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ slack_user_id: slackUserId, github_author: githubAuthor })
        });
        const payload = await parseResponse(response);
        render(payload.status);
        githubAuthorsStatus.innerHTML = '<span style="color:var(--green)">作者映射已保存</span>';
        status.innerHTML = '<span style="color:var(--green)">作者映射已保存</span>';
        githubAuthorDialog.close();
      } catch (error) {
        status.innerHTML = '<span style="color:var(--red)">' + esc(error instanceof Error ? error.message : String(error)) + '</span>';
      } finally {
        submitButton.disabled = false;
      }
    }
    async function deleteGitHubAuthorMapping(slackUserId) {
      githubAuthorsStatus.textContent = "正在删除作者映射...";
      try {
        const response = await fetch("/admin/api/github-authors/" + encodeURIComponent(slackUserId), { method: "DELETE", headers: authHeaders() });
        const payload = await parseResponse(response);
        render(payload.status);
        githubAuthorsStatus.innerHTML = '<span style="color:var(--green)">作者映射已删除</span>';
      } catch (error) {
        githubAuthorsStatus.innerHTML = '<span style="color:var(--red)">' + esc(error instanceof Error ? error.message : String(error)) + '</span>';
      }
    }

    sessionSearch.value = uiState.sessionSearch;
    sessionFilter.value = uiState.sessionFilter;
    refreshButton.onclick = refresh;
    sessionSearch.oninput = () => {
      updateUiState({ sessionSearch: sessionSearch.value }, { deferPersist: true });
      if (latestStatus) renderSessions(latestStatus);
    };
    sessionSearch.onblur = () => persistUiState();
    sessionFilter.onchange = () => {
      updateUiState({ sessionFilter: sessionFilter.value });
      if (latestStatus) renderSessions(latestStatus);
    };
    githubAuthorSearch.oninput = () => { if (latestStatus) renderGitHubAuthors(latestStatus); };
    document.getElementById("open-add-profile-dialog").onclick = () => {
      document.getElementById("add-profile-status").textContent = "";
      addProfileDialog.showModal();
    };
    document.getElementById("open-github-author-dialog").onclick = () => {
      document.getElementById("github-author-dialog-status").textContent = "";
      document.getElementById("github-author-slack-user-id").value = "";
      document.getElementById("github-author-value").value = "";
      githubAuthorDialog.showModal();
    };
    document.getElementById("deploy-release-button").onclick = deployRelease;
    document.getElementById("rollback-release-button").onclick = rollbackRelease;
    document.getElementById("close-add-profile-dialog").onclick = () => addProfileDialog.close();
    document.getElementById("close-github-author-dialog").onclick = () => githubAuthorDialog.close();
    document.getElementById("submit-add-profile-dialog").onclick = submitAddProfile;
    document.getElementById("submit-github-author-dialog").onclick = submitGitHubAuthorMapping;
    addProfileDialog.onclick = (event) => { if (event.target === addProfileDialog) addProfileDialog.close(); };
    githubAuthorDialog.onclick = (event) => { if (event.target === githubAuthorDialog) githubAuthorDialog.close(); };
    refresh();
    window.setInterval(refresh, 10000);
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
