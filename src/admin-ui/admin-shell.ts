export function renderAdminShellHtml(serviceName: string): string {
  return `  <div class="shell">
    <header class="topbar">
      <nav id="admin-nav" class="admin-nav" aria-label="管理台模块">
        <button class="nav-item active" data-view-target="sessions">会话</button>
        <button class="nav-item" data-view-target="ops">操作</button>
      </nav>
      <div class="topbar-center" id="topbar-quota"></div>
      <div class="top-actions">
        <span class="pill">刷新：10 秒</span>
        <span class="pill" id="last-refresh">就绪</span>
        <button id="refresh-button" class="secondary">刷新</button>
      </div>
    </header>

    <div class="admin-content">
      <section class="admin-view active" data-admin-view="sessions">
        <div id="session-react-root" class="session-react-root"></div>
      </section>

      <section class="admin-view" data-admin-view="ops">
        <div class="view-grid">
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
              <div id="risk-panel"></div>
              <div id="deploy-panel"></div>
              <div id="deploy-status" class="summary-detail" style="margin-top:6px;"></div>
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

        <div class="view-grid">
          <section class="panel">
            <div class="panel-head">
              <div class="panel-title">认证档案</div>
              <button id="open-add-profile-dialog">新增</button>
            </div>
            <div id="auth-profiles-panel" class="panel-body maintenance-grid"></div>
            <div id="replace-status" class="summary-detail" style="padding:0 8px 8px;"></div>
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
            <div id="github-authors-status" class="summary-detail" style="padding:0 8px 8px;"></div>
          </section>
        </div>

        <div class="view-grid">
          <section class="panel">
            <div class="panel-head">
              <div class="panel-title">系统日志</div>
            </div>
            <div id="logs-panel" class="log-list"></div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <div class="panel-title">运行信息</div>
            </div>
            <div id="service-card" class="panel-body summary-detail"></div>
          </section>
        </div>
      </section>
    </div>
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

`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
