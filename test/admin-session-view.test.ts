import { describe, expect, it } from "vitest";

import { getTimelineEventDisplay, isTimelineEventVisible } from "../src/admin-ui/timeline-display.js";

describe("admin session timeline display", () => {
  it("uses category badges instead of duplicating the event title", () => {
    expect(getTimelineEventDisplay({
      type: "agent_turn_started",
      title: "回合开始",
      summary: "开始处理输入"
    })).toEqual({
      badgeLabel: "回合",
      title: "开始处理输入",
      summary: ""
    });

    expect(getTimelineEventDisplay({
      type: "inbound_message",
      title: "Slack 消息",
      summary: "<@U0ALY77RMJL> 你好"
    })).toEqual({
      badgeLabel: "Slack",
      title: "<@U0ALY77RMJL> 你好",
      summary: ""
    });
  });

  it("keeps distinct titles and summaries when they carry different information", () => {
    expect(getTimelineEventDisplay({
      type: "agent_input_received",
      title: "用户消息",
      summary: "A new message arrived"
    })).toEqual({
      badgeLabel: "输入",
      title: "用户消息",
      summary: "A new message arrived"
    });

    expect(getTimelineEventDisplay({
      type: "agent_tool_call",
      title: "工具调用",
      summary: "exec_command",
      toolName: "exec_command"
    })).toEqual({
      badgeLabel: "工具",
      title: "exec_command",
      summary: ""
    });
  });

  it("does not treat token usage records as visible timeline activity", () => {
    expect(isTimelineEventVisible({
      type: "agent_token_count",
      title: "Token 用量",
      summary: "14784 tokens"
    })).toBe(false);

    expect(isTimelineEventVisible({
      type: "agent_tool_call",
      title: "工具调用",
      summary: "exec_command"
    })).toBe(true);
  });
});
