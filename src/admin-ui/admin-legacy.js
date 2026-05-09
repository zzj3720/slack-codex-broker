export function initAdminPage(options = {}) {
    const useReactSessions = options.useReactSessions === true;
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

    async function requestJson(path, init = {}) {
      const response = await fetch(path, Object.assign({}, init, { headers: authHeaders(init.headers) }));
      return await parseResponse(response);
    }

    function esc(value) {
      return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
    }
    function defaultUiState() {
      return { adminView: "sessions", sessionSearch: "", sessionFilter: "ongoing", selectedSessionKey: null };
    }
    function normalizeUiState(value) {
      const next = value && typeof value === "object" ? value : {};
      const adminViewValue = ["sessions", "ops"].includes(String(next.adminView || "")) ? String(next.adminView) : "sessions";
      const sessionFilterValue = ["ongoing", "all", "active", "inbound", "jobs", "issues", "usage"].includes(String(next.sessionFilter || "")) ? String(next.sessionFilter) : "ongoing";
      const sessionSearchValue = typeof next.sessionSearch === "string" ? next.sessionSearch : "";
      const selectedSessionKey = typeof next.selectedSessionKey === "string" && next.selectedSessionKey ? next.selectedSessionKey : null;
      return { adminView: adminViewValue, sessionSearch: sessionSearchValue, sessionFilter: sessionFilterValue, selectedSessionKey };
    }
    function switchAdminView(viewName) {
      document.querySelectorAll(".admin-view").forEach((view) => view.classList.toggle("active", view.dataset.adminView === viewName));
      document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.viewTarget === viewName));
      updateUiState({ adminView: viewName });
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
      uiState = normalizeUiState(Object.assign({}, loadUiState(), patch || {}));
      if (options?.deferPersist) {
        scheduleUiStatePersistence();
        return;
      }
      persistUiState();
    }
    function selectSession(sessionKey) {
      if (!sessionKey || uiState.selectedSessionKey === sessionKey) return;
      updateUiState({ selectedSessionKey: sessionKey });
      if (latestStatus) renderSessions(latestStatus);
    }
    function authHeaders(extra) {
      return Object.assign({}, extra || {});
    }
    function fmtTime(value) {
      if (!value) return "--";
      try {
        const d = new Date(value);
        const h = String(d.getHours()).padStart(2, "0");
        const m = String(d.getMinutes()).padStart(2, "0");
        const s = String(d.getSeconds()).padStart(2, "0");
        return h + ":" + m + ":" + s;
      } catch { return String(value); }
    }
    function fmtDateTime(value) {
      if (!value) return "--";
      try {
        const d = new Date(value);
        const y = d.getFullYear();
        const mo = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        const h = String(d.getHours()).padStart(2, "0");
        const m = String(d.getMinutes()).padStart(2, "0");
        const s = String(d.getSeconds()).padStart(2, "0");
        return y + "-" + mo + "-" + day + " " + h + ":" + m + ":" + s;
      } catch { return String(value); }
    }
    function timestampMs(value) {
      const parsed = Date.parse(String(value || ""));
      return Number.isFinite(parsed) ? parsed : 0;
    }
    function newestTimestamp(values) {
      return values.reduce((latest, value) => Math.max(latest, timestampMs(value)), 0);
    }
    function fmtRelativeTime(value) {
      const ms = timestampMs(value);
      if (!ms) return "--";
      const delta = Date.now() - ms;
      if (delta < 0) return fmtTime(value);
      if (delta < 45000) return "刚刚";
      if (delta < 3600000) return Math.max(1, Math.round(delta / 60000)) + " 分钟前";
      if (delta < 86400000) return Math.round(delta / 3600000) + " 小时前";
      if (delta < 604800000) return Math.round(delta / 86400000) + " 天前";
      return fmtDateTime(value);
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
    function fmtTokens(value) {
      const n = Math.max(0, Number(value || 0));
      if (n >= 1000000) return (n / 1000000).toFixed(2).replace(/\\.00$/, "") + "M";
      if (n >= 1000) return (n / 1000).toFixed(1).replace(/\\.0$/, "") + "K";
      return String(Math.round(n));
    }
    function clampPercent(value) {
      return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    }
    function statusTone(status) {
      const v = String(status || "").toLowerCase();
      if (["succeeded", "running", "active", "ok", "completed", "done"].includes(v)) return "good";
      if (["pending", "inflight", "registered", "starting", "idle", "started", "wait"].includes(v)) return "warn";
      if (["failed", "error", "stopped", "cancelled"].includes(v)) return "danger";
      if (["agent_system_prompt", "agent_memory", "agent_runtime_instruction"].includes(v)) return "purple";
      if (["agent_user_message", "agent_assistant_message", "agent_tool_result", "agent_token_count"].includes(v)) return "good";
      if (["agent_runtime_reminder", "agent_tool_call", "agent_turn_started"].includes(v)) return "warn";
      if (v.startsWith("agent_")) return "info";
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
        exact: "精确",
        estimated: "估算",
        missing: "缺失",
        unknown: "未知",
        combined: "合并模式",
        session_created: "会话创建",
        inbound_message: "Slack 消息",
        background_job: "后台任务",
        turn_signal: "回合信号",
        not_configured: "未关联",
        broker_db: "DB Trace",
        agent_system_prompt: "系统 Prompt",
        agent_memory: "记忆",
        agent_user_message: "用户消息",
        agent_runtime_reminder: "Runtime 提醒",
        agent_assistant_message: "Assistant",
        agent_tool_call: "工具调用",
        agent_tool_result: "工具结果",
        agent_turn_started: "回合开始",
        agent_turn_completed: "回合结束",
        agent_runtime_instruction: "Runtime 指令",
        agent_runtime_event: "Runtime",
        agent_reasoning: "推理",
        agent_token_count: "Token",
        agent_raw_event: "原始事件",
        agent_response_item: "Response Item"
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
    function setText(id, value) {
      const element = document.getElementById(id);
      if (element) element.textContent = String(value ?? "");
    }
    function renderAccountChip(account) {
      const label = account.ok ? (account.account?.email || account.account?.planType || "已登录") : "账号异常";
      const title = account.ok ? label : (account.error || "账号异常");
      return '<span class="quota-account' + (account.ok ? "" : " is-error") + '" title="' + esc(title) + '">' + esc(label) + '</span>';
    }

    function renderSummary(data) {
      const s = data.service || {};
      const st = data.state || {};
      const a = data.account || {};
      const authProfiles = data.authProfiles || {};
      const activeProfile = (authProfiles.profiles || []).find((p) => p.active);
      const rateLimits = activeProfile?.rateLimits;
      const snapshot = rateLimits?.rateLimits || {};
      const primary = snapshot.primary;
      const secondary = snapshot.secondary;
      const topbarQuota = document.getElementById("topbar-quota");
      const accountChip = renderAccountChip(a);
      if (rateLimits?.ok && primary) {
        const weeklyRemaining = secondary ? (100 - clampPercent(secondary.usedPercent)) : null;
        const weeklyTone = weeklyRemaining != null ? (weeklyRemaining < 10 ? "danger" : (weeklyRemaining < 30 ? "warn" : "")) : "";
        const hourlyRemaining = 100 - clampPercent(primary.usedPercent);
        const hourlyTone = hourlyRemaining < 10 ? "danger" : (hourlyRemaining < 30 ? "warn" : "");
        topbarQuota.innerHTML =
          accountChip +
          (weeklyRemaining != null ? '<span class="quota-pill ' + weeklyTone + '">周 <strong>' + weeklyRemaining + '%</strong></span>' : '') +
          '<span class="quota-pill ' + hourlyTone + '">5h <strong>' + hourlyRemaining + '%</strong></span>' +
          '<span class="quota-pill">重置 ' + esc(formatResetTime(primary.resetsAt)) + '</span>' +
          '<span class="quota-meta">' + (st.activeCount || 0) + " 活跃 · " + (st.openInboundCount || 0) + " 待处理 · " + (st.runningBackgroundJobCount || 0) + " 任务</span>";
      } else {
        topbarQuota.innerHTML = accountChip +
          '<span class="quota-meta">' + (st.activeCount || 0) + " 活跃 · " + (st.openInboundCount || 0) + " 待处理 · " + (st.runningBackgroundJobCount || 0) + " 任务</span>";
      }
      setText("session-open-count", st.openInboundCount || 0);
      setText("session-human-count", st.openHumanInboundCount || 0);
      setText("session-system-count", st.openSystemInboundCount || 0);
    }

    function renderUsage(data) {
      const usage = data.usage || {};
      const totals = usage.totals || {};
      const windows = usage.windows || {};
      const lastDay = windows.lastDay || {};
      const lastHour = windows.lastHour || {};
      const recentTurns = usage.recentTurns || [];
      const bySession = usage.bySession || [];
      const totalTurns = Number(totals.totalTurns || 0);
      const exactTurns = Number(totals.exactTurns || 0);
      const missingTurns = Number(totals.missingTurns || 0);
      const badge = document.getElementById("usage-badge");
      badge.textContent = totalTurns ? ("精确 " + exactTurns + "/" + totalTurns) : "暂无数据";
      badge.className = "badge " + (!totalTurns || missingTurns ? "warn" : "good");
      document.getElementById("usage-total").textContent = fmtTokens(totals.totalTokens);
      document.getElementById("usage-total-detail").textContent = "输入 " + fmtTokens(totals.inputTokens) + " · 输出 " + fmtTokens(totals.outputTokens);
      document.getElementById("usage-day").textContent = fmtTokens(lastDay.totalTokens);
      document.getElementById("usage-day-detail").textContent = "回合 " + (lastDay.totalTurns || 0) + " · 推理 " + fmtTokens(lastDay.reasoningTokens);
      document.getElementById("usage-hour").textContent = fmtTokens(lastHour.totalTokens);
      document.getElementById("usage-hour-detail").textContent = "回合 " + (lastHour.totalTurns || 0) + " · 缓存 " + fmtTokens(lastHour.cachedInputTokens);
      document.getElementById("usage-missing").textContent = missingTurns;
      document.getElementById("usage-missing-detail").textContent = "估算 " + (totals.estimatedTurns || 0) + " · 精确 " + exactTurns;

      const list = document.getElementById("usage-list");
      if (!totalTurns) {
        list.innerHTML = '<div class="empty-state">还没有完成的 Codex 回合用量记录</div>';
        return;
      }
      const leader = bySession[0];
      const latest = recentTurns[0];
      list.innerHTML =
        '<div class="usage-row"><span>' + esc(leader ? ("最高会话：" + leader.sessionKey) : "最高会话：--") + '</span><strong>' + esc(fmtTokens(leader?.totalTokens || 0)) + '</strong></div>' +
        '<div class="usage-row"><span>' + esc(latest ? ("最近回合：" + latest.sessionKey + " · " + statusLabel(latest.source)) : "最近回合：--") + '</span><strong>' + esc(fmtTokens(latest?.totalTokens || 0)) + '</strong></div>';
    }

    function renderRiskPanel(data) {
      const st = data.state || {};
      const active = Number(st.activeCount || 0);
      const open = Number(st.openInboundCount || 0);
      const running = Number(st.runningBackgroundJobCount || 0);
      const failed = Number(st.failedBackgroundJobCount || 0);
      const safe = active + open + running === 0;
      const riskBadge = document.getElementById("risk-badge");
      if (riskBadge) {
        riskBadge.textContent = safe ? "安全" : (failed ? "有失败任务" : "有活跃工作");
        riskBadge.className = "badge " + (safe ? "good" : (failed ? "danger" : "warn"));
      }
      document.getElementById("risk-panel").innerHTML =
        '<div class="risk-strip">' +
          '<div class="risk-cell"><div class="risk-number">' + active + '</div><div class="risk-label">活跃</div></div>' +
          '<div class="risk-cell"><div class="risk-number">' + open + '</div><div class="risk-label">待处理</div></div>' +
          '<div class="risk-cell"><div class="risk-number">' + running + '</div><div class="risk-label">运行</div></div>' +
          (failed ? '<div class="risk-cell"><div class="risk-number" style="color:var(--red)">' + failed + '</div><div class="risk-label">失败</div></div>' : '') +
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
        operationsPanel.innerHTML = '<div class="empty-state">暂无管理操作</div>';
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
        panel.innerHTML = '<div class="empty-state">暂无认证档案</div>';
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
        panel.innerHTML = '<div class="empty-state">暂无 GitHub 作者映射</div>';
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

    function messagePreview(message) {
      return String(message?.textPreview || message?.text || "").trim();
    }
    function sessionPrimaryText(s) {
      return messagePreview(s.lastUserMessage) || summarizeSessionLead(s);
    }
    function sessionFirstText(s) {
      return messagePreview(s.firstUserMessage) || "没有用户消息";
    }
    function summarizeSessionLead(s) {
      const failedJob = (s.backgroundJobs || []).find((job) => job.status === "failed");
      if (failedJob) return "失败任务：" + (failedJob.kind || failedJob.id || "后台任务") + (failedJob.error ? " · " + failedJob.error : "");
      if (s.lastUserMessage) return messagePreview(s.lastUserMessage) || "用户消息";
      if (s.openInbound?.length) return s.openInbound[0].textPreview || "新消息";
      if (s.activeTurnId) {
        const signal = s.lastTurnSignalKind ? statusLabel(s.lastTurnSignalKind) + (s.lastTurnSignalReason ? "：" + s.lastTurnSignalReason : "") : "正在运行";
        return "当前回合：" + shortValue(s.activeTurnId, 18) + " · " + signal;
      }
      if (s.backgroundJobs?.length) {
        const r = s.backgroundJobs.find((j) => j.status === "running") || s.backgroundJobs[0];
        return (r.kind || "任务") + "（" + statusLabel(r.status || "?") + "）";
      }
      if (s.lastTurnSignalKind) return statusLabel(s.lastTurnSignalKind) + (s.lastTurnSignalReason ? "：" + s.lastTurnSignalReason : "");
      if (s.usage?.turnCount) return "最近消耗：" + fmtTokens(s.usage.totalTokens || 0) + " · " + (s.usage.turnCount || 0) + " 回合";
      return "空闲";
    }
    function shortValue(value, maxLength) {
      const text = String(value || "");
      const limit = Number(maxLength || 16);
      if (text.length <= limit) return text;
      return text.slice(0, Math.max(4, limit - 5)) + "..." + text.slice(-4);
    }
    function sessionQueueState(s) {
      if (Number(s.failedBackgroundJobCount || 0) > 0) {
        return { label: "异常", tone: "danger", rank: 60, detail: s.failedBackgroundJobCount + " 个失败任务" };
      }
      if (Number(s.openHumanInboundCount || 0) > 0) {
        return { label: "待人处理", tone: "warn", rank: 50, detail: s.openHumanInboundCount + " 条用户消息" };
      }
      if (Number(s.openInboundCount || 0) > 0) {
        return { label: "待处理", tone: "warn", rank: 40, detail: s.openInboundCount + " 条系统消息" };
      }
      if (s.activeTurnId) {
        return { label: "运行中", tone: "good", rank: 30, detail: shortValue(s.activeTurnId, 18) };
      }
      if (Number(s.runningBackgroundJobCount || 0) > 0) {
        return { label: "后台任务", tone: "good", rank: 20, detail: s.runningBackgroundJobCount + " 个运行任务" };
      }
      if (Number(s.usage?.turnCount || 0) > 0) {
        return { label: "有记录", tone: "info", rank: 10, detail: fmtTokens(s.usage?.totalTokens || 0) };
      }
      return { label: "空闲", tone: "", rank: 0, detail: "" };
    }
    function sessionActivityAt(s) {
      const candidates = [
        s.updatedAt,
        s.lastTurnSignalAt,
        s.lastSlackReplyAt,
        s.activeTurnStartedAt,
        s.usage?.lastTurnAt,
        ...(s.openInbound || []).map((message) => message.updatedAt || message.createdAt),
        ...(s.backgroundJobs || []).flatMap((job) => [job.lastEventAt, job.heartbeatAt, job.updatedAt, job.createdAt])
      ];
      const latestMs = newestTimestamp(candidates);
      return candidates.find((value) => timestampMs(value) === latestMs) || s.updatedAt || s.createdAt;
    }
    function sessionActivityMs(s) {
      return timestampMs(sessionActivityAt(s));
    }
    function compareSessionsForMode(mode, left, right) {
      if (mode === "usage") {
        const tokenDelta = Number(right.usage?.totalTokens || 0) - Number(left.usage?.totalTokens || 0);
        if (tokenDelta) return tokenDelta;
      }
      if (mode === "all") {
        const activityDelta = sessionActivityMs(right) - sessionActivityMs(left);
        if (activityDelta) return activityDelta;
      }
      const rankDelta = sessionQueueState(right).rank - sessionQueueState(left).rank;
      if (rankDelta) return rankDelta;
      const activityDelta = sessionActivityMs(right) - sessionActivityMs(left);
      if (activityDelta) return activityDelta;
      return String(left.key).localeCompare(String(right.key));
    }
    function renderSessionMetaPill(label, tone, title) {
      return '<span class="session-meta-pill ' + esc(tone || "") + '"' + (title ? ' title="' + esc(title) + '"' : "") + ">" + esc(label) + "</span>";
    }
    function renderSessionMeta(s, state) {
      const usage = s.usage || {};
      const pendingDetail = Number(s.openInboundCount || 0)
        ? "待处理 " + (s.openInboundCount || 0) + "（人 " + (s.openHumanInboundCount || 0) + " / 系统 " + (s.openSystemInboundCount || 0) + "）"
        : "";
      return [
        renderSessionMetaPill(s.channelLabel || s.channelId || "未知频道", "info", s.key),
        pendingDetail ? renderSessionMetaPill(pendingDetail, Number(s.openHumanInboundCount || 0) ? "warn" : "") : "",
        renderSessionMetaPill("Jobs " + (s.backgroundJobCount || 0), Number(s.failedBackgroundJobCount || 0) ? "danger" : (Number(s.runningBackgroundJobCount || 0) ? "good" : "")),
        Number(s.failedBackgroundJobCount || 0) ? renderSessionMetaPill("失败 " + s.failedBackgroundJobCount, "danger") : "",
        renderSessionMetaPill("轮次 " + (usage.turnCount || 0), ""),
        renderSessionMetaPill("Token " + fmtTokens(usage.totalTokens || 0), "info")
      ].filter(Boolean).join("");
    }
    function renderSessions(data) {
      const panel = document.getElementById("sessions-panel");
      const detailPanel = document.getElementById("session-detail-panel");
      const list = data.state?.sessions || [];
      const query = (sessionSearch.value || "").toLowerCase();
      const mode = sessionFilter.value;
      let filtered = list.filter((s) => {
        if (mode === "ongoing" && !s.activeTurnId && !s.openInboundCount && !s.runningBackgroundJobCount && !s.failedBackgroundJobCount) return false;
        if (mode === "active" && !s.activeTurnId) return false;
        if (mode === "inbound" && !s.openInboundCount) return false;
        if (mode === "jobs" && !s.runningBackgroundJobCount) return false;
        if (mode === "issues" && !s.failedBackgroundJobCount) return false;
        if (mode === "usage" && !s.usage?.turnCount) return false;
        if (!query) return true;
        return [s.key, s.channelId, s.channelLabel, s.workspacePath, sessionPrimaryText(s), sessionFirstText(s)].some((v) => String(v || "").toLowerCase().includes(query));
      });
      filtered = filtered.sort((a, b) => compareSessionsForMode(mode, a, b));
      if (!filtered.length) {
        panel.innerHTML = '<div class="empty-state">没有匹配的会话</div>';
        detailPanel.innerHTML = '<div class="empty-state">没有可检查的 session</div>';
        return;
      }
      const selectedSession = resolveSelectedSession(list, filtered);
      panel.innerHTML = filtered.map((s) => {
        const state = sessionQueueState(s);
        const activityAt = sessionActivityAt(s);
        const primary = sessionPrimaryText(s);
        const first = sessionFirstText(s);
        const firstLine = "起始：" + first;
        const selected = selectedSession?.key === s.key;
        return '<button class="session-row-button session-card session-priority-' + esc(state.tone || "idle") + (selected ? " active" : "") + '" data-session-key="' + esc(s.key) + '">' +
          '<div class="session-summary">' +
            '<div class="session-line">' +
              '<div class="session-lead" title="' + esc(primary) + '">' + esc(primary) + '</div>' +
              renderBadge(state.label, state.tone) +
              '<div class="session-time" title="' + esc(fmtDateTime(activityAt)) + '">更新 ' + esc(fmtRelativeTime(activityAt)) + '</div>' +
            '</div>' +
            '<div class="session-channel" title="' + esc(first) + '">' + esc(firstLine) + '</div>' +
            '<div class="session-meta-line">' + renderSessionMeta(s, state) + '</div>' +
          '</div>' +
        '</button>';
      }).join("");
      panel.querySelectorAll("[data-session-key]").forEach((button) => {
        button.addEventListener("click", () => {
          const sessionKey = button.getAttribute("data-session-key");
          selectSession(sessionKey);
        });
      });
      renderSelectedSessionDetail(selectedSession);
    }
    function resolveSelectedSession(list, filtered) {
      const current = list.find((session) => session.key === uiState.selectedSessionKey);
      const selected = current && filtered.some((session) => session.key === current.key) ? current : filtered[0];
      if (selected?.key !== uiState.selectedSessionKey) {
        uiState = normalizeUiState(Object.assign({}, uiState, { selectedSessionKey: selected?.key || null }));
        scheduleUiStatePersistence();
      }
      return selected;
    }
    function renderSelectedSessionDetail(session) {
      const panel = document.getElementById("session-detail-panel");
      if (!session) {
        panel.innerHTML = '<div class="empty-state">选择一个 session 后查看活动时间线</div>';
        return;
      }
      const usage = session.usage || {};
      const state = sessionQueueState(session);
      const activityAt = sessionActivityAt(session);
      const primary = sessionPrimaryText(session);
      const first = sessionFirstText(session);
      const threadLink = session.threadUrl
        ? '<a class="link-button" href="' + esc(session.threadUrl) + '" target="_blank" rel="noreferrer">打开 Slack Thread</a>'
        : "";
      panel.innerHTML =
        '<div class="selected-session-head">' +
          '<div class="selected-session-title">' +
            '<div class="session-detail-title" title="' + esc(primary) + '">' + esc(primary) + '</div>' +
            '<div class="session-detail-subtitle" title="' + esc(first) + '">起始：' + esc(first) + '</div>' +
          '</div>' +
          '<div class="session-detail-actions">' + renderBadge(state.label, state.tone) + threadLink + '</div>' +
        '</div>' +
        '<div class="session-body">' +
          '<div class="session-detail-summary">' +
            '<div class="session-detail-kpi"><span>频道</span><strong title="' + esc(session.channelId) + '">' + esc(session.channelLabel || session.channelId) + '</strong></div>' +
            '<div class="session-detail-kpi"><span>最近活动</span><strong title="' + esc(fmtDateTime(activityAt)) + '">' + esc(fmtRelativeTime(activityAt)) + '</strong></div>' +
            '<div class="session-detail-kpi"><span>待处理</span><strong>' + esc((session.openInboundCount || 0) + " 条") + '</strong></div>' +
            '<div class="session-detail-kpi"><span>Jobs</span><strong>' + esc((session.backgroundJobCount || 0) + " / 运行 " + (session.runningBackgroundJobCount || 0)) + '</strong></div>' +
            '<div class="session-detail-kpi"><span>Token / 轮次</span><strong>' + esc(fmtTokens(usage.totalTokens || 0) + " / " + (usage.turnCount || 0)) + '</strong></div>' +
          '</div>' +
          '<div class="session-inspector">' +
            '<div class="mini-panel trace-panel"><div class="mini-title">Agent 活动时间线</div><div class="mini-body"><div data-session-timeline="' + esc(session.key) + '">' + renderTimelinePlaceholder(session) + '</div></div></div>' +
            '<div class="mini-panel"><div class="mini-title">Token 消耗</div><div class="mini-body">' + renderSessionUsage(usage) + '</div></div>' +
            '<div class="mini-panel"><div class="mini-title">消息 / 任务</div><div class="mini-body">' + renderInboundTable(session.openInbound) + renderJobsTable(session.backgroundJobs) + '</div></div>' +
          '</div>' +
        '</div>';
      loadSessionTimeline(session.key);
    }
    function renderTimelinePlaceholder(session) {
      return '<div class="timeline"><div class="timeline-event"><span>' + esc(fmtTime(session.createdAt)) + '</span>' + renderBadge("session", "info") + '<div class="timeline-main"><strong>已创建</strong></div></div></div>';
    }
    function renderTimelineEvents(payload) {
      const events = (Array.isArray(payload) ? payload : (payload?.events || [])).filter(isVisibleTimelineEvent);
      const trace = Array.isArray(payload) ? null : payload?.trace;
      if (!events?.length) return '<div class="summary-detail">暂无时间线事件</div>';
      return renderTraceSummary(trace) + '<div class="timeline">' + events.map(renderTimelineEvent).join("") + '</div>';
    }
    function isVisibleTimelineEvent(event) {
      return String(event?.type || "").toLowerCase() !== "agent_token_count";
    }
    function renderTraceSummary(trace) {
      if (!trace) return "";
      const categories = trace.categories || {};
      const chips = [
        ["agent_system_prompt", "系统"],
        ["agent_memory", "记忆"],
        ["agent_user_message", "用户"],
        ["agent_runtime_reminder", "提醒"],
        ["agent_assistant_message", "Assistant"],
        ["agent_tool_call", "工具"]
      ].map(([key, label]) => renderBadge(label + " " + (categories[key] || 0), statusTone(key))).join("");
      const sourceLabelText = trace.source === "broker_db"
        ? ("已记录 " + esc(trace.eventCount || 0) + " 条 Agent 事件")
        : "Trace 读取异常";
      return '<div class="trace-summary">' +
        renderBadge(trace.source || "unknown", statusTone(trace.source || "unknown")) +
        '<span>' + sourceLabelText + '</span>' +
        chips +
      '</div>';
    }
    function renderTimelineEvent(event) {
      const title = event.title || statusLabel(event.type);
      const detail = event.detail ? '<details class="trace-details"><summary>查看详情</summary><pre>' + esc(event.detail) + '</pre></details>' : "";
      const badgeTone = statusTone(event.status === "failed" || event.status === "error" ? event.status : event.type);
      const meta = [
        event.status ? ("状态 " + statusLabel(event.status)) : "",
        event.role ? ("角色 " + event.role) : "",
        event.toolName ? ("工具 " + event.toolName) : "",
        event.detailTruncated ? "内容已截断" : ""
      ].filter(Boolean).join(" · ");
      return '<div class="timeline-event">' +
        '<span>' + esc(fmtTime(event.at)) + '</span>' +
        renderBadge(event.type || event.status || "event", badgeTone) +
        '<div class="timeline-main">' +
          '<div class="timeline-title"><strong>' + esc(title) + '</strong><span>' + esc(event.summary || "") + '</span></div>' +
          (meta ? '<div class="trace-meta">' + esc(meta) + '</div>' : "") +
          detail +
        '</div>' +
      '</div>';
    }
    function renderSessionUsage(usage) {
      const exact = Number(usage?.exactTurns || 0);
      const total = Number(usage?.turnCount || 0);
      if (!total) return '<div class="summary-detail">这个会话还没有用量记录</div>';
      return '<div class="quota-grid">' +
        '<div class="quota-line"><span>总量</span><strong>' + esc(fmtTokens(usage.totalTokens)) + '</strong><span>' + esc(total + " 回合") + '</span></div>' +
        '<div class="quota-line"><span>输入</span><strong>' + esc(fmtTokens(usage.inputTokens)) + '</strong><span>缓存 ' + esc(fmtTokens(usage.cachedInputTokens)) + '</span></div>' +
        '<div class="quota-line"><span>输出</span><strong>' + esc(fmtTokens(usage.outputTokens)) + '</strong><span>推理 ' + esc(fmtTokens(usage.reasoningTokens)) + '</span></div>' +
        '<div class="quota-line"><span>精确</span><strong>' + esc(exact + "/" + total) + '</strong><span>缺失 ' + esc(usage.missingTurns || 0) + '</span></div>' +
        '<div class="summary-detail">最近：' + esc(fmtDateTime(usage.lastTurnAt)) + '</div>' +
      '</div>';
    }
    async function loadSessionTimeline(sessionKey) {
      if (!sessionKey) return;
      const target = document.querySelector('[data-session-timeline="' + window.CSS.escape(sessionKey) + '"]');
      if (!target) return;
      if (sessionDetailCache.has(sessionKey)) {
        target.innerHTML = renderTimelineEvents(sessionDetailCache.get(sessionKey));
        return;
      }
      target.innerHTML = '<div class="summary-detail">正在加载时间线...</div>';
      try {
        const payload = await requestJson("/admin/api/sessions/" + encodeURIComponent(sessionKey) + "/timeline");
        sessionDetailCache.set(sessionKey, payload);
        target.innerHTML = renderTimelineEvents(payload);
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
        panel.innerHTML = '<div class="empty-state">暂无日志</div>';
        return;
      }
      panel.innerHTML = logs.slice(0, 10).map((entry) => {
        const tone = statusTone(entry.level);
        return '<div class="log-entry ' + tone + '"><span>' + esc(fmtTime(entry.ts)) + '</span><span>' + esc(entry.message || entry.raw || "") + '</span></div>';
      }).join("");
    }

    function render(data) {
      latestStatus = data;
      renderSummary(data);
      renderOperations(data);
      renderService(data);
      renderDeployment(data);
      renderAuthProfiles(data);
      renderGitHubAuthors(data);
      if (useReactSessions) {
        options.onStatus?.(data);
      } else {
        renderSessions(data);
      }
      renderLogs(data);
    }
    async function parseResponse(response) {
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) throw new Error(payload.error || response.statusText || "请求失败");
      return payload;
    }
    async function loadPreflight(operation) {
      return await requestJson("/admin/api/preflight?operation=" + encodeURIComponent(operation));
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
        const status = await requestJson("/admin/api/status");
        const sessionsPayload = await requestJson("/admin/api/sessions");
        status.state = Object.assign({}, status.state || {}, {
          sessions: sessionsPayload.sessions || []
        });
        render(status);
        lastRefresh.textContent = "已同步：" + fmtTime(new Date());
      } catch (error) {
        lastRefresh.textContent = "错误：" + (error instanceof Error ? error.message : String(error));
      } finally {
        refreshButton.disabled = false;
      }
    }
    async function activateProfile(name, allowActive) {
      replaceStatus.textContent = "正在切换认证档案...";
      try {
        const payload = await requestJson("/admin/api/auth-profiles/" + encodeURIComponent(name) + "/activate", {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ allow_active: allowActive })
        });
        render(payload.status);
        replaceStatus.innerHTML = '<span style="color:var(--green)">认证档案已切换</span>';
      } catch (error) {
        replaceStatus.innerHTML = '<span style="color:var(--red)">' + esc(error instanceof Error ? error.message : String(error)) + '</span>';
      }
    }
    async function deleteProfile(name) {
      replaceStatus.textContent = "正在删除认证档案...";
      try {
        const payload = await requestJson("/admin/api/auth-profiles/" + encodeURIComponent(name), { method: "DELETE", headers: authHeaders() });
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
        const payload = await requestJson("/admin/api/auth-profiles", {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ auth_json_content: content })
        });
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
        const payload = await requestJson("/admin/api/deploy", {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ ref, allow_active: allowActive })
        });
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
        const payload = await requestJson("/admin/api/rollback", {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ allow_active: allowActive })
        });
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
        const payload = await requestJson("/admin/api/github-authors", {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ slack_user_id: slackUserId, github_author: githubAuthor })
        });
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
        const payload = await requestJson("/admin/api/github-authors/" + encodeURIComponent(slackUserId), { method: "DELETE", headers: authHeaders() });
        render(payload.status);
        githubAuthorsStatus.innerHTML = '<span style="color:var(--green)">作者映射已删除</span>';
      } catch (error) {
        githubAuthorsStatus.innerHTML = '<span style="color:var(--red)">' + esc(error instanceof Error ? error.message : String(error)) + '</span>';
      }
    }

    if (!useReactSessions && sessionSearch && sessionFilter) {
      sessionSearch.value = uiState.sessionSearch;
      sessionFilter.value = uiState.sessionFilter;
    }
    switchAdminView(uiState.adminView || "dashboard");
    document.querySelectorAll(".nav-item").forEach((item) => {
      item.addEventListener("click", () => {
        const target = item.getAttribute("data-view-target");
        if (target) switchAdminView(target);
      });
    });
    refreshButton.onclick = refresh;
    if (!useReactSessions && sessionSearch && sessionFilter) {
      sessionSearch.oninput = () => {
        updateUiState({ sessionSearch: sessionSearch.value }, { deferPersist: true });
        if (latestStatus) renderSessions(latestStatus);
      };
      sessionSearch.onblur = () => persistUiState();
      sessionFilter.onchange = () => {
        updateUiState({ sessionFilter: sessionFilter.value });
        if (latestStatus) renderSessions(latestStatus);
      };
    }
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

}
