export function renderAdminPage(options: {
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
      --accent: #ff962d;
      --accent-soft: rgba(255, 150, 45, 0.1);
      --bg: #050505;
      --panel: #0a0a0a;
      --border: rgba(255, 150, 45, 0.2);
      --border-strong: rgba(255, 150, 45, 0.4);
      --text: #eee;
      --muted: #888;
      --good: #34dd93;
      --warn: #ffcb63;
      --danger: #ff7458;
      --mono: "IBM Plex Mono", "SF Mono", "JetBrains Mono", ui-monospace, monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: var(--mono);
      font-size: 13px;
      line-height: 1.4;
    }
    .wrap {
      max-width: 1600px;
      margin: 0 auto;
      padding: 16px;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      border-bottom: 2px solid var(--accent);
      padding-bottom: 8px;
      margin-bottom: 16px;
    }
    h1 { margin: 0; font-size: 18px; text-transform: uppercase; color: var(--accent); }
    .header-meta { display: flex; gap: 12px; }
    .header-tools {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    
    .grid-summary {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 1px;
      background: var(--border);
      border: 1px solid var(--border);
      margin-bottom: 16px;
    }
    .summary-item {
      background: var(--panel);
      padding: 12px;
    }
    .summary-label { font-size: 10px; color: var(--muted); text-transform: uppercase; margin-bottom: 4px; }
    .summary-value { font-size: 20px; font-weight: bold; color: var(--accent); }
    .summary-detail { font-size: 11px; color: var(--muted); margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    .main-layout {
      display: grid;
      grid-template-columns: 1fr 400px;
      gap: 16px;
      align-items: start;
    }
    section {
      border: 1px solid var(--border);
      background: var(--panel);
      margin-bottom: 16px;
    }
    .section-head {
      background: var(--accent-soft);
      padding: 6px 12px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .section-title { font-size: 12px; font-weight: bold; text-transform: uppercase; color: var(--accent); }
    
    .toolbar { display: flex; gap: 8px; padding: 12px; border-bottom: 1px solid var(--border); background: rgba(255,255,255,0.02); }
    .toolbar input, .toolbar select { 
      background: #000; border: 1px solid var(--border); color: var(--text); 
      padding: 6px 10px; font-family: inherit; font-size: 12px; 
    }
    .toolbar input[type="search"] { flex: 1; }

    .session-table-header {
      display: grid;
      grid-template-columns: 1.5fr 1fr 1.2fr 1fr 80px;
      gap: 8px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
    }
    .session-list { display: grid; }
    .session-row { border-bottom: 1px solid var(--border); }
    .session-summary {
      display: grid;
      grid-template-columns: 1.5fr 1fr 1.2fr 1fr 80px;
      gap: 8px;
      padding: 10px 12px;
      cursor: pointer;
      align-items: center;
    }
    .session-summary:hover { background: rgba(255,150,45,0.05); }
    .session-key { color: var(--accent); font-weight: bold; overflow: hidden; text-overflow: ellipsis; }
    .session-body { padding: 12px; background: #000; border-top: 1px solid var(--border); }

    .tui-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .tui-table th { text-align: left; color: var(--muted); padding: 4px 8px; border-bottom: 1px solid var(--border); font-size: 10px; text-transform: uppercase; }
    .tui-table td { padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,0.05); }

    .profile-row {
      display: grid;
      gap: 8px;
      width: 100%;
      padding: 12px;
      border: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.01);
    }
    .profile-row.is-active {
      border-color: var(--border-strong);
      background: rgba(255, 150, 45, 0.05);
    }
    .profile-line {
      display: flex;
      gap: 8px;
      align-items: baseline;
      flex-wrap: wrap;
    }
    .profile-account {
      font-weight: bold;
      color: var(--accent);
    }
    .profile-plan,
    .profile-quota {
      color: var(--muted);
      font-size: 11px;
    }
    .profile-quota {
      display: grid;
      gap: 2px;
    }
    .profile-quota-line {
      display: grid;
      grid-template-columns: 56px 88px 1fr;
      gap: 8px;
      align-items: baseline;
    }
    .profile-quota-label {
      color: var(--muted);
    }
    .profile-quota-value {
      color: var(--text);
      font-weight: bold;
    }
    .profile-quota-reset {
      color: var(--muted);
      text-align: right;
    }
    .profile-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    
    .badge {
      display: inline-block; padding: 2px 6px; font-size: 10px; font-weight: bold;
      text-transform: uppercase; border: 1px solid currentColor;
    }
    .badge.good { color: var(--good); }
    .badge.warn { color: var(--warn); }
    .badge.danger { color: var(--danger); }

    button {
      background: var(--accent); color: #000; border: none; padding: 6px 12px;
      font-family: inherit; font-size: 11px; font-weight: bold; cursor: pointer;
      text-transform: uppercase;
    }
    button.secondary { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
    button.danger { background: transparent; color: var(--danger); border: 1px solid var(--danger); }
    button:disabled { opacity: 0.5; cursor: default; }
    
    textarea, input[type="password"], input[type="file"], input[type="text"] {
      width: 100%; background: #000; border: 1px solid var(--border); color: var(--text);
      padding: 8px; font-family: inherit; font-size: 12px;
    }
    textarea { min-height: 120px; }
    
    dialog {
      background: var(--panel); border: 2px solid var(--accent); color: var(--text);
      padding: 0; width: 600px; max-width: 90vw;
    }
    dialog::backdrop { background: rgba(0,0,0,0.8); backdrop-filter: blur(2px); }
    .modal-content { padding: 20px; display: grid; gap: 16px; }
    
    .log-list { max-height: 400px; overflow-y: auto; font-size: 11px; }
    .log-entry { padding: 4px 12px; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .log-entry.warn { color: var(--warn); background: rgba(255, 203, 99, 0.05); }
    .log-entry.error { color: var(--danger); background: rgba(255, 116, 88, 0.05); }
    @media (max-width: 1000px) {
      .main-layout { grid-template-columns: 1fr; }
      .grid-summary { grid-template-columns: 1fr 1fr; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>${escapeHtml(options.serviceName)} ADMIN</h1>
      <div class="header-meta">
        <span class="badge">REFRESH: 10S</span>
        <div class="header-tools">
          <button id="refresh-button" class="secondary">REFRESH</button>
        </div>
      </div>
    </header>

    <div class="grid-summary">
      <div class="summary-item">
        <div class="summary-label">SERVICE</div>
        <div class="summary-value" id="summary-service">--</div>
        <div class="summary-detail" id="summary-service-detail">...</div>
      </div>
      <div class="summary-item">
        <div class="summary-label">ACCOUNT</div>
        <div class="summary-value" id="summary-account">--</div>
        <div class="summary-detail" id="summary-account-detail">...</div>
      </div>
      <div class="summary-item">
        <div class="summary-label">SESSIONS</div>
        <div class="summary-value" id="summary-sessions">--</div>
        <div class="summary-detail" id="summary-sessions-detail">...</div>
      </div>
      <div class="summary-item">
        <div class="summary-label">JOBS</div>
        <div class="summary-value" id="summary-jobs">--</div>
        <div class="summary-detail" id="summary-jobs-detail">...</div>
      </div>
    </div>

    <div class="main-layout">
      <div class="stack-main">
        <section>
          <div class="section-head">
            <div class="section-title">Sessions</div>
            <div id="last-refresh" style="font-size:10px; color:var(--muted)">READY</div>
          </div>
          <div class="toolbar">
            <input id="session-search" type="search" placeholder="FILTER SESSIONS..." />
            <select id="session-filter">
              <option value="all">ALL</option>
              <option value="active">ACTIVE</option>
              <option value="inbound">INBOUND</option>
              <option value="jobs">JOBS</option>
              <option value="issues">ISSUES</option>
            </select>
          </div>
          <div class="session-table-header">
            <div>Session Key / Channel</div>
            <div>Status / Slack</div>
            <div>Inbound / Jobs</div>
            <div>Current Lead</div>
            <div>Action</div>
          </div>
          <div id="sessions-panel" class="session-list"></div>
        </section>

        <section>
          <div class="section-head">
            <div class="section-title">System Logs</div>
          </div>
          <div id="logs-panel" class="log-list"></div>
        </section>
      </div>

      <div class="stack-side">
        <section>
          <div class="section-head">
            <div class="section-title">Auth Profiles</div>
            <button id="open-add-profile-dialog">ADD</button>
          </div>
          <div id="auth-profiles-panel" style="padding:12px; display:grid; gap:8px;"></div>
          <div id="replace-status" style="padding:8px; font-size:10px;"></div>
        </section>

        <section>
          <div class="section-head">
            <div class="section-title">GitHub Authors</div>
            <button id="open-github-author-dialog">ADD</button>
          </div>
          <div class="toolbar" style="border-bottom:none;">
            <input id="github-author-search" type="search" placeholder="FILTER AUTHORS..." />
          </div>
          <div id="github-authors-panel" style="padding:12px; display:grid; gap:8px;"></div>
          <div id="github-authors-status" style="padding:8px; font-size:10px;"></div>
        </section>

        <section>
          <div class="section-head">
            <div class="section-title">Deploy</div>
            <button id="deploy-release-button">DEPLOY</button>
          </div>
          <div style="padding:12px; display:grid; gap:8px;">
            <input id="deploy-ref-input" type="text" placeholder="COMMIT / BRANCH / TAG" />
            <div style="display:flex; gap:8px;">
              <button id="rollback-release-button" class="secondary" style="flex:1">ROLLBACK</button>
            </div>
            <div id="deploy-panel" style="display:grid; gap:8px;"></div>
            <div id="deploy-status" style="font-size:10px;"></div>
          </div>
        </section>

        <section>
          <div class="section-head">
            <div class="section-title">Runtime Info</div>
          </div>
          <div id="service-card" style="padding:12px; font-size:11px;"></div>
        </section>
      </div>
    </div>
  </div>

  <dialog id="add-profile-dialog"><div class="modal-content">
    <div class="section-title">Add auth profile</div>
    <input id="profile-auth-file" type="file" accept="application/json,.json" />
    <textarea id="profile-auth-text" placeholder="PASTE AUTH.JSON HERE..."></textarea>
    <div style="display:flex; gap:8px; justify-content:flex-end;">
      <button id="close-add-profile-dialog" class="secondary">CANCEL</button>
      <button id="submit-add-profile-dialog">SAVE</button>
    </div>
    <div id="add-profile-status" style="font-size:10px;"></div>
  </div></dialog>

  <dialog id="github-author-dialog"><div class="modal-content">
    <div class="section-title">GitHub author mapping</div>
    <input id="github-author-slack-user-id" type="text" placeholder="SLACK USER ID (U123...)" />
    <input id="github-author-value" type="text" placeholder="Name <email@example.com>" />
    <div style="display:flex; gap:8px; justify-content:flex-end;">
      <button id="close-github-author-dialog" class="secondary">CANCEL</button>
      <button id="submit-github-author-dialog">SAVE</button>
    </div>
    <div id="github-author-dialog-status" style="font-size:10px;"></div>
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
    let latestStatus = null;
    let uiState = loadUiState();
    let uiStatePersistTimer = null;

    function esc(value) {
      return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
    }

    function defaultUiState() {
      return {
        sessionSearch: "",
        sessionFilter: "all",
        expandedSessionKeys: []
      };
    }

    function normalizeUiState(value) {
      const next = value && typeof value === "object" ? value : {};
      const sessionFilterValue = ["all", "active", "inbound", "jobs", "issues"].includes(String(next.sessionFilter || ""))
        ? String(next.sessionFilter)
        : "all";
      const sessionSearchValue = typeof next.sessionSearch === "string" ? next.sessionSearch : "";
      const expandedSessionKeys = Array.isArray(next.expandedSessionKeys)
        ? [...new Set(next.expandedSessionKeys.map((item) => String(item)).filter(Boolean))]
        : [];
      return {
        sessionSearch: sessionSearchValue,
        sessionFilter: sessionFilterValue,
        expandedSessionKeys
      };
    }

    function loadUiState() {
      try {
        const raw = window.localStorage.getItem(uiStateStorageKey);
        if (!raw) {
          return defaultUiState();
        }
        return normalizeUiState(JSON.parse(raw));
      } catch {
        return defaultUiState();
      }
    }

    function cancelScheduledUiStatePersistence() {
      if (uiStatePersistTimer == null) {
        return;
      }
      window.clearTimeout(uiStatePersistTimer);
      uiStatePersistTimer = null;
    }

    function persistUiState() {
      cancelScheduledUiStatePersistence();
      try {
        window.localStorage.setItem(uiStateStorageKey, JSON.stringify(uiState));
      } catch {}
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
      if (expanded) {
        next.add(String(sessionKey));
      } else {
        next.delete(String(sessionKey));
      }
      updateUiState({
        expandedSessionKeys: [...next]
      });
    }

    function pruneExpandedSessionKeys(sessionKeys) {
      const allowedKeys = new Set((sessionKeys || []).map((sessionKey) => String(sessionKey)));
      const expandedSessionKeys = uiState.expandedSessionKeys.filter((sessionKey) => allowedKeys.has(sessionKey));
      if (expandedSessionKeys.length === uiState.expandedSessionKeys.length) {
        return;
      }
      updateUiState({
        expandedSessionKeys
      });
    }

    function fmtTime(value) {
      if (!value) return "—";
      try { return new Date(value).toLocaleTimeString(); } catch { return String(value); }
    }

    function clampPercent(value) {
      const number = Number(value);
      return Math.max(0, Math.min(100, Math.round(number || 0)));
    }

    function formatWindowLabel(mins) {
      const m = Number(mins);
      if (m === 300) return "5h";
      if (m === 10080) return "weekly";
      if (m % 1440 === 0) return (m/1440) + "d";
      if (m % 60 === 0) return (m/60) + "h";
      return m + "m";
    }

    function formatRelativeDuration(ms) {
      const absMs = Math.abs(ms);
      const m = Math.round(absMs / 60000);
      if (m < 60) return m + "m";
      const h = Math.round(absMs / 3600000);
      if (h < 48) return h + "h";
      return Math.round(absMs / 86400000) + "d";
    }

    function formatResetTime(sec) {
      if (sec == null) return "unknown reset";
      const delta = (Number(sec) * 1000) - Date.now();
      const rel = formatRelativeDuration(delta);
      return delta > 0 ? "in " + rel : rel + " ago";
    }

    function fmtDuration(sec) {
      const s = Number(sec || 0);
      if (s <= 0) return "JUST STARTED";
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      return (h > 0 ? h + "h " : "") + m + "m";
    }

    function statusTone(status) {
      const v = String(status || "").toLowerCase();
      if (["running", "active", "ok", "completed"].includes(v)) return "good";
      if (["pending", "inflight", "starting"].includes(v)) return "warn";
      if (["failed", "error", "stopped"].includes(v)) return "danger";
      return "";
    }

    function renderBadge(label, tone) {
      return '<span class="badge ' + (tone || "") + '">' + esc(label) + "</span>";
    }

    function authHeaders(extra) {
      return Object.assign({}, extra || {});
    }

    function renderSummary(data) {
      const s = data.service || {};
      const st = data.state || {};
      const a = data.account || {};
      const rl = data.rateLimits || {};
      
      document.getElementById("summary-service").textContent = "ONLINE";
      document.getElementById("summary-service-detail").textContent = "PID " + (s.pid || "-") + " · UP " + fmtDuration(s.uptimeSeconds);
      
      document.getElementById("summary-account").textContent = a.ok ? (a.account?.planType || "LOGGED") : "ERROR";
      document.getElementById("summary-account-detail").textContent = a.ok ? (a.account?.email || "NO EMAIL") : (a.error || "ERR");
      
      document.getElementById("summary-sessions").textContent = (st.activeCount || 0) + "/" + (st.sessionCount || 0);
      document.getElementById("summary-sessions-detail").textContent =
        "OPEN: " + (st.openInboundCount || 0) +
        " (H:" + (st.openHumanInboundCount || 0) +
        " S:" + (st.openSystemInboundCount || 0) + ")";
      
      document.getElementById("summary-jobs").textContent = st.runningBackgroundJobCount || 0;
      document.getElementById("summary-jobs-detail").textContent = "FAILED: " + (st.failedBackgroundJobCount || 0);
    }

    function renderService(data) {
      const s = data.service || {};
      document.getElementById("service-card").innerHTML = 
        '<div style="display:grid; gap:4px;">' +
        '<div>NAME: ' + esc(s.name) + '</div>' +
        '<div>PORT: ' + esc(s.port) + '</div>' +
        '<div>START: ' + esc(new Date(s.startedAt).toLocaleString()) + '</div>' +
        '<div style="margin-top:8px; color:var(--muted); font-size:10px;">ROOTS:</div>' +
        '<div style="word-break:break-all;">' + esc(s.sessionsRoot) + '</div>' +
        '</div>';
    }

    function renderReleaseCard(label, release) {
      if (!release?.targetPath) {
        return '<div class="summary-detail">' + esc(label + ": none") + "</div>";
      }
      const metadata = release.metadata || {};
      const heading = metadata.shortRevision || metadata.revision || release.targetPath.split("/").pop() || "release";
      const detail = metadata.builtAt ? new Date(metadata.builtAt).toLocaleString() : release.targetPath;
      return '<div class="profile-row">' +
               '<div class="profile-line">' +
                 '<span class="profile-account">' + esc(label + ": " + heading) + "</span>" +
                 '<span class="profile-plan">' + esc(metadata.branch || "detached") + "</span>" +
               "</div>" +
               '<div class="summary-detail">' + esc(detail) + "</div>" +
             "</div>";
    }

    function renderDeployment(data) {
      const deployment = data.deployment;
      const panel = document.getElementById("deploy-panel");
      if (!deployment) {
        panel.innerHTML = '<div class="summary-detail">WORKER DEPLOYMENT UNAVAILABLE</div>';
        return;
      }

      const admin = deployment.admin || {};
      const worker = deployment.worker || {};
      panel.innerHTML =
        '<div style="display:flex; gap:8px; flex-wrap:wrap;">' +
          renderBadge(admin.launchdLoaded ? "ADMIN LOADED" : "ADMIN DOWN", admin.launchdLoaded ? "good" : "danger") +
          renderBadge(admin.healthOk ? "ADMIN HTTP OK" : "ADMIN HTTP FAIL", admin.healthOk ? "good" : "danger") +
          renderBadge(worker.launchdLoaded ? "WORKER LOADED" : "WORKER DOWN", worker.launchdLoaded ? "good" : "danger") +
          renderBadge(worker.healthOk ? "HTTP OK" : "HTTP FAIL", worker.healthOk ? "good" : "danger") +
          renderBadge(worker.readyOk ? "CODEX READY" : "CODEX FAIL", worker.readyOk ? "good" : "danger") +
        "</div>" +
        renderReleaseCard("CURRENT", deployment.currentRelease) +
        renderReleaseCard("PREVIOUS", deployment.previousRelease);
    }

    function renderProfileQuota(rateLimits) {
      if (!rateLimits || !rateLimits.ok) {
        return '<div class="profile-quota">' + esc(rateLimits?.error || "quota unavailable") + "</div>";
      }
      const snapshot = rateLimits.rateLimits || {};
      const primary = snapshot.primary;
      const secondary = snapshot.secondary;
      const primaryValue = primary ? String(100 - clampPercent(primary.usedPercent)) + "% LEFT" : "—";
      const primaryReset = primary ? formatResetTime(primary.resetsAt) : "unavailable";
      const secondaryValue = secondary ? String(100 - clampPercent(secondary.usedPercent)) + "% LEFT" : "—";
      const secondaryReset = secondary ? formatResetTime(secondary.resetsAt) : "unavailable";
      return '<div class="profile-quota">' +
               '<div class="profile-quota-line">' +
                 '<span class="profile-quota-label">5H</span>' +
                 '<span class="profile-quota-value">' + esc(primaryValue) + '</span>' +
                 '<span class="profile-quota-reset">' + esc(primaryReset) + '</span>' +
               '</div>' +
               '<div class="profile-quota-line">' +
                 '<span class="profile-quota-label">WEEKLY</span>' +
                 '<span class="profile-quota-value">' + esc(secondaryValue) + '</span>' +
                 '<span class="profile-quota-reset">' + esc(secondaryReset) + '</span>' +
               '</div>' +
             "</div>";
    }

    function renderAuthProfiles(data) {
      const authProfiles = data.authProfiles || {};
      const profiles = [...(authProfiles.profiles || [])].sort((left, right) => {
        if (left.active !== right.active) {
          return left.active ? -1 : 1;
        }
        return String(right.mtime || "").localeCompare(String(left.mtime || ""));
      });
      const panel = document.getElementById("auth-profiles-panel");
      if (!profiles.length) {
        panel.innerHTML = '<div class="summary-detail" style="padding-top:12px;">NO AUTH PROFILES</div>';
        return;
      }

      panel.innerHTML = profiles.map((profile) => {
        const account = profile.account || {};
        const email = account.ok ? (account.account?.email || "UNKNOWN ACCOUNT") : "ACCOUNT ERROR";
        const plan = account.ok ? (account.account?.planType || account.account?.type || "CHATGPT") : (account.error || "account unavailable");
        return '<div class="profile-row' + (profile.active ? " is-active" : "") + '">' +
                 '<div class="profile-line">' +
                   '<span class="profile-account">' + esc(email) + "</span>" +
                   '<span class="profile-plan">' + esc(plan) + "</span>" +
                 "</div>" +
                 renderProfileQuota(profile.rateLimits) +
                 '<div class="profile-actions">' +
                   '<button class="secondary" data-activate-profile="' + esc(profile.name) + '"' +
                     ' data-profile-email="' + esc(email) + '"' +
                     (profile.active ? " disabled" : "") + ">USE</button>" +
                   '<button class="danger" data-delete-profile="' + esc(profile.name) + '"' +
                     ' data-profile-email="' + esc(email) + '"' +
                     (profile.active ? " disabled" : "") + '>DELETE</button>' +
                 "</div>" +
               "</div>";
      }).join("");

      document.querySelectorAll("[data-activate-profile]").forEach((button) => {
        button.addEventListener("click", async () => {
          const name = button.getAttribute("data-activate-profile");
          if (!name) {
            return;
          }
          const activeCount = Number(latestStatus?.state?.activeCount || 0);
          const allowActive =
            activeCount > 0 ? window.confirm("ACTIVE SESSIONS EXIST. SWITCHING WILL INTERRUPT THEM. CONTINUE?") : false;
          if (activeCount > 0 && !allowActive) {
            return;
          }
          await activateProfile(name, allowActive);
        });
      });

      document.querySelectorAll("[data-delete-profile]").forEach((button) => {
        button.addEventListener("click", async () => {
          const name = button.getAttribute("data-delete-profile");
          const email = button.getAttribute("data-profile-email") || "this auth profile";
          if (!name) {
            return;
          }
          if (!window.confirm("DELETE " + email + "?")) {
            return;
          }
          await deleteProfile(name);
        });
      });
    }

    function renderGitHubAuthors(data) {
      const mappings = [...(data.githubAuthorMappings?.mappings || [])];
      const panel = document.getElementById("github-authors-panel");
      const query = String(githubAuthorSearch.value || "").toLowerCase();
      const filtered = mappings.filter((mapping) => {
        if (!query) {
          return true;
        }

        return [
          mapping.slackUserId,
          mapping.githubAuthor,
          mapping.slackIdentity?.displayName,
          mapping.slackIdentity?.realName,
          mapping.slackIdentity?.username,
          mapping.slackIdentity?.email
        ].some((value) => String(value || "").toLowerCase().includes(query));
      });

      if (!filtered.length) {
        panel.innerHTML = '<div class="summary-detail" style="padding-top:12px;">NO GITHUB AUTHOR MAPPINGS</div>';
        return;
      }

      panel.innerHTML = filtered.map((mapping) => {
        const identity = mapping.slackIdentity || {};
        const label = identity.realName || identity.displayName || identity.username || mapping.slackUserId;
        const detail = [mapping.slackUserId, identity.email].filter(Boolean).join(" · ");
        return '<div class="profile-row">' +
                 '<div class="profile-line">' +
                   '<span class="profile-account">' + esc(label) + "</span>" +
                   '<span class="profile-plan">' + esc(detail || mapping.slackUserId) + "</span>" +
                   renderBadge(mapping.source === "manual" ? "manual" : "auto", mapping.source === "manual" ? "good" : "warn") +
                 "</div>" +
                 '<div class="summary-detail">' + esc(mapping.githubAuthor) + "</div>" +
                 '<div class="summary-detail">UPDATED: ' + esc(new Date(mapping.updatedAt).toLocaleString()) + "</div>" +
                 '<div class="profile-actions">' +
                   '<button class="secondary" data-edit-github-author="' + esc(mapping.slackUserId) + '"' +
                     ' data-edit-github-author-value="' + esc(mapping.githubAuthor) + '">EDIT</button>' +
                   '<button class="danger" data-delete-github-author="' + esc(mapping.slackUserId) + '">DELETE</button>' +
                 "</div>" +
               "</div>";
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
          if (!slackUserId) {
            return;
          }

          if (!window.confirm("DELETE GITHUB AUTHOR MAPPING FOR " + slackUserId + "?")) {
            return;
          }

          await deleteGitHubAuthorMapping(slackUserId);
        });
      });
    }

    function summarizeSessionLead(s) {
      if (s.openInbound?.length) return s.openInbound[0].textPreview || "NEW MSG";
      if (s.backgroundJobs?.length) {
        const r = s.backgroundJobs.find(j => j.status === "running") || s.backgroundJobs[0];
        return (r.kind || "JOB") + " (" + (r.status || "?") + ")";
      }
      return "IDLE";
    }

    function renderSessions(data) {
      const panel = document.getElementById("sessions-panel");
      const list = data.state?.sessions || [];
      pruneExpandedSessionKeys(list.map((session) => session.key));
      const query = (sessionSearch.value || "").toLowerCase();
      const mode = sessionFilter.value;
      
      const filtered = list.filter(s => {
        if (mode === "active" && !s.activeTurnId) return false;
        if (mode === "inbound" && !s.openInboundCount) return false;
        if (mode === "jobs" && !s.runningBackgroundJobCount) return false;
        if (mode === "issues" && !s.failedBackgroundJobCount) return false;
        if (!query) return true;
        return [s.key, s.channelId, s.workspacePath].some(v => String(v).toLowerCase().includes(query));
      });

      if (!filtered.length) {
        panel.innerHTML = '<div style="padding:20px; text-align:center; color:var(--muted)">NO SESSIONS FOUND</div>';
        return;
      }

      panel.innerHTML = filtered.map(s => {
        const lead = summarizeSessionLead(s);
        const isActive = !!s.activeTurnId;
        const expanded = isSessionExpanded(s.key);
        return '<details class="session-row" data-session-key="' + esc(s.key) + '"' + (expanded ? " open" : "") + ">" +
          '<summary class="session-summary">' +
            '<div class="session-key">' + esc(s.key) + '<div style="font-size:10px; font-weight:normal; color:var(--muted)">' + esc(s.channelId) + '</div></div>' +
            '<div>' + renderBadge(isActive ? "ACTIVE" : "IDLE", isActive ? "good" : "warn") + '<div style="font-size:10px; color:var(--muted)">UP: ' + fmtTime(s.updatedAt) + '</div></div>' +
            '<div>OPEN: ' + (s.openInboundCount || 0) +
              ' (H:' + (s.openHumanInboundCount || 0) +
              ' S:' + (s.openSystemInboundCount || 0) +
              ') / JOB: ' + (s.runningBackgroundJobCount || 0) + '</div>' +
            '<div style="font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="' + esc(lead) + '">' + esc(lead) + '</div>' +
            '<div><span style="color:var(--accent); font-size:10px;">EXPAND</span></div>' +
          '</summary>' +
          '<div class="session-body">' +
            '<div style="margin-bottom:12px; font-size:11px; color:var(--muted)">CWD: ' + esc(s.workspacePath) + '</div>' +
            '<div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px;">' +
              '<div><div class="summary-label">INBOUND</div>' + renderInboundTable(s.openInbound) + '</div>' +
              '<div><div class="summary-label">JOBS</div>' + renderJobsTable(s.backgroundJobs) + '</div>' +
            '</div>' +
          '</div>' +
        '</details>';
      }).join("");

      panel.querySelectorAll(".session-row").forEach((row) => {
        row.addEventListener("toggle", () => {
          const sessionKey = row.getAttribute("data-session-key");
          if (!sessionKey) {
            return;
          }
          updateSessionExpansion(sessionKey, row.open);
        });
      });
    }

    function renderInboundTable(items) {
      if (!items?.length) return '<div style="color:var(--muted); font-size:11px;">EMPTY</div>';
      return '<table class="tui-table"><thead><tr><th>SRC</th><th>MSG</th></tr></thead><tbody>' +
        items.map(i => '<tr><td>' + esc(i.source) + '</td><td>' + esc(i.textPreview) + '</td></tr>').join("") +
        '</tbody></table>';
    }

    function renderJobsTable(jobs) {
      if (!jobs?.length) return '<div style="color:var(--muted); font-size:11px;">EMPTY</div>';
      return '<table class="tui-table"><thead><tr><th>STATUS</th><th>KIND</th></tr></thead><tbody>' +
        jobs.slice(0, 5).map(j => '<tr><td>' + renderBadge(j.status, statusTone(j.status)) + '</td><td>' + esc(j.kind) + '</td></tr>').join("") +
        '</tbody></table>';
    }

    function renderLogs(data) {
      const logs = data.state?.recentBrokerLogs || [];
      const panel = document.getElementById("logs-panel");
      if (!logs.length) {
        panel.innerHTML = '<div style="padding:12px; color:var(--muted)">NO LOGS</div>';
        return;
      }
      panel.innerHTML = logs.map(e => {
        const tone = statusTone(e.level);
        return '<div class="log-entry ' + tone + '">[' + fmtTime(e.ts) + '] ' + esc(e.message || e.raw) + '</div>';
      }).join("");
    }

    function render(data) {
      latestStatus = data;
      renderSummary(data);
      renderService(data);
      renderAuthProfiles(data);
      renderGitHubAuthors(data);
      renderDeployment(data);
      renderSessions(data);
      renderLogs(data);
    }

    async function parseResponse(response) {
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || response.statusText || "REQUEST FAILED");
      }
      return payload;
    }

    async function activateProfile(name, allowActive) {
      replaceStatus.textContent = "SWITCHING PROFILE...";
      try {
        const response = await fetch("/admin/api/auth-profiles/" + encodeURIComponent(name) + "/activate", {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ allow_active: allowActive })
        });
        const payload = await parseResponse(response);
        render(payload.status);
        replaceStatus.innerHTML = '<span style="color:var(--good)">ACTIVE PROFILE SWITCHED</span>';
      } catch (error) {
        replaceStatus.innerHTML = '<span style="color:var(--danger)">' + esc(error instanceof Error ? error.message : String(error)) + "</span>";
      }
    }

    async function deleteProfile(name) {
      replaceStatus.textContent = "DELETING PROFILE...";
      try {
        const response = await fetch("/admin/api/auth-profiles/" + encodeURIComponent(name), {
          method: "DELETE",
          headers: authHeaders()
        });
        const payload = await parseResponse(response);
        render(payload.status);
        replaceStatus.innerHTML = '<span style="color:var(--good)">PROFILE DELETED</span>';
      } catch (error) {
        replaceStatus.innerHTML = '<span style="color:var(--danger)">' + esc(error instanceof Error ? error.message : String(error)) + "</span>";
      }
    }

    async function submitAddProfile() {
      const status = document.getElementById("add-profile-status");
      const fileInput = document.getElementById("profile-auth-file");
      const textArea = document.getElementById("profile-auth-text");
      const submitButton = document.getElementById("submit-add-profile-dialog");
      status.textContent = "SAVING...";
      submitButton.disabled = true;
      try {
        const content = textArea.value.trim() || (fileInput.files[0] ? await fileInput.files[0].text() : "");
        if (!content) {
          throw new Error("AUTH.JSON IS REQUIRED");
        }
        const response = await fetch("/admin/api/auth-profiles", {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({
            auth_json_content: content
          })
        });
        const payload = await parseResponse(response);
        render(payload.status);
        replaceStatus.innerHTML = '<span style="color:var(--good)">PROFILE SAVED</span>';
        status.innerHTML = '<span style="color:var(--good)">PROFILE SAVED</span>';
        addProfileDialog.close();
        fileInput.value = "";
        textArea.value = "";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        status.innerHTML = '<span style="color:var(--danger)">' + esc(message) + "</span>";
      } finally {
        submitButton.disabled = false;
      }
    }

    async function deployRelease() {
      const ref = deployRefInput.value.trim();
      if (!ref) {
        deployStatus.innerHTML = '<span style="color:var(--danger)">REF IS REQUIRED</span>';
        return;
      }
      const activeCount = Number(latestStatus?.state?.activeCount || 0);
      const allowActive =
        activeCount > 0 ? window.confirm("ACTIVE SESSIONS EXIST. DEPLOYING WILL INTERRUPT THEM. CONTINUE?") : false;
      if (activeCount > 0 && !allowActive) {
        return;
      }
      deployStatus.textContent = "DEPLOYING...";
      try {
        const response = await fetch("/admin/api/deploy", {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({
            ref,
            allow_active: allowActive
          })
        });
        const payload = await parseResponse(response);
        render(payload.status);
        deployStatus.innerHTML = '<span style="color:var(--good)">DEPLOYED ' + esc(ref) + "</span>";
      } catch (error) {
        deployStatus.innerHTML = '<span style="color:var(--danger)">' + esc(error instanceof Error ? error.message : String(error)) + "</span>";
      }
    }

    async function rollbackRelease() {
      const activeCount = Number(latestStatus?.state?.activeCount || 0);
      const allowActive =
        activeCount > 0 ? window.confirm("ACTIVE SESSIONS EXIST. ROLLBACK WILL INTERRUPT THEM. CONTINUE?") : false;
      if (activeCount > 0 && !allowActive) {
        return;
      }
      deployStatus.textContent = "ROLLING BACK...";
      try {
        const response = await fetch("/admin/api/rollback", {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({
            allow_active: allowActive
          })
        });
        const payload = await parseResponse(response);
        render(payload.status);
        deployStatus.innerHTML = '<span style="color:var(--good)">ROLLED BACK</span>';
      } catch (error) {
        deployStatus.innerHTML = '<span style="color:var(--danger)">' + esc(error instanceof Error ? error.message : String(error)) + "</span>";
      }
    }

    async function refresh() {
      refreshButton.disabled = true;
      try {
        const res = await fetch("/admin/api/status", { headers: authHeaders() });
        const p = await parseResponse(res);
        render(p);
        lastRefresh.textContent = "SYNCED: " + new Date().toLocaleTimeString();
      } catch (e) { lastRefresh.textContent = "ERROR: " + (e instanceof Error ? e.message : String(e)); }
      finally { refreshButton.disabled = false; }
    }

    async function submitGitHubAuthorMapping() {
      const slackUserId = document.getElementById("github-author-slack-user-id").value.trim();
      const githubAuthor = document.getElementById("github-author-value").value.trim();
      const status = document.getElementById("github-author-dialog-status");
      const submitButton = document.getElementById("submit-github-author-dialog");
      status.textContent = "SAVING...";
      submitButton.disabled = true;

      try {
        if (!slackUserId || !githubAuthor) {
          throw new Error("SLACK USER ID AND GITHUB AUTHOR ARE REQUIRED");
        }

        const response = await fetch("/admin/api/github-authors", {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({
            slack_user_id: slackUserId,
            github_author: githubAuthor
          })
        });
        const payload = await parseResponse(response);
        render(payload.status);
        githubAuthorsStatus.innerHTML = '<span style="color:var(--good)">MAPPING SAVED</span>';
        status.innerHTML = '<span style="color:var(--good)">MAPPING SAVED</span>';
        githubAuthorDialog.close();
      } catch (error) {
        status.innerHTML = '<span style="color:var(--danger)">' + esc(error instanceof Error ? error.message : String(error)) + "</span>";
      } finally {
        submitButton.disabled = false;
      }
    }

    async function deleteGitHubAuthorMapping(slackUserId) {
      githubAuthorsStatus.textContent = "DELETING MAPPING...";
      try {
        const response = await fetch("/admin/api/github-authors/" + encodeURIComponent(slackUserId), {
          method: "DELETE",
          headers: authHeaders()
        });
        const payload = await parseResponse(response);
        render(payload.status);
        githubAuthorsStatus.innerHTML = '<span style="color:var(--good)">MAPPING DELETED</span>';
      } catch (error) {
        githubAuthorsStatus.innerHTML = '<span style="color:var(--danger)">' + esc(error instanceof Error ? error.message : String(error)) + "</span>";
      }
    }

    sessionSearch.value = uiState.sessionSearch;
    sessionFilter.value = uiState.sessionFilter;

    refreshButton.onclick = refresh;
    sessionSearch.oninput = () => {
      updateUiState({ sessionSearch: sessionSearch.value }, { deferPersist: true });
      if (latestStatus) renderSessions(latestStatus);
    };
    sessionSearch.onblur = () => {
      persistUiState();
    };
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
    addProfileDialog.onclick = (event) => {
      if (event.target === addProfileDialog) {
        addProfileDialog.close();
      }
    };
    githubAuthorDialog.onclick = (event) => {
      if (event.target === githubAuthorDialog) {
        githubAuthorDialog.close();
      }
    };

    refresh(); setInterval(refresh, 10000);
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
