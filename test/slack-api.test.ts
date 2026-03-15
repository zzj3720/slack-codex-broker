import { afterEach, describe, expect, it, vi } from "vitest";

import {
  normalizeSlackImageAttachments,
  SlackApi
} from "../src/services/slack/slack-api.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("normalizeSlackImageAttachments", () => {
  it("extracts image metadata and prefers thumbnail URLs", () => {
    const images = normalizeSlackImageAttachments([
      {
        id: "F123",
        name: "screenshot.png",
        title: "Screenshot",
        mimetype: "image/png",
        thumb_1024: "https://example.com/thumb-1024.png",
        url_private_download: "https://example.com/original.png",
        original_w: 1600,
        original_h: 900
      }
    ]);

    expect(images).toEqual([
      {
        fileId: "F123",
        name: "screenshot.png",
        title: "Screenshot",
        mimetype: "image/png",
        width: 1600,
        height: 900,
        url: "https://example.com/thumb-1024.png"
      }
    ]);
  });

  it("ignores non-image files and malformed entries", () => {
    const images = normalizeSlackImageAttachments([
      null,
      {
        id: "F234",
        mimetype: "application/pdf",
        url_private_download: "https://example.com/file.pdf"
      },
      {
        id: "F345",
        mimetype: "image/jpeg"
      }
    ]);

    expect(images).toEqual([]);
  });
});

describe("SlackApi.uploadThreadFile", () => {
  it("uses Slack external upload flow and returns file metadata", async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith("/files.getUploadURLExternal")) {
        expect(init?.method).toBe("POST");
        expect(String(init?.body)).toContain("filename=report.txt");
        expect(String(init?.body)).toContain("length=11");
        return new Response(
          JSON.stringify({
            ok: true,
            upload_url: "https://uploads.slack.test/upload/abc",
            file_id: "F123"
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }

      if (url === "https://uploads.slack.test/upload/abc") {
        expect(init?.method).toBe("POST");
        expect(init?.headers).toMatchObject({
          "content-type": "text/plain"
        });
        expect(Buffer.from((init?.body as Buffer) ?? []).toString("utf8")).toBe("hello world");
        return new Response("ok", { status: 200 });
      }

      if (url.endsWith("/files.completeUploadExternal")) {
        expect(init?.method).toBe("POST");
        const body = String(init?.body);
        expect(body).toContain("channel_id=C123");
        expect(body).toContain("thread_ts=111.222");
        expect(body).toContain("initial_comment=upload+done");
        const params = new URLSearchParams(body);
        expect(params.get("files")).toBe(JSON.stringify([{ id: "F123", title: "Build report" }]));
        return new Response(
          JSON.stringify({
            ok: true,
            files: [
              {
                id: "F123",
                title: "Build report",
                name: "report.txt",
                mimetype: "text/plain",
                permalink: "https://slack.test/files/F123",
                url_private: "https://slack.test/private/F123",
                url_private_download: "https://slack.test/private/F123/download",
                size: 11
              }
            ]
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }

      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const api = new SlackApi({
      baseUrl: "https://slack.test/api",
      appToken: "xapp-test",
      botToken: "xoxb-test"
    });

    const result = await api.uploadThreadFile({
      channelId: "C123",
      threadTs: "111.222",
      filename: "report.txt",
      bytes: Buffer.from("hello world"),
      title: "Build report",
      initialComment: "upload done",
      contentType: "text/plain"
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      fileId: "F123",
      title: "Build report",
      name: "report.txt",
      mimetype: "text/plain",
      permalink: "https://slack.test/files/F123",
      privateUrl: "https://slack.test/private/F123",
      downloadUrl: "https://slack.test/private/F123/download",
      size: 11
    });
  });
});

describe("SlackApi.listThreadMessages", () => {
  it("preserves bot/app card messages with raw Slack payload", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);

      if (!url.endsWith("/conversations.replies")) {
        throw new Error(`Unexpected fetch ${url}`);
      }

      return new Response(
        JSON.stringify({
          ok: true,
          messages: [
            {
              ts: "111.222",
              subtype: "bot_message",
              bot_id: "B123",
              app_id: "A123",
              username: "Linear",
              text: "zanwei.guo@cue.surf created an issue in the Bridge project",
              attachments: [
                {
                  title: "CUE-1180 感觉 ai chat webview 帧率很低",
                  title_link: "https://linear.app/surf-cue/issue/CUE-1180"
                }
              ]
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const api = new SlackApi({
      baseUrl: "https://slack.test/api",
      appToken: "xapp-test",
      botToken: "xoxb-test"
    });

    const messages = await api.listThreadMessages({
      channelId: "C123",
      rootThreadTs: "111.111",
      channelType: "channel"
    });

    expect(messages).toEqual([
      {
        channelId: "C123",
        channelType: "channel",
        rootThreadTs: "111.111",
        messageTs: "111.222",
        userId: "bot:B123",
        text: "zanwei.guo@cue.surf created an issue in the Bridge project",
        senderKind: "bot",
        botId: "B123",
        appId: "A123",
        senderUsername: "Linear",
        images: [],
        slackMessage: {
          ts: "111.222",
          subtype: "bot_message",
          bot_id: "B123",
          app_id: "A123",
          username: "Linear",
          text: "zanwei.guo@cue.surf created an issue in the Bridge project",
          attachments: [
            {
              title: "CUE-1180 感觉 ai chat webview 帧率很低",
              title_link: "https://linear.app/surf-cue/issue/CUE-1180"
            }
          ]
        }
      }
    ]);
  });
});
