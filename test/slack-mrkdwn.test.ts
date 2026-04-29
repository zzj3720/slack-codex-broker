import { describe, expect, it } from "vitest";

import {
  markdownishToMrkdwn,
  markdownToMrkdwn,
  markdownToSlackFallbackText
} from "../src/services/slack/slack-mrkdwn.js";

describe("markdownToMrkdwn", () => {
  const cases = [
    {
      name: "bold and links",
      input: "Use **bold** and [docs](https://example.com).",
      expected: "Use *bold* and <https://example.com|docs>."
    },
    {
      name: "headers and lists",
      input: "## Summary\n- first\n2. second",
      expected: "*Summary*\n• first\n2. second"
    },
    {
      name: "ordered list preserves numbering",
      input: "1. first\n2. second\n10. tenth",
      expected: "1. first\n2. second\n10. tenth"
    },
    {
      name: "strikethrough and hr",
      input: "before\n---\n~~done~~",
      expected: "before\n———\n~done~"
    },
    {
      name: "tables become bullets",
      input: "| Name | Status |\n| --- | --- |\n| Alice | Done |",
      expected: "• *Name*: Alice  ·  *Status*: Done"
    },
    {
      name: "code is preserved and autolink-safe",
      input: "Use `ghcr.io/afk-surf/unbox` and ```go\nfunc **main**() {}\n``` after **bold**",
      expected: "Use `ghcr.\u200Bio/afk-surf/unbox` and ```go\nfunc **main**() {}\n``` after *bold*"
    },
    {
      name: "single asterisk becomes italic",
      input: "this is *italic* text",
      expected: "this is _italic_ text"
    },
    {
      name: "bold can wrap inline code",
      input: "• **bridge-staging 那边的 `linear-cli`** — 需要确认是哪个版本",
      expected: "• *bridge-staging 那边的 `linear-cli`* — 需要确认是哪个版本"
    },
    {
      name: "inline code URL is protected without broken autolink",
      input: "去 `https://linear.app/settings/api` 创建一个可供我使用的 API key",
      expected: "去 `https://linear.\u200Bapp/settings/api` 创建一个可供我使用的 API key"
    },
    {
      name: "inline code email is protected without autolink",
      input: "我的邮箱是：`06ek3ybnehw4vb7zaz1damtae8@a-staging.bridge.surf`",
      expected: "我的邮箱是：`06ek3ybnehw4vb7zaz1damtae8@\u200Ba-staging.bridge.surf`"
    },
    {
      name: "inline code unwraps slack bare autolink before protecting",
      input: "`<https://example.com/a/b>`",
      expected: "`https://example.\u200Bcom/a/b`"
    },
    {
      name: "inline code unwraps slack mailto autolink before protecting",
      input: "`<mailto:name@example.com|name@example.com>`",
      expected: "`name@\u200Bexample.com`"
    },
    {
      name: "markdown link strips slack angle wrapped target",
      input: "[OpenAI](<https://openai.com>)",
      expected: "<https://openai.com|OpenAI>"
    },
    {
      name: "local file paths become clickable file links",
      input: "文件在你电脑桌面：/Users/enther/Desktop/proactive-agent-industry-deck.html，直接打开。",
      expected:
        "文件在你电脑桌面：<file:///Users/enther/Desktop/proactive-agent-industry-deck.html|/Users/enther/Desktop/proactive-agent-industry-deck.html>，直接打开。"
    },
    {
      name: "markdown links can target local file paths",
      input: "[打开 HTML](/Users/enther/Desktop/proactive agent deck.html)",
      expected:
        "<file:///Users/enther/Desktop/proactive%20agent%20deck.html|打开 HTML>"
    },
    {
      name: "inline-code local file path becomes a clickable file link",
      input: "文件在：`/Users/enther/Desktop/proactive-agent-industry-deck.html`",
      expected:
        "文件在：<file:///Users/enther/Desktop/proactive-agent-industry-deck.html|/Users/enther/Desktop/proactive-agent-industry-deck.html>"
    },
    {
      name: "code-fenced local file path becomes a clickable file link",
      input: "文件在：\n```\n/Users/enther/Desktop/proactive-agent-industry-deck.html\n```",
      expected:
        "文件在：\n<file:///Users/enther/Desktop/proactive-agent-industry-deck.html|/Users/enther/Desktop/proactive-agent-industry-deck.html>"
    }
  ] as const;

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(markdownToMrkdwn(testCase.input)).toBe(testCase.expected);
    });
  }
});

describe("markdownishToMrkdwn", () => {
  const cases = [
    {
      name: "preserves slack bold while converting markdown links",
      input: ":calendar: *Weekly Sync*\n[Open doc](https://example.com/doc)",
      expected: ":calendar: *Weekly Sync*\n<https://example.com/doc|Open doc>"
    },
    {
      name: "converts markdown bold and ordered list",
      input: "<@U123> **Please check** this:\n1. [Spec](https://example.com/spec)\n2. ~~Old note~~",
      expected: "<@U123> *Please check* this:\n1. <https://example.com/spec|Spec>\n2. ~Old note~"
    },
    {
      name: "preserves inline code and mrkdwn links",
      input: "Use `rg \"foo\"` and see <https://example.com|existing link>.",
      expected: "Use `rg \"foo\"` and see <https://example.com|existing link>."
    }
  ] as const;

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(markdownishToMrkdwn(testCase.input)).toBe(testCase.expected);
    });
  }
});

describe("markdownToSlackFallbackText", () => {
  it("returns converted fallback text when markdown produces mrkdwn", () => {
    expect(markdownToSlackFallbackText("See **status** in [Linear](https://linear.app).")).toBe(
      "See *status* in <https://linear.app|Linear>."
    );
  });

  it("returns original text for blank output", () => {
    expect(markdownToSlackFallbackText("   ")).toBe("   ");
  });
});
