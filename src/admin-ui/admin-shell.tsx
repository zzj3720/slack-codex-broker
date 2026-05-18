import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
  formatAuthQuotaDisplay,
  formatWeightedWeeklyQuotaScore,
  remainingPercent,
  weightedWeeklyQuotaScore,
  daysUntilReset
} from "../auth-profile-quota";
import {
  profileAccountLabel,
  profilePlanLabel,
  profileTitle
} from "./auth-profile-display";
import {
  connectAdminRealtime,
  getAdminStatusSnapshot,
  mergeAdminStatusSnapshot,
  publishAdminStatus,
  subscribeAdminStatus
} from "./admin-status-store";
import { AdminSessionsView } from "./session-view";
import { statusLabel } from "./timeline-display";

type AdminStatus = Record<string, any>;
type AdminView = "sessions" | "ops";
type Tone = "good" | "warn" | "danger" | "info" | "purple" | "";

export function AdminShell({ serviceName }: {
  readonly serviceName: string;
}): React.JSX.Element {
  const snapshot = useSyncExternalStore(subscribeAdminStatus, getAdminStatusSnapshot, getAdminStatusSnapshot);
  const status = (snapshot.status || {}) as AdminStatus;
  const [adminView, setAdminView] = useState<AdminView>(loadAdminView);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let disconnectRealtime: (() => void) | undefined;
    async function load(): Promise<void> {
      try {
        const nextStatus = await loadAdminSessionsStatus();
        if (!cancelled) {
          publishAdminStatus(nextStatus);
          disconnectRealtime = connectAdminRealtime();
          setLoadError(null);
          void loadAdminOverview().then((overview) => {
            if (!cancelled) publishAdminStatus(mergeStatusOverview(getAdminStatusSnapshot().status, overview));
          }).catch((error) => {
            if (!cancelled) setLoadError(errorMessage(error));
          });
          void loadAdminLogs().then((logsStatus) => {
            if (!cancelled) publishAdminStatus(mergeStatusLogs(getAdminStatusSnapshot().status, logsStatus.logs));
          }).catch(() => undefined);
        }
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      }
    }
    void load();
    return () => {
      cancelled = true;
      disconnectRealtime?.();
    };
  }, []);

  function switchView(nextView: AdminView): void {
    setAdminView(nextView);
    persistAdminView(nextView);
  }

  return (
    <div className="shell" data-service-name={serviceName}>
      <header className="topbar">
        <nav id="admin-nav" className="admin-nav" aria-label="管理台模块">
          <button
            className={"nav-item" + (adminView === "sessions" ? " active" : "")}
            type="button"
            onClick={() => switchView("sessions")}
          >
            会话
          </button>
          <button
            className={"nav-item" + (adminView === "ops" ? " active" : "")}
            type="button"
            onClick={() => switchView("ops")}
          >
            操作
          </button>
        </nav>
        <TopbarQuota profiles={status.authProfiles?.profiles || []} />
      </header>

      <div className="admin-content">
        {loadError ? <div className="summary-detail" style={{ color: "var(--red)", padding: "4px 0" }}>{loadError}</div> : null}
        <section className={"admin-view" + (adminView === "sessions" ? " active" : "")} data-admin-view="sessions">
          <AdminSessionsView />
        </section>
        <section className={"admin-view" + (adminView === "ops" ? " active" : "")} data-admin-view="ops">
          <OperationsView status={status} />
        </section>
      </div>
    </div>
  );
}

function OperationsView({ status }: {
  readonly status: AdminStatus;
}): React.JSX.Element {
  const [addProfileOpen, setAddProfileOpen] = useState(false);
  const [githubBindAccount, setGitHubBindAccount] = useState<Record<string, any> | null>(null);
  const [deployStatus, setDeployStatus] = useState<string | null>(null);
  const [profileStatus, setProfileStatus] = useState<string | null>(null);
  const [githubStatus, setGitHubStatus] = useState<string | null>(null);

  return (
    <div className="ops-page">
      <div className="view-grid ops-grid">
        <DeployPanel status={status} message={deployStatus} setMessage={setDeployStatus} />
        <OperationRecords status={status} />
      </div>

      <div className="view-grid ops-grid">
        <AuthProfilesPanel
          status={status}
          message={profileStatus}
          setMessage={setProfileStatus}
          onAdd={() => setAddProfileOpen(true)}
        />
        <GitHubAccountsPanel
          status={status}
          message={githubStatus}
          setMessage={setGitHubStatus}
          onBind={setGitHubBindAccount}
        />
      </div>

      <div className="view-grid ops-grid">
        <LogsPanel logs={status.state?.recentBrokerLogs || []} />
        <ServicePanel service={status.service || {}} />
      </div>

      {addProfileOpen ? (
        <AddProfileDialog
          onClose={() => setAddProfileOpen(false)}
          onStatus={setProfileStatus}
        />
      ) : null}
      {githubBindAccount ? (
        <GitHubAccountBindDialog
          account={githubBindAccount}
          onClose={() => setGitHubBindAccount(null)}
          onStatus={setGitHubStatus}
        />
      ) : null}
    </div>
  );
}

function DeployPanel({ status, message, setMessage }: {
  readonly status: AdminStatus;
  readonly message: string | null;
  readonly setMessage: (message: string | null) => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState<"deploy" | null>(null);
  const [selectedDeployTarget, setSelectedDeployTarget] = useState<"admin" | "worker">("worker");
  const deployTargetOptions = useMemo(
    () => buildDeployTargetOptions(status.deployment, selectedDeployTarget),
    [status.deployment, selectedDeployTarget]
  );
  const deployTargetValues = deployTargetOptions.map((option) => option.value).join("\n");
  const [selectedDeployVersion, setSelectedDeployVersion] = useState("");
  useEffect(() => {
    setSelectedDeployVersion((previous) =>
      previous && deployTargetOptions.some((option) => option.value === previous)
        ? previous
        : deployTargetOptions[0]?.value || ""
    );
  }, [deployTargetValues]);

  async function runDeploy(): Promise<void> {
    if (!selectedDeployVersion) {
      setMessage("没有可发布的 package 版本");
      return;
    }
    setBusy("deploy");
    setMessage("正在部署版本...");
    try {
      const allowActive = await confirmInterruptRisk("deploy", "发布");
      if (allowActive == null) {
        setMessage(null);
        return;
      }
      const payload = await requestJson("/admin/api/deploy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target: selectedDeployTarget,
          version: selectedDeployVersion,
          allow_active: allowActive
        })
      });
      publishStatusFromPayload(payload);
      setMessage(`已部署 ${targetLabel(selectedDeployTarget)} ${selectedDeployVersion} · 操作 ${payload.operation?.id || ""}`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel ops-panel">
      <div className="panel-head">
        <div className="panel-title">发布</div>
      </div>
      <div className="panel-body">
        <div className="deploy-actions">
          <label className="deploy-target-field">
            <span className="summary-label">目标</span>
            <select
              id="deploy-package-target-select"
              aria-label="发布目标"
              value={selectedDeployTarget}
              disabled={busy !== null}
              onChange={(event) => setSelectedDeployTarget(event.target.value === "admin" ? "admin" : "worker")}
            >
              <option value="worker">Worker</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <label className="deploy-target-field">
            <span className="summary-label">Package 版本</span>
            <select
              id="deploy-package-version-select"
              aria-label="Package 版本"
              value={selectedDeployVersion}
              disabled={deployTargetOptions.length === 0 || busy !== null}
              onChange={(event) => setSelectedDeployVersion(event.target.value)}
            >
              {deployTargetOptions.length ? deployTargetOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              )) : (
                <option value="">没有可发布的 package 版本</option>
              )}
            </select>
          </label>
          <button className="primary" type="button" disabled={busy !== null || !selectedDeployVersion} onClick={() => { void runDeploy(); }}>
            部署版本
          </button>
        </div>
        <RiskPanel state={status.state || {}} />
        <DeploymentPanel deployment={status.deployment} />
        {message ? <div className={"summary-detail " + (message.includes("失败") || message.includes("必须") ? "danger" : "")} style={{ marginTop: 6 }}>{message}</div> : null}
      </div>
    </section>
  );
}

function OperationRecords({ status }: {
  readonly status: AdminStatus;
}): React.JSX.Element {
  const operations = Array.isArray(status.operations) ? status.operations : [];
  const events = Array.isArray(status.auditEvents) ? status.auditEvents : [];
  return (
    <section className="panel ops-panel">
      <div className="panel-head">
        <div className="panel-title">操作记录</div>
        <span className="badge purple">审计</span>
      </div>
      <div className="panel-body">
        <div className="operation-list">
          {operations.length ? operations.slice(0, 5).map((operation: Record<string, any>) => (
            <div className="operation-row" key={operation.id || `${operation.kind}-${operation.updatedAt}`}>
              <Badge label={operation.status || "unknown"} tone={statusTone(operation.status)} />
              <div className="operation-main">
                <div className="operation-title">{operationLabel(operation.kind)}</div>
                <div className="operation-detail">{pickOperationLabel(operation)}</div>
              </div>
              <div className="summary-detail">{fmtTime(operation.updatedAt)}</div>
            </div>
          )) : (
            <div className="empty-state">暂无管理操作</div>
          )}
        </div>
        <div className="audit-list">
          {events.slice(0, 6).map((event: Record<string, any>) => (
            <div key={event.id || `${event.action}-${event.createdAt}`}>
              {fmtTime(event.createdAt)} · {operationLabel(event.action)} · {statusLabel(event.status)}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function AuthProfilesPanel({ status, message, setMessage, onAdd }: {
  readonly status: AdminStatus;
  readonly message: string | null;
  readonly setMessage: (message: string | null) => void;
  readonly onAdd: () => void;
}): React.JSX.Element {
  const profiles = [...(status.authProfiles?.profiles || [])].sort((left, right) =>
    String(right.mtime || "").localeCompare(String(left.mtime || ""))
  );

  async function deleteProfile(name: string): Promise<void> {
    if (!window.confirm(`删除认证档案 ${name}？`)) return;
    setMessage("正在删除账号...");
    try {
      const payload = await requestJson(`/admin/api/auth-profiles/${encodeURIComponent(name)}`, { method: "DELETE" });
      publishStatusFromPayload(payload);
      setMessage("账号已删除");
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  return (
    <section className="panel ops-panel">
      <div className="panel-head">
        <div className="panel-title">账号池</div>
        <button type="button" onClick={onAdd}>添加</button>
      </div>
      <div className="panel-body maintenance-grid">
        {profiles.length ? profiles.map((profile: Record<string, any>) => {
          const quota = profileQuotaSummary(profile.rateLimits);
          const plan = profilePlanLabel(profile);
          const issue = profile.account?.error || profile.rateLimits?.error || "";
          const cardTone = profile.account?.ok === false || quota.ok === false ? "danger" : quota.tone;
          return (
          <div className={"profile-card " + cardTone} key={profile.name || profile.path || profile.mtime} title={profileTitle(profile)}>
            <div className="profile-card-head">
              <div className="profile-identity">
                <div className="profile-account-row">
                  <span className="profile-account">{profileAccountLabel(profile)}</span>
                  {plan ? <span className="profile-plan-badge">{plan}</span> : null}
                </div>
                {issue ? <div className="profile-card-subtitle">{issue}</div> : null}
              </div>
              <button className="profile-delete-button danger" type="button" onClick={() => { void deleteProfile(String(profile.name || "")); }}>
                删除
              </button>
            </div>
            <ProfileQuotaMetrics quota={quota} />
          </div>
          );
        }) : (
          <div className="empty-state">暂无账号</div>
        )}
      </div>
      {message ? <div className="summary-detail" style={{ padding: "0 8px 8px" }}>{message}</div> : null}
    </section>
  );
}

function GitHubAccountsPanel({ status, message, setMessage, onBind }: {
  readonly status: AdminStatus;
  readonly message: string | null;
  readonly setMessage: (message: string | null) => void;
  readonly onBind: (account: Record<string, any>) => void;
}): React.JSX.Element {
  const accounts = normalizeGitHubAccounts(status);
  const boundAccounts = accounts.filter((account) => account.prBinding?.state === "bound");
  const currentDefaultAccount = accounts.find((account) => account.isDefaultPrAccount);
  const defaultPrAccount = status.githubAccounts?.defaultPrAccount;
  const selectableDefaultAccounts = boundAccounts;
  const defaultSelectValue = currentDefaultAccount?.slackUserId ||
    (defaultPrAccount?.available && defaultPrAccount.source === "env" ? "__env_default__" : "");
  const selectableDefaultAccountKeys = selectableDefaultAccounts.map((account) => account.slackUserId).join("\n");
  const [defaultSelection, setDefaultSelection] = useState("");
  useEffect(() => {
    const nextSelection = defaultSelectValue || selectableDefaultAccounts[0]?.slackUserId || "";
    setDefaultSelection((previous) =>
      previous && (previous === defaultSelectValue || selectableDefaultAccounts.some((account) => account.slackUserId === previous))
        ? previous
        : nextSelection
    );
  }, [defaultSelectValue, selectableDefaultAccountKeys]);

  async function setDefault(slackUserId: string): Promise<void> {
    if (!slackUserId) {
      setMessage("先选择一个已绑定的 GitHub 账号");
      return;
    }
    setMessage("正在设置默认 PR 账号...");
    try {
      const payload = await requestJson("/admin/api/github-accounts/default-pr", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slack_user_id: slackUserId })
      });
      publishStatusFromPayload(payload);
      setMessage("默认 PR 账号已更新");
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  const currentDefaultLabel = currentDefaultAccount
    ? githubAccountOptionLabel(currentDefaultAccount)
    : defaultPrAccount?.available && defaultPrAccount.source === "env"
      ? `环境默认账号 ${defaultPrAccount.githubLogin || ""}`.trim()
      : "未设置";
  const canSwitchDefault = Boolean(defaultSelection) &&
    defaultSelection !== defaultSelectValue &&
    selectableDefaultAccounts.some((account) => account.slackUserId === defaultSelection);

  return (
    <section className="panel ops-panel">
      <div className="panel-head">
        <div className="panel-title">GitHub 账号</div>
      </div>
      <div className="github-default-control">
        <label className="github-default-field">
          <span className="summary-label">默认 PR 账号</span>
          <select
            aria-label="选择候选 GitHub PR 账号"
            value={defaultSelection}
            disabled={selectableDefaultAccounts.length === 0}
            onChange={(event) => setDefaultSelection(event.target.value)}
          >
            {defaultSelectValue && !currentDefaultAccount ? (
              <option value={defaultSelectValue}>{currentDefaultLabel}</option>
            ) : null}
            {selectableDefaultAccounts.length ? selectableDefaultAccounts.map((account) => (
              <option key={account.slackUserId} value={account.slackUserId}>
                {githubAccountOptionLabel(account)}
              </option>
            )) : (
              <option value="">未设置</option>
            )}
          </select>
        </label>
        <div className="github-default-actions">
          <button
            className="secondary"
            type="button"
            disabled={!canSwitchDefault}
            onClick={() => { void setDefault(defaultSelection); }}
          >
            切换
          </button>
        </div>
        {boundAccounts.length === 0 ? (
          <div className="summary-detail github-default-hint">先绑定任意 Slack 用户的 GitHub OAuth 后，才能设置默认账号。</div>
        ) : null}
      </div>
      <div className="panel-body maintenance-grid">
        {accounts.length ? accounts.map((account) => {
          const identity = account.slackIdentity || {};
          const binding = account.prBinding || {};
          const label = identity.realName || identity.displayName || identity.username || account.slackUserId;
          const detail = [account.slackUserId, identity.email].filter(Boolean).join(" · ");
          const githubEmail = binding.githubEmail || "";
          const githubSummary = binding.githubLogin
            ? `GitHub：${binding.githubLogin}${githubEmail ? ` · ${githubEmail}` : ""}`
            : "";
          return (
            <div className="profile-row" key={account.slackUserId}>
              <div className="profile-line">
                <span className="profile-account">{label}</span>
                <span className="profile-plan">{detail || account.slackUserId}</span>
                <Badge label={githubBindingLabel(binding)} tone={githubBindingTone(binding)} />
                {account.isDefaultPrAccount ? <Badge label="默认 PR" tone="purple" /> : null}
              </div>
              {githubSummary ? <div className="summary-detail">{githubSummary}</div> : null}
              <div className="profile-actions">
                <button className="secondary" type="button" onClick={() => onBind(account)}>
                  {binding.state === "bound" ? "重新绑定 GitHub" : "绑定 GitHub"}
                </button>
                {binding.state === "bound" && !account.isDefaultPrAccount ? (
                  <button className="secondary" type="button" onClick={() => { void setDefault(account.slackUserId); }}>设为默认 PR</button>
                ) : null}
              </div>
            </div>
          );
        }) : (
          <div className="empty-state">暂无 GitHub 账号</div>
        )}
      </div>
      {message ? <div className="summary-detail" style={{ padding: "0 8px 8px" }}>{message}</div> : null}
    </section>
  );
}

function LogsPanel({ logs }: {
  readonly logs: readonly Record<string, any>[];
}): React.JSX.Element {
  return (
    <section className="panel ops-panel">
      <div className="panel-head">
        <div className="panel-title">系统日志</div>
      </div>
      <div className="log-list">
        {logs.length ? logs.slice(0, 10).map((entry, index) => (
          <div className={"log-entry " + statusTone(entry.level)} key={`${entry.ts || index}-${entry.message || entry.raw || ""}`}>
            <span>{fmtTime(entry.ts)}</span>
            <span>{entry.message || entry.raw || ""}</span>
          </div>
        )) : (
          <div className="empty-state">暂无日志</div>
        )}
      </div>
    </section>
  );
}

function ServicePanel({ service }: {
  readonly service: Record<string, any>;
}): React.JSX.Element {
  return (
    <section className="panel ops-panel">
      <div className="panel-head">
        <div className="panel-title">运行信息</div>
      </div>
      <div className="panel-body summary-detail" style={{ display: "grid", gap: 6 }}>
        <div>名称：{service.name || "--"}</div>
        <div>模式：{statusLabel(service.mode || "--")}</div>
        <div>端口：{service.port || "--"}</div>
        <div>启动：{fmtDateTime(service.startedAt)}</div>
        <div style={{ wordBreak: "break-all" }}>会话目录：{service.sessionsRoot || "--"}</div>
        <div style={{ wordBreak: "break-all" }}>CODEX_HOME: {service.codexHome || "--"}</div>
      </div>
    </section>
  );
}

function AddProfileDialog({ onClose, onStatus }: {
  readonly onClose: () => void;
  readonly onStatus: (message: string | null) => void;
}): React.JSX.Element {
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState<Record<string, any> | null>(null);
  const [tick, setTick] = useState(0);
  const pollTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    return () => {
      if (pollTimerRef.current != null) window.clearTimeout(pollTimerRef.current);
    };
  }, []);

  async function saveAuthJson(): Promise<void> {
    setBusy(true);
    setMessage("正在保存...");
    try {
      const content = text.trim() || (file ? await file.text() : "");
      if (!content) throw new Error("必须提供 auth.json");
      const payload = await requestJson("/admin/api/auth-profiles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ auth_json_content: content })
      });
      publishStatusFromPayload(payload);
      onStatus("认证档案已保存");
      onClose();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function startDeviceCode(): Promise<void> {
    if (pollTimerRef.current != null) window.clearTimeout(pollTimerRef.current);
    setBusy(true);
    setMessage("正在申请设备码...");
    setDeviceCode(null);
    try {
      const payload = await requestJson("/admin/api/auth-profiles/device-code/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      });
      const nextDeviceCode = payload.deviceCode;
      if (!nextDeviceCode?.deviceAuthId || !nextDeviceCode?.userCode || !nextDeviceCode?.verificationUrl) {
        throw new Error("设备码响应不完整");
      }
      setDeviceCode(nextDeviceCode);
      setMessage("等待登录确认...");
      schedulePoll(nextDeviceCode, Number(nextDeviceCode.intervalSeconds || 5));
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function schedulePoll(current: Record<string, any>, intervalSeconds: number): void {
    if (pollTimerRef.current != null) window.clearTimeout(pollTimerRef.current);
    pollTimerRef.current = window.setTimeout(() => {
      void pollDeviceCode(current);
    }, Math.max(1, Number(intervalSeconds) || 5) * 1000);
  }

  async function pollDeviceCode(current: Record<string, any>): Promise<void> {
    if (Date.parse(String(current.expiresAt || "")) <= Date.now()) {
      setMessage("设备码已过期，重新申请一个。");
      setDeviceCode(null);
      return;
    }
    try {
      const payload = await requestJson("/admin/api/auth-profiles/device-code/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          device_auth_id: current.deviceAuthId,
          user_code: current.userCode,
          retry_after_seconds: current.intervalSeconds || 5
        })
      });
      if (payload.deviceCode?.status === "pending") {
        setMessage("等待登录确认...");
        const next = { ...current, ...payload.deviceCode };
        setDeviceCode(next);
        schedulePoll(next, Number(payload.deviceCode.retryAfterSeconds || current.intervalSeconds || 5));
        return;
      }
      if (payload.deviceCode?.status !== "complete") {
        throw new Error("设备码确认响应不完整");
      }
      publishStatusFromPayload(payload);
      onStatus("认证档案已保存");
      onClose();
    } catch (error) {
      setMessage(errorMessage(error));
      setDeviceCode(null);
    }
  }

  const remainingSeconds = deviceCode?.expiresAt
    ? Math.max(0, Math.ceil((Date.parse(String(deviceCode.expiresAt)) - Date.now() + tick * 0) / 1000))
    : null;

  return (
    <dialog open>
      <div className="modal-content add-profile-modal">
        <div className="modal-heading">
          <div className="panel-title">添加账号</div>
          <div className="summary-detail">推荐使用设备码 OAuth</div>
        </div>
        <section className="auth-primary-card">
          <div className="auth-primary-copy">
            <div className="auth-primary-title">设备码 OAuth</div>
            <div className="summary-detail">浏览器完成登录后自动保存账号</div>
          </div>
          <button className="primary" type="button" disabled={busy} onClick={() => { void startDeviceCode(); }}>开始设备码登录</button>
        </section>
        {deviceCode ? (
          <div className="device-code-panel">
            <div className="device-code-row">
              <span>登录页面</span>
              <a className="link-button" href={String(deviceCode.verificationUrl)} target="_blank" rel="noreferrer">打开</a>
            </div>
            <div className="device-code-label">一次性代码</div>
            <div className="code-block">{String(deviceCode.userCode || "")}</div>
            <div className="summary-detail">{remainingSeconds == null ? "" : `剩余 ${Math.ceil(remainingSeconds / 60)} 分钟`}</div>
          </div>
        ) : null}
        <details className="auth-json-fallback" open={fallbackOpen} onToggle={(event) => setFallbackOpen(event.currentTarget.open)}>
          <summary>备用：导入 auth.json</summary>
          <div className="fallback-body">
            <input type="file" accept="application/json,.json" onChange={(event) => setFile(event.currentTarget.files?.[0] || null)} />
            <textarea placeholder="在这里粘贴 auth.json..." value={text} onChange={(event) => setText(event.target.value)} />
            <div className="fallback-actions">
              <button className="secondary" type="button" disabled={busy} onClick={() => { void saveAuthJson(); }}>保存 auth.json</button>
            </div>
          </div>
        </details>
        <div className="modal-actions">
          <button className="secondary" type="button" onClick={onClose}>取消</button>
        </div>
        {message ? <div className="summary-detail">{message}</div> : null}
      </div>
    </dialog>
  );
}

function GitHubAccountBindDialog({ account, onClose, onStatus }: {
  readonly account: Record<string, any>;
  readonly onClose: () => void;
  readonly onStatus: (message: string | null) => void;
}): React.JSX.Element {
  const [device, setDevice] = useState<Record<string, any> | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const startedRef = useRef(false);
  const identity = account.slackIdentity || {};
  const label = identity.realName || identity.displayName || identity.username || account.slackUserId;

  useEffect(() => {
    if (startedRef.current) {
      return;
    }
    startedRef.current = true;
    void startGitHubAccountDeviceAuthorization();
  }, [account.slackUserId]);

  useEffect(() => {
    if (!device?.id) {
      return;
    }
    let cancelled = false;
    let timeout: number | undefined;
    async function poll(): Promise<void> {
      try {
        const payload = await requestJson(githubDevicePollApiPath(String(device.id))) as Record<string, any>;
        const result = payload.result as Record<string, any>;
        if (cancelled) return;
        if (result.status === "completed") {
          setDevice(null);
          setMessage("GitHub 账号已绑定。");
          onStatus("GitHub 账号已绑定");
          publishAdminStatus(await loadAdminStatus());
          return;
        }
        if (result.status === "expired") {
          setMessage("设备码已过期，请重新发起绑定。");
          setDevice(null);
          return;
        }
        if (result.status === "failed") {
          setMessage(String(result.error || "绑定失败"));
          setDevice(null);
          return;
        }
        timeout = window.setTimeout(
          () => { void poll(); },
          Math.max(1, Number(result.retryAfterSeconds || device.intervalSeconds || 5)) * 1000
        );
      } catch (error) {
        if (!cancelled) setMessage(errorMessage(error));
      }
    }
    timeout = window.setTimeout(() => { void poll(); }, 800);
    return () => {
      cancelled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [device?.id]);

  async function startGitHubAccountDeviceAuthorization(): Promise<void> {
    setBusy(true);
    setMessage("正在申请 GitHub 设备码...");
    try {
      const payload = await requestJson(githubAccountDeviceStartApiPath(String(account.slackUserId)), { method: "POST" }) as Record<string, any>;
      setDevice(payload.device as Record<string, any>);
      setMessage("打开 GitHub 验证页，输入下面的代码完成绑定。");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog open>
      <div className="modal-content">
        <div className="modal-heading">
          <div className="panel-title">绑定 GitHub</div>
          <div className="summary-detail">{label} · {account.slackUserId}</div>
        </div>
        {device ? (
          <div className="device-code-panel">
            <div className="device-code-label">GitHub 设备码</div>
            <div className="code-block">{String(device.userCode || "")}</div>
            <a className="link-button" href={String(device.verificationUriComplete || device.verificationUri || "https://github.com/login/device")} target="_blank" rel="noreferrer">
              打开 GitHub 验证页
            </a>
          </div>
        ) : null}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="secondary" type="button" onClick={onClose}>取消</button>
          {!device && !busy ? (
            <button className="primary" type="button" onClick={() => { void startGitHubAccountDeviceAuthorization(); }}>重新申请</button>
          ) : null}
        </div>
        {message ? <div className="summary-detail">{message}</div> : null}
      </div>
    </dialog>
  );
}

function TopbarQuota({ profiles }: {
  readonly profiles: readonly Record<string, any>[];
}): React.JSX.Element {
  const quotaItems = useMemo(() => authProfileQuotaItems(profiles), [profiles]);
  return (
    <div className="topbar-center">
      {quotaItems.length ? quotaItems.map((item) => (
        <span className={"quota-pill " + quotaTone(item.remaining)} title={item.title} key={item.title}>
          <strong>{item.label}</strong>
        </span>
      )) : (
        <span className="quota-meta">账号池额度未知</span>
      )}
    </div>
  );
}

function RiskPanel({ state }: {
  readonly state: Record<string, any>;
}): React.JSX.Element {
  const active = Number(state.activeCount || 0);
  const open = Number(state.openInboundCount || 0);
  const running = Number(state.runningBackgroundJobCount || 0);
  const safe = active + open + running === 0;
  return (
    <>
      <div className="risk-strip">
        <RiskCell label="活跃" value={active} />
        <RiskCell label="待处理" value={open} />
        <RiskCell label="运行" value={running} />
      </div>
      <div className="risk-copy">
        {safe ? "当前没有活跃工作，发布和回滚不需要额外确认。" : "发布和回滚会中断正在进行的管理工作，执行前必须显式确认。"}
      </div>
    </>
  );
}

function RiskCell({ label, value, danger = false }: {
  readonly label: string;
  readonly value: number;
  readonly danger?: boolean;
}): React.JSX.Element {
  return (
    <div className="risk-cell">
      <div className="risk-number" style={danger ? { color: "var(--red)" } : undefined}>{value}</div>
      <div className="risk-label">{label}</div>
    </div>
  );
}

function DeploymentPanel({ deployment }: {
  readonly deployment: any;
}): React.JSX.Element {
  if (!deployment) {
    return <div className="summary-detail">发布状态不可用</div>;
  }
  if (deployment.ok === false) {
    return <div className="summary-detail danger">发布状态读取失败：{deployment.error || "unknown"}</div>;
  }
  const admin = deployment.admin || {};
  const worker = deployment.worker || {};
  const targets = deployment.targets || {};
  return (
    <>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Badge label={admin.launchdLoaded ? "管理进程已加载" : "管理进程未运行"} tone={admin.launchdLoaded ? "good" : "danger"} />
        <Badge label={admin.healthOk ? "管理 HTTP 正常" : "管理 HTTP 异常"} tone={admin.healthOk ? "good" : "danger"} />
        <Badge label={worker.launchdLoaded ? "工作进程已加载" : "工作进程未运行"} tone={worker.launchdLoaded ? "good" : "danger"} />
        <Badge label={worker.healthOk ? "HTTP 正常" : "HTTP 异常"} tone={worker.healthOk ? "good" : "danger"} />
        <Badge label={worker.readyOk ? "Codex 就绪" : "Codex 异常"} tone={worker.readyOk ? "good" : "danger"} />
      </div>
      <div className="release-current-grid">
        <ReleaseTargetPanel target="worker" status={targets.worker} />
        <ReleaseTargetPanel target="admin" status={targets.admin} />
      </div>
    </>
  );
}

function ReleaseTargetPanel({ target, status }: {
  readonly target: "admin" | "worker";
  readonly status: any;
}): React.JSX.Element {
  return (
    <div className="release-stack">
      <div className="profile-line">
        <span className="profile-account">{targetLabel(target)}</span>
        <span className="profile-plan">{status?.packageName || "package"}</span>
      </div>
      <ReleaseRow label="当前版本" release={status?.currentRelease} />
    </div>
  );
}

function ReleaseRow({ label, release }: {
  readonly label: string;
  readonly release: any;
}): React.JSX.Element {
  if (!release?.targetPath) {
    return <div className="summary-detail">{label}：无</div>;
  }
  const metadata = release.metadata || {};
  const heading = metadata.packageVersion || metadata.shortRevision || metadata.revision || String(release.targetPath).split("/").pop() || "release";
  const detailTime = metadata.installedAt || metadata.builtAt;
  return (
    <div className="release-row">
      <div className="profile-line">
        <span className="profile-account">{label}：{heading}</span>
        <span className="profile-plan">{metadata.packageName || metadata.branch || "package"}</span>
      </div>
      <div className="summary-detail">{detailTime ? fmtDateTime(detailTime) : release.targetPath}</div>
    </div>
  );
}

type DeployTargetOption = {
  readonly value: string;
  readonly label: string;
};

function buildDeployTargetOptions(deployment: any, target: "admin" | "worker"): readonly DeployTargetOption[] {
  const targetStatus = deployment?.targets?.[target] || {};
  const versions = Array.isArray(targetStatus.recentPackageVersions) ? targetStatus.recentPackageVersions : [];
  return versions
    .map((entry: Record<string, any>) => {
      const version = String(entry.version || "").trim();
      if (!version) return null;
      const spec = String(entry.packageSpec || "").trim();
      return {
        value: version,
        label: spec || version
      };
    })
    .filter((option): option is DeployTargetOption => Boolean(option));
}

function targetLabel(target: "admin" | "worker"): string {
  return target === "admin" ? "Admin" : "Worker";
}

function ProfileQuotaMetrics({ quota }: {
  readonly quota: ProfileQuotaSummary;
}): React.JSX.Element {
  if (quota.ok === false) {
    return <div className="profile-quota-error">{quota.error}</div>;
  }
  return (
    <div className="profile-quota-block" title={quota.fullLabel}>
      <div className="profile-quota-metrics">
        <div className={"profile-quota-metric " + quota.tone}>
          <span>7d 剩余</span>
          <strong>{quota.remainingLabel}</strong>
        </div>
        <div className={"profile-quota-metric " + quota.tone}>
          <span>加权</span>
          <strong>{quota.scoreLabel}</strong>
        </div>
        <div className="profile-quota-metric">
          <span>重置</span>
          <strong>{quota.resetLabel}</strong>
        </div>
      </div>
      {quota.shortLabel ? (
        <div className="profile-short-window">
          <span>短窗</span>
          <strong>{quota.shortLabel}</strong>
        </div>
      ) : null}
    </div>
  );
}

type ProfileQuotaSummary =
  | {
      readonly ok: true;
      readonly fullLabel: string;
      readonly remainingLabel: string;
      readonly scoreLabel: string;
      readonly resetLabel: string;
      readonly shortLabel: string | null;
      readonly tone: Tone;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly tone: Tone;
    };

function profileQuotaSummary(rateLimits: any): ProfileQuotaSummary {
  if (!rateLimits || rateLimits.ok === false) {
    return {
      ok: false,
      error: rateLimits?.error || "额度不可用",
      tone: "danger"
    };
  }

  const snapshot = rateLimits.rateLimits || {};
  const secondary = snapshot.secondary || {};
  const fullLabel = formatAuthQuotaDisplay({
    primary: snapshot.primary,
    secondary
  }) || "额度未知";
  const [weeklyLabel, ...shortParts] = fullLabel.split(" | ");
  const remaining = remainingPercent(secondary.usedPercent);
  const score = weightedWeeklyQuotaScore(remaining, daysUntilReset(secondary.resetsAt));
  return {
    ok: true,
    fullLabel,
    remainingLabel: remaining === undefined ? "--" : `${Math.round(remaining)}%`,
    scoreLabel: formatWeightedWeeklyQuotaScore(score),
    resetLabel: formatResetTime(secondary.resetsAt),
    shortLabel: shortParts.length ? shortParts.join(" | ") : null,
    tone: quotaTone(remaining ?? 100) || (weeklyLabel ? "" : "warn")
  };
}

function Badge({ label, tone = "" }: {
  readonly label: string;
  readonly tone?: Tone;
}): React.JSX.Element {
  return <span className={"badge " + (tone || statusTone(label))}>{statusLabel(label)}</span>;
}

async function loadAdminStatus(): Promise<AdminStatus> {
  const sessionStatus = await loadAdminSessionsStatus();
  const [overviewResult, logsResult] = await Promise.allSettled([
    loadAdminOverview(),
    loadAdminLogs()
  ]);
  const withOverview = overviewResult.status === "fulfilled"
    ? mergeStatusOverview(sessionStatus, overviewResult.value)
    : sessionStatus;
  return logsResult.status === "fulfilled"
    ? mergeStatusLogs(withOverview, logsResult.value.logs)
    : withOverview;
}

async function loadAdminSessionsStatus(): Promise<AdminStatus> {
  const sessionsPayload = await requestJson("/admin/api/sessions", { timeoutMs: 45_000 });
  const sessions = Array.isArray(sessionsPayload.sessions) ? sessionsPayload.sessions : [];
  return {
    ok: true,
    realtime: sessionsPayload.realtime || {},
    state: {
      ...summarizeSessionRows(sessions),
      sessions
    }
  };
}

async function loadAdminOverview(): Promise<Record<string, any>> {
  return await requestJson("/admin/api/overview", { timeoutMs: 45_000 });
}

async function loadAdminLogs(): Promise<Record<string, any>> {
  return await requestJson("/admin/api/logs?limit=40", { timeoutMs: 5_000 });
}

function mergeStatusOverview(status: unknown, overview: unknown): AdminStatus {
  return mergeAdminStatusSnapshot(status, overview) as AdminStatus;
}

function mergeStatusLogs(status: unknown, logs: unknown): AdminStatus {
  const current = status && typeof status === "object" && !Array.isArray(status)
    ? status as AdminStatus
    : {};
  return {
    ...current,
    state: {
      ...(current.state || {}),
      recentBrokerLogs: Array.isArray(logs) ? logs : []
    }
  };
}

function summarizeSessionRows(sessions: readonly Record<string, any>[]): Record<string, number> {
  return sessions.reduce((summary, session) => {
    const openInboundCount = Number(session.openInboundCount || 0);
    const openHumanInboundCount = Number(session.openHumanInboundCount || 0);
    const openSystemInboundCount = Number(session.openSystemInboundCount || 0);
    const backgroundJobCount = Number(session.backgroundJobCount || 0);
    const runningBackgroundJobCount = Number(session.runningBackgroundJobCount || 0);
    const failedBackgroundJobCount = Number(session.failedBackgroundJobCount || 0);
    return {
      sessionCount: summary.sessionCount + 1,
      activeCount: summary.activeCount + (session.activeTurnId ? 1 : 0),
      openInboundCount: summary.openInboundCount + openInboundCount,
      openHumanInboundCount: summary.openHumanInboundCount + openHumanInboundCount,
      openSystemInboundCount: summary.openSystemInboundCount + openSystemInboundCount,
      backgroundJobCount: summary.backgroundJobCount + backgroundJobCount,
      runningBackgroundJobCount: summary.runningBackgroundJobCount + runningBackgroundJobCount,
      failedBackgroundJobCount: summary.failedBackgroundJobCount + failedBackgroundJobCount
    };
  }, {
    sessionCount: 0,
    activeCount: 0,
    openInboundCount: 0,
    openHumanInboundCount: 0,
    openSystemInboundCount: 0,
    backgroundJobCount: 0,
    runningBackgroundJobCount: 0,
    failedBackgroundJobCount: 0
  });
}

type AdminRequestInit = RequestInit & {
  readonly timeoutMs?: number | undefined;
};

async function requestJson(path: string, init: AdminRequestInit = {}): Promise<Record<string, any>> {
  const { timeoutMs, ...fetchInit } = init;
  let timeout: number | null = null;
  const responsePromise = fetch(path, fetchInit).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || response.statusText || "请求失败");
    }
    return payload as Record<string, any>;
  });
  if (!timeoutMs) {
    return await responsePromise;
  }
  try {
    return await Promise.race([
      responsePromise,
      new Promise<Record<string, any>>((_, reject) => {
        timeout = window.setTimeout(() => reject(new Error(`请求超时：${path}`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== null) {
      window.clearTimeout(timeout);
    }
  }
}

function githubAccountDeviceStartApiPath(slackUserId: string): string {
  return "/admin/api/github-accounts/" + encodeURIComponent(slackUserId) + "/oauth/device/start";
}

function githubDevicePollApiPath(deviceAuthorizationId: string): string {
  return "/admin/api/github-oauth/device/" + encodeURIComponent(deviceAuthorizationId);
}

async function confirmInterruptRisk(operation: string, verb: string): Promise<boolean | null> {
  const preflight = await requestJson("/admin/api/preflight?operation=" + encodeURIComponent(operation));
  if (preflight.safe) return false;
  const detail = "活跃：" + (preflight.activeCount || 0) +
    " · 待处理：" + (preflight.openInboundCount || 0) +
    " · 运行任务：" + (preflight.runningBackgroundJobCount || 0);
  return window.confirm(`${verb} 会中断正在进行的管理工作。${detail}。继续？`) ? true : null;
}

function publishStatusFromPayload(payload: Record<string, any>): void {
  if (payload.status) {
    publishAdminStatus(payload.status);
  }
}

function loadAdminView(): AdminView {
  try {
    const raw = window.localStorage.getItem(uiStateStorageKey());
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    return parsed.adminView === "ops" ? "ops" : "sessions";
  } catch {
    return "sessions";
  }
}

function persistAdminView(adminView: AdminView): void {
  try {
    const raw = window.localStorage.getItem(uiStateStorageKey());
    const previous = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    window.localStorage.setItem(uiStateStorageKey(), JSON.stringify({ ...previous, adminView }));
  } catch {}
}

function uiStateStorageKey(): string {
  return "admin-ui-state:" + window.location.pathname;
}

function authProfileQuotaItems(profiles: readonly Record<string, any>[]): Array<{
  readonly label: string;
  readonly title: string;
  readonly score: number;
  readonly remaining: number;
}> {
  return profiles
    .map((profile) => {
      const rateLimits = profile.rateLimits || {};
      if (rateLimits.ok === false) return null;
      const limits = rateLimits.rateLimits || {};
      const secondary = limits.secondary;
      const label = formatAuthQuotaDisplay({
        primary: limits.primary,
        secondary
      });
      if (!label) return null;
      const remaining = remainingPercent(secondary?.usedPercent);
      const score = weightedWeeklyQuotaScore(remaining, daysUntilReset(secondary?.resetsAt));
      return {
        label,
        title: profileTitle(profile),
        score: score ?? -1,
        remaining: remaining ?? 0
      };
    })
    .filter((item): item is { readonly label: string; readonly title: string; readonly score: number; readonly remaining: number } => Boolean(item))
    .sort((left, right) =>
      (right.score - left.score) ||
      (right.remaining - left.remaining) ||
      left.title.localeCompare(right.title)
    );
}

function normalizeGitHubAccounts(status: AdminStatus): Array<Record<string, any>> {
  const accounts = status.githubAccounts?.accounts;
  if (Array.isArray(accounts) && accounts.length > 0) return accounts;
  const fallback = buildFallbackGitHubAccounts(status);
  return fallback;
}

function buildFallbackGitHubAccounts(status: AdminStatus): Array<Record<string, any>> {
  const rows = new Map<string, Record<string, any>>();
  const bindings = Array.isArray(status.githubPrIdentities?.bindings) ? status.githubPrIdentities.bindings : [];
  const sessions = Array.isArray(status.state?.sessions) ? status.state.sessions : [];
  const defaultAccount = status.githubAccounts?.defaultPrAccount;
  const defaultSlackUserId = defaultAccount?.available === true && defaultAccount.source === "bound"
    ? String(defaultAccount.slackUserId || "")
    : "";

  function addSlackUser(userId: unknown, identity?: Record<string, any> | null): void {
    const slackUserId = String(userId || "").trim();
    if (!slackUserId || slackUserId.startsWith("username:")) return;
    const normalizedIdentity = normalizeSlackIdentity(slackUserId, identity);
    const existing = rows.get(slackUserId);
    if (!rows.has(slackUserId)) {
      rows.set(slackUserId, {
        slackUserId,
        slackIdentity: normalizedIdentity,
        isDefaultPrAccount: slackUserId === defaultSlackUserId,
        prBinding: {
          state: "unbound"
        }
      });
      return;
    }
    if (existing) {
      rows.set(slackUserId, {
        ...existing,
        slackIdentity: mergeSlackIdentity(existing.slackIdentity, normalizedIdentity)
      });
    }
  }

  for (const session of sessions) {
    addSlackUser(session.initiatorUserId);
    addSlackUser(session.firstUserMessage?.userId, session.firstUserMessage?.slackIdentity || identityFromSessionMessage(session.firstUserMessage));
    addSlackUser(session.lastUserMessage?.userId, session.lastUserMessage?.slackIdentity || identityFromSessionMessage(session.lastUserMessage));
    for (const message of Array.isArray(session.openInbound) ? session.openInbound : []) {
      addSlackUser(message?.userId, message?.slackIdentity || identityFromSessionMessage(message));
    }
  }

  for (const binding of bindings) {
    const slackUserId = String(binding.slackUserId || "").trim();
    if (!slackUserId) continue;
    rows.set(slackUserId, {
      ...(rows.get(slackUserId) || {
        slackUserId,
        slackIdentity: normalizeSlackIdentity(slackUserId)
      }),
      isDefaultPrAccount: slackUserId === defaultSlackUserId,
      prBinding: {
        state: binding.revokedAt ? "revoked" : "bound",
        githubLogin: binding.githubLogin,
        githubUserId: binding.githubUserId,
        githubEmail: binding.githubEmail ?? null,
        githubName: binding.githubName ?? null,
        scopes: binding.scopes || [],
        createdAt: binding.createdAt,
        updatedAt: binding.updatedAt,
        lastValidatedAt: binding.lastValidatedAt ?? null,
        revokedAt: binding.revokedAt ?? null
      }
    });
  }

  return [...rows.values()].sort((left, right) => {
    if (Boolean(left.isDefaultPrAccount) !== Boolean(right.isDefaultPrAccount)) {
      return left.isDefaultPrAccount ? -1 : 1;
    }
    const leftBound = left.prBinding?.state === "bound";
    const rightBound = right.prBinding?.state === "bound";
    if (leftBound !== rightBound) return leftBound ? -1 : 1;
    return String(left.slackUserId).localeCompare(String(right.slackUserId));
  });
}

function normalizeSlackIdentity(slackUserId: string, identity?: Record<string, any> | null): Record<string, any> {
  return {
    userId: slackUserId,
    mention: `<@${slackUserId}>`,
    ...(identity?.username ? { username: identity.username } : {}),
    ...(identity?.displayName ? { displayName: identity.displayName } : {}),
    ...(identity?.realName ? { realName: identity.realName } : {}),
    ...(identity?.email ? { email: identity.email } : {})
  };
}

function mergeSlackIdentity(previous: Record<string, any> | undefined, next: Record<string, any>): Record<string, any> {
  return {
    ...normalizeSlackIdentity(String(next.userId || previous?.userId || "")),
    ...(previous || {}),
    ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined && value !== null && value !== ""))
  };
}

function identityFromSessionMessage(message: Record<string, any> | null | undefined): Record<string, any> | null {
  if (!message) return null;
  return normalizeSlackIdentity(String(message.userId || ""), {
    ...(message.senderUsername ? { username: message.senderUsername } : {})
  });
}

function githubBindingLabel(binding: Record<string, any>): string {
  if (binding.state === "bound") return "已绑定 " + (binding.githubLogin || "");
  if (binding.state === "revoked") return "绑定失效";
  return "未绑定";
}

function githubBindingTone(binding: Record<string, any>): Tone {
  if (binding.state === "bound") return "good";
  if (binding.state === "revoked") return "danger";
  return "warn";
}

function githubAccountOptionLabel(account: Record<string, any>): string {
  const identity = account.slackIdentity || {};
  const binding = account.prBinding || {};
  const slackLabel = identity.realName || identity.displayName || identity.username || account.slackUserId;
  const githubLabel = binding.githubLogin || "GitHub";
  return String(slackLabel) + " · " + String(githubLabel);
}

function quotaTone(remaining: number): Tone {
  if (remaining < 10) return "danger";
  if (remaining < 30) return "warn";
  return "";
}

function statusTone(status: unknown): Tone {
  const value = String(status || "").toLowerCase();
  if (["succeeded", "running", "active", "ok", "completed", "done"].includes(value)) return "good";
  if (["pending", "inflight", "registered", "starting", "idle", "started", "wait"].includes(value)) return "warn";
  if (["failed", "error", "stopped", "cancelled", "blocked"].includes(value)) return "danger";
  if (["agent_system_prompt", "agent_memory", "agent_runtime_instruction"].includes(value)) return "purple";
  if (value.startsWith("agent_")) return "info";
  if (["deploy", "rollback"].includes(value)) return "info";
  return "";
}

function operationLabel(value: unknown): string {
  const labels: Record<string, string> = {
    deploy: "发布",
    rollback: "回滚",
    auth_profile_add: "添加账号",
    auth_profile_delete: "删除账号",
    github_author_upsert: "保存 GitHub 作者",
    github_author_delete: "删除 GitHub 作者",
    github_pr_default_set: "设置默认 PR 账号"
  };
  return labels[String(value || "")] || String(value || "");
}

function pickOperationLabel(operation: Record<string, any>): string {
  return operation?.request?.version || operation?.request?.ref || operation?.request?.name || operation?.request?.slackUserId || operation?.id || "-";
}

function fmtTime(value: unknown): string {
  if (!value) return "--";
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) return String(value);
  return [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0")
  ].join(":");
}

function fmtDateTime(value: unknown): string {
  if (!value) return "--";
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) return String(value);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-") + " " + fmtTime(value);
}

function shortRevision(value: unknown): string {
  const text = String(value || "").trim();
  return text.length > 12 ? text.slice(0, 12) : text;
}

function formatRelativeDuration(ms: number): string {
  const absMs = Math.abs(ms);
  const minutes = Math.round(absMs / 60_000);
  if (minutes < 60) return minutes + " 分钟";
  const hours = Math.round(absMs / 3_600_000);
  if (hours < 48) return hours + " 小时";
  return Math.round(absMs / 86_400_000) + " 天";
}

function formatResetTime(seconds: unknown): string {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return "未知";
  const delta = value * 1000 - Date.now();
  const relative = formatRelativeDuration(delta);
  return delta > 0 ? relative + "后" : relative + "前";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
