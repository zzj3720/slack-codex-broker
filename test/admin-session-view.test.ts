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
      status: "running",
      toolName: "exec_command",
      detail: JSON.stringify({
        command: "/bin/zsh -lc \"cd /tmp/workspace/cueboard && pnpm test\"",
        cwd: "/tmp/workspace",
        commandActions: [
          {
            type: "test",
            name: "unit"
          }
        ]
      })
    })).toEqual({
      badgeLabel: "命令",
      title: "pnpm test",
      summary: "测试 unit · cwd cueboard · 运行中"
    });
  });

  it("shows command result output instead of repeating exec_command", () => {
    expect(getTimelineEventDisplay({
      type: "agent_tool_result",
      title: "工具结果",
      summary: "exec_command",
      status: "completed",
      toolName: "exec_command",
      detail: JSON.stringify({
        command: "/bin/zsh -lc \"cd /tmp/workspace/cueboard && rg -n \\\"bridge\\\" src | sed -n '1,20p'\"",
        cwd: "/tmp/workspace",
        exitCode: 0,
        durationMs: 1240,
        aggregatedOutput: "src/index.ts:12: bridge config\nsrc/app.ts:5: bridge app"
      })
    })).toEqual({
      badgeLabel: "命令",
      title: "rg -n \"bridge\" src | sed -n '1,20p'",
      summary: "exit 0 · 1.2s · 输出 src/index.ts:12: bridge config"
    });
  });

  it("can recover command summaries from truncated detail text", () => {
    expect(getTimelineEventDisplay({
      type: "agent_tool_result",
      title: "工具结果",
      summary: "exec_command",
      status: "completed",
      toolName: "exec_command",
      detailTruncated: true,
      detail: [
        "{",
        "  \"command\": \"/bin/zsh -lc \\\"cd /tmp/workspace/cueboard && pnpm build\\\"\",",
        "  \"cwd\": \"/tmp/workspace\",",
        "  \"exitCode\": 0,",
        "  \"durationMs\": 980,",
        "  \"aggregatedOutput\": \"dist/admin-ui/assets/admin-ui.js 250 kB\""
      ].join("\n")
    })).toEqual({
      badgeLabel: "命令",
      title: "pnpm build",
      summary: "exit 0 · 980ms · 输出 dist/admin-ui/assets/admin-ui.js 250 kB"
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
