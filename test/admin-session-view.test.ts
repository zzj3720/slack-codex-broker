import { describe, expect, it } from "vitest";

import {
  renderSessionMeta,
  sessionActivityAt,
  shouldShowSessionState
} from "../src/admin-ui/session-row-display.js";
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

  it("shows the Slack payload instead of the broker input wrapper", () => {
    expect(getTimelineEventDisplay({
      type: "agent_input_received",
      title: "用户消息",
      summary: "A newer Slack message arrived while the current turn is still active. Treat it as the latest instruction...",
      metadata: {
        source: "slack_user"
      },
      detail: [
        "A newer Slack message arrived while the current turn is still active.",
        "Treat it as the latest instruction and adjust the ongoing work accordingly.",
        "",
        "Current Slack message requiring a response:",
        "A new message arrived in the active Slack thread. Carefully judge whether it requires a reply or action from you.",
        "structured_message_json:",
        "```json",
        JSON.stringify({
          source: "app_mention",
          message_ts: "1778316208.809479",
          sender: {
            kind: "user",
            user_id: "U123",
            mention: "<@U123>",
            display_name: "Jc"
          },
          text: "<@U0ALY77RMJL> 结合 willow repo，分析图中问题",
          text_with_resolved_mentions: "@codex-3720 结合 willow repo，分析图中问题",
          images: []
        }, null, 2),
        "```"
      ].join("\n")
    })).toEqual({
      badgeLabel: "Slack",
      title: "@codex-3720 结合 willow repo，分析图中问题",
      summary: "Jc · 提及"
    });
  });

  it("shows assistant reply content instead of generic Slack delivery text", () => {
    expect(getTimelineEventDisplay({
      type: "agent_assistant_message",
      title: "Assistant 消息",
      summary: "Replied in Slack.",
      detail: "已经合并并部署，线上健康检查正常。"
    })).toEqual({
      badgeLabel: "Assistant",
      title: "已经合并并部署，线上健康检查正常。",
      summary: ""
    });
  });

  it("does not surface broker English wrappers when no structured payload can be extracted", () => {
    expect(getTimelineEventDisplay({
      type: "agent_input_received",
      title: "用户消息",
      summary: "A newer Slack message arrived while the current turn is still active. Treat it as the latest instruction..."
    })).toEqual({
      badgeLabel: "输入",
      title: "用户消息",
      summary: ""
    });
  });

  it("hides joined-active-turn input delivery rows because they duplicate the input row", () => {
    expect(isTimelineEventVisible({
      type: "agent_input_delivered",
      status: "joined_active_turn",
      title: "输入已送达",
      summary: "进入当前回合"
    })).toBe(false);

    expect(isTimelineEventVisible({
      type: "agent_input_delivered",
      status: "started_turn",
      title: "输入已送达",
      summary: "启动新回合"
    })).toBe(true);
  });

  it("summarizes broker-managed background job input events", () => {
    expect(getTimelineEventDisplay({
      type: "agent_input_received",
      title: "后台任务事件",
      summary: "A broker-managed background job reported a new asynchronous event for this session.",
      metadata: {
        source: "background_job"
      },
      detail: [
        "A broker-managed background job reported a new asynchronous event for this session.",
        "background_job_event_json:",
        "```json",
        JSON.stringify({
          source: "background_job_event",
          message_ts: "1778316208.809479",
          job: {
            job_id: "job-1",
            job_kind: "watch_ci",
            event_kind: "state_changed"
          },
          summary: "CI turned green."
        }, null, 2),
        "```"
      ].join("\n")
    })).toEqual({
      badgeLabel: "后台任务",
      title: "CI turned green.",
      summary: "watch_ci · state_changed · Job job-1"
    });
  });

  it("summarizes unexpected turn stop reminders instead of broker instructions", () => {
    expect(getTimelineEventDisplay({
      type: "agent_input_received",
      title: "Runtime 提醒",
      summary: "The previous run for this Slack thread appears to have stopped unexpectedly.",
      metadata: {
        source: "runtime_reminder"
      },
      detail: [
        "The previous run for this Slack thread appears to have stopped unexpectedly.",
        "unexpected_turn_stop_json:",
        "```json",
        JSON.stringify({
          source: "unexpected_turn_stop",
          message_ts: "1778316208.809479",
          previous_turn: {
            turn_id: "turn-1"
          },
          reason: "The previous run ended without an explicit final, block, or wait state."
        }, null, 2),
        "```"
      ].join("\n")
    })).toEqual({
      badgeLabel: "提醒",
      title: "回合异常停止",
      summary: "The previous run ended without an explicit final, block, or wait state."
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

describe("admin session row display", () => {
  it("keeps common session list metadata out of the row", () => {
    const authProfiles = new Map<string, Record<string, any>>([
      ["profile-a", {
        name: "profile-a",
        account: {
          ok: true,
          account: {
            email: "hejiachen@toeverything.info",
            planType: "prolite"
          }
        },
        rateLimits: {
          ok: true,
          rateLimits: {
            primary: {
              usedPercent: 4
            },
            secondary: {
              usedPercent: 36
            }
          }
        }
      }]
    ]);
    const meta = renderSessionMeta({
      key: "C123:111.222",
      channelId: "C123",
      channelLabel: "C123",
      authProfileName: "profile-a",
      firstUserMessage: {
        textPreview: "@codex-3720 你好"
      },
      lastUserMessage: {
        textPreview: "后面 GPT 改了点"
      },
      usage: {
        turnCount: 3,
        totalTokens: 5120
      },
      backgroundJobCount: 0,
      updatedAt: new Date().toISOString()
    }, authProfiles, new Map([["C123", "#ops"]]));
    const labels = meta.map((item) => item.label);

    expect(labels).toEqual(["#ops", "周 64%", "Token 5.1K"]);
    expect(labels.join(" ")).not.toContain("hejiachen@toeverything.info");
    expect(labels.join(" ")).not.toContain("Pro Lite");
    expect(shouldShowSessionState({ rank: 10 })).toBe(false);
  });

  it("only shows job count when jobs exist and keeps distinct states visible", () => {
    const meta = renderSessionMeta({
      key: "C123:111.222",
      channelId: "C123",
      channelName: "deep-review",
      firstUserMessage: {
        textPreview: "看一下"
      },
      lastUserMessage: {
        textPreview: "看一下"
      },
      openHumanInboundCount: 1,
      openInboundCount: 1,
      usage: {
        turnCount: 1,
        totalTokens: 1725
      },
      backgroundJobCount: 2,
      runningBackgroundJobCount: 1,
      updatedAt: new Date().toISOString()
    }, new Map());
    const labels = meta.map((item) => item.label);

    expect(labels).toContain("#deep-review");
    expect(labels).toContain("Jobs 2");
    expect(shouldShowSessionState({ rank: 50 })).toBe(true);
  });

  it("uses semantic session activity time instead of metadata updatedAt", () => {
    expect(sessionActivityAt({
      key: "C123:111.222",
      createdAt: "2026-03-18T00:00:00.000Z",
      updatedAt: "2026-05-10T00:00:00.000Z",
      lastActivityAt: "2026-03-19T00:00:00.000Z",
      usage: {
        lastTurnAt: "2026-03-19T00:00:00.000Z"
      }
    })).toBe("2026-03-19T00:00:00.000Z");
  });
});
