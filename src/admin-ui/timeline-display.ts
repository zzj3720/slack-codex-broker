export type TimelineEvent = Record<string, any>;

export type TimelineEventDisplay = {
  readonly badgeLabel: string;
  readonly title: string;
  readonly summary: string;
};

export function getTimelineEventDisplay(event: TimelineEvent): TimelineEventDisplay {
  const type = String(event.type || "").toLowerCase();
  const rawTitle = nonEmptyString(event.title) || statusLabel(type || event.status || "event");
  const rawSummary = nonEmptyString(event.summary);
  const badgeLabel = timelineCategoryLabel(type, event);

  switch (type) {
    case "agent_input_delivered":
    case "agent_turn_started":
    case "agent_turn_completed":
    case "agent_token_count":
    case "inbound_message":
    case "turn_signal":
      if (rawSummary) return { badgeLabel, title: rawSummary, summary: "" };
      break;
    case "agent_tool_call":
    case "agent_tool_result": {
      const title = nonEmptyString(event.toolName) || rawSummary || rawTitle;
      const summary = title === rawSummary ? "" : (rawSummary || "");
      return { badgeLabel, title, summary };
    }
    default:
      break;
  }

  if (isRedundantTimelineTitle(rawTitle, badgeLabel) && rawSummary) {
    return { badgeLabel, title: rawSummary, summary: "" };
  }

  return { badgeLabel, title: rawTitle, summary: rawSummary || "" };
}

function timelineCategoryLabel(type: string, event: TimelineEvent): string {
  const labels: Record<string, string> = {
    agent_input_received: "输入",
    agent_input_delivered: "输入",
    agent_turn_started: "回合",
    agent_turn_completed: "回合",
    agent_token_count: "Token",
    inbound_message: "Slack",
    agent_assistant_message: "Assistant",
    agent_user_message: "用户",
    agent_tool_call: "工具",
    agent_tool_result: "工具",
    agent_system_prompt: "System",
    agent_memory: "记忆",
    agent_runtime_reminder: "提醒",
    agent_runtime_instruction: "Runtime",
    agent_runtime_error: "Runtime",
    agent_session_resumed: "Session",
    session_created: "会话",
    turn_signal: "回合",
    background_job: "Job"
  };
  return labels[type] || statusLabel(type || event.status || "event");
}

function isRedundantTimelineTitle(title: string, badgeLabel: string): boolean {
  const normalizedTitle = normalizeTimelineText(title);
  const normalizedBadge = normalizeTimelineText(badgeLabel);
  return Boolean(
    normalizedTitle &&
    normalizedBadge &&
    (normalizedTitle === normalizedBadge ||
      normalizedTitle.startsWith(normalizedBadge) ||
      normalizedBadge.startsWith(normalizedTitle))
  );
}

function normalizeTimelineText(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s_:/|·-]+/g, "")
    .replace(/消息|用量|事件|信号|调用|结果|开始|结束/g, "");
}

function nonEmptyString(value: unknown): string {
  return String(value || "").trim();
}

export function statusLabel(value: unknown): string {
  const labels: Record<string, string> = {
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
  return labels[String(value || "").toLowerCase()] || String(value || "");
}
