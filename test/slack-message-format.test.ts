import { describe, expect, it } from "vitest";

import {
  formatSlackHistoryContextForCodex,
  formatSlackMessageForCodex
} from "../src/services/slack/slack-message-format.js";

describe("formatSlackMessageForCodex", () => {
  it("includes sender identity and thread metadata", () => {
    const result = formatSlackMessageForCodex(
      {
        source: "thread_reply",
        channelId: "C123",
        channelType: "channel",
        rootThreadTs: "111.222",
        messageTs: "111.223",
        userId: "U123",
        text: "Please fix the flaky test.",
        senderKind: "user",
        mentionedUserIds: ["U456"],
        mentionedUsers: [
          {
            userId: "U456",
            mention: "<@U456>",
            displayName: "claude",
            username: "claude"
          }
        ],
        images: [
          {
            fileId: "F123",
            title: "Screenshot",
            mimetype: "image/png",
            width: 1280,
            height: 720,
            url: "https://example.com/file.png"
          }
        ],
        slackMessage: {
          text: "Please fix the flaky test.",
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "Please fix the flaky test."
              }
            }
          ]
        }
      },
      {
        userId: "U123",
        mention: "<@U123>",
        username: "alice",
        displayName: "Alice",
        realName: "Alice Zhang"
      }
    );

    expect(result).toContain("A new message arrived in the active Slack thread.");
    expect(result).toContain("structured_message_json:");
    expect(result).toContain("\"source\": \"thread_reply\"");
    expect(result).toContain("\"message_ts\": \"111.223\"");
    expect(result).toContain("\"user_id\": \"U123\"");
    expect(result).toContain("\"mention\": \"<@U123>\"");
    expect(result).toContain("Carefully judge whether it requires a reply or action from you.");
    expect(result).toContain("\"display_name\": \"Alice\"");
    expect(result).toContain("\"real_name\": \"Alice Zhang\"");
    expect(result).toContain("\"username\": \"alice\"");
    expect(result).toContain("\"mentioned_user_ids\": [");
    expect(result).toContain("\"U456\"");
    expect(result).toContain("\"mentioned_user_mentions\": [");
    expect(result).toContain("\"<@U456>\"");
    expect(result).toContain("\"mentioned_users\": [");
    expect(result).toContain("\"images\": [");
    expect(result).toContain("\"title\": \"Screenshot\"");
    expect(result).toContain("\"dimensions\": \"1280x720\"");
    expect(result).toContain("\"text\": \"Please fix the flaky test.\"");
    expect(result).not.toContain("\"slack_message\":");
    expect(result).not.toContain("\"slack_card\":");
  });

  it("falls back to ids when profile lookup is unavailable", () => {
    const result = formatSlackMessageForCodex(
      {
        source: "direct_message",
        channelId: "D123",
        rootThreadTs: "222.333",
        userId: "U999",
        senderKind: "user",
        text: "status?"
      },
      null
    );

    expect(result).toContain("\"source\": \"direct_message\"");
    expect(result).toContain("\"user_id\": \"U999\"");
    expect(result).toContain("\"mention\": \"<@U999>\"");
    expect(result).not.toContain("sender_display_name:");
    expect(result).toContain("\"text\": \"status?\"");
  });

  it("prepends earlier thread context when provided", () => {
    const result = formatSlackMessageForCodex(
      {
        source: "app_mention",
        channelId: "C123",
        rootThreadTs: "111.222",
        messageTs: "111.224",
        userId: "U123",
        senderKind: "user",
        text: "What happened before this?",
        contextText: "Earlier Slack thread context before the current message."
      },
      {
        userId: "U123",
        mention: "<@U123>"
      }
    );

    expect(result).toContain("Earlier Slack thread context before the current message.");
    expect(result).toContain("Current Slack message requiring a response:");
    expect(result).toContain("\"source\": \"app_mention\"");
  });

  it("includes resolved mentioned users and readable mention text", () => {
    const result = formatSlackMessageForCodex(
      {
        source: "thread_reply",
        channelId: "C123",
        rootThreadTs: "111.222",
        messageTs: "111.227",
        userId: "U123",
        senderKind: "user",
        text: "<@U456> preview 呢？",
        mentionedUserIds: ["U456"],
        mentionedUsers: [
          {
            userId: "U456",
            mention: "<@U456>",
            displayName: "claude",
            username: "claude"
          }
        ]
      },
      {
        userId: "U123",
        mention: "<@U123>",
        displayName: "Alice"
      }
    );

    expect(result).toContain("\"mentioned_users\": [");
    expect(result).toContain("\"display_name\": \"claude\"");
    expect(result).toContain("\"text_with_resolved_mentions\": \"@claude preview 呢？\"");
  });

  it("renders image-only messages without dropping the body block", () => {
    const result = formatSlackMessageForCodex(
      {
        source: "thread_reply",
        channelId: "C123",
        rootThreadTs: "111.222",
        messageTs: "111.225",
        userId: "U123",
        senderKind: "user",
        text: "",
        images: [
          {
            fileId: "F999",
            name: "paste.png",
            mimetype: "image/png",
            url: "https://example.com/paste.png"
          }
        ]
      },
      null
    );

    expect(result).toContain("\"images\": [");
    expect(result).toContain("\"text\": \"[no text body]\"");
  });

  it("renders recovered missed messages as one chronological batch", () => {
    const result = formatSlackMessageForCodex(
      {
        source: "recovered_thread_batch",
        channelId: "C123",
        rootThreadTs: "111.222",
        messageTs: "111.226",
        userId: "U123",
        text: "",
        recoveryKind: "missed_thread_messages",
        batchMessages: [
          {
            source: "thread_reply",
            messageTs: "111.224",
            userId: "U123",
            senderKind: "user",
            text: "first missed message",
            sender: {
              userId: "U123",
              mention: "<@U123>",
              displayName: "Alice"
            }
          },
          {
            source: "thread_reply",
            messageTs: "111.225",
            userId: "U456",
            senderKind: "user",
            text: "second missed message",
            mentionedUserIds: ["U789"],
            mentionedUsers: [
              {
                userId: "U789",
                mention: "<@U789>",
                displayName: "claude"
              }
            ],
            sender: {
              userId: "U456",
              mention: "<@U456>",
              displayName: "Bob"
            }
          }
        ]
      },
      null
    );

    expect(result).toContain("The broker server restarted or reconnected.");
    expect(result).toContain("recovered_message_batch_json:");
    expect(result).toContain("\"source\": \"recovered_thread_batch\"");
    expect(result).toContain("\"recovery_kind\": \"missed_thread_messages\"");
    expect(result).toContain("\"batch_message_count\": 2");
    expect(result).toContain("\"text\": \"first missed message\"");
    expect(result).toContain("\"text\": \"second missed message\"");
    expect(result).toContain("\"mentioned_user_mentions\": [");
    expect(result).toContain("\"<@U789>\"");
    expect(result).toContain("\"mentioned_users\": [");
  });

  it("renders bot/app card messages with compact Slack card details", () => {
    const result = formatSlackMessageForCodex(
      {
        source: "thread_reply",
        channelId: "C123",
        rootThreadTs: "111.222",
        messageTs: "111.226",
        userId: "bot:B123",
        text: "zanwei.guo@cue.surf created an issue in the Bridge project",
        senderKind: "bot",
        botId: "B123",
        appId: "A123",
        senderUsername: "Linear",
        slackMessage: {
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
      },
      null
    );

    expect(result).toContain("\"kind\": \"bot\"");
    expect(result).toContain("\"bot_id\": \"B123\"");
    expect(result).toContain("\"app_id\": \"A123\"");
    expect(result).toContain("\"username\": \"Linear\"");
    expect(result).toContain("\"slack_card\": {");
    expect(result).toContain("\"attachments\": [");
    expect(result).toContain("CUE-1180 感觉 ai chat webview 帧率很低");
    expect(result).toContain("https://linear.app/surf-cue/issue/CUE-1180");
    expect(result).not.toContain("\"slack_message\":");
  });

  it("renders background job events without pretending they came from a Slack user", () => {
    const result = formatSlackMessageForCodex(
      {
        source: "background_job_event",
        channelId: "C123",
        rootThreadTs: "111.222",
        messageTs: "1741940000000.000001",
        userId: "U_BOT",
        text: "CI turned green.",
        backgroundJob: {
          jobId: "job-1",
          jobKind: "watch_ci",
          eventKind: "state_changed",
          summary: "CI turned green.",
          detailsText: "run_id=123",
          detailsJson: {
            status: "success"
          }
        }
      },
      null
    );

    expect(result).toContain("A broker-managed background job reported a new asynchronous event");
    expect(result).toContain("background_job_event_json:");
    expect(result).toContain("\"source\": \"background_job_event\"");
    expect(result).toContain("\"job_id\": \"job-1\"");
    expect(result).toContain("\"job_kind\": \"watch_ci\"");
    expect(result).toContain("\"event_kind\": \"state_changed\"");
    expect(result).toContain("\"summary\": \"CI turned green.\"");
    expect(result).toContain("Most watcher events do not need a Slack reply.");
    expect(result).toContain("/slack/post-state");
    expect(result).toContain("silent final state");
    expect(result).not.toContain("\"sender\":");
  });

  it("renders unexpected stop nudges as structured broker events", () => {
    const result = formatSlackMessageForCodex(
      {
        source: "unexpected_turn_stop",
        channelId: "C123",
        rootThreadTs: "111.222",
        messageTs: "1741940000000.000002",
        userId: "U_BROKER",
        text: "The previous run ended without an explicit final, block, or wait state.",
        unexpectedTurnStop: {
          turnId: "turn-123",
          reason: "The previous run ended without an explicit final, block, or wait state."
        }
      },
      null
    );

    expect(result).toContain("The previous run for this Slack thread appears to have stopped unexpectedly.");
    expect(result).toContain("unexpected_turn_stop_json:");
    expect(result).toContain("\"source\": \"unexpected_turn_stop\"");
    expect(result).toContain("\"turn_id\": \"turn-123\"");
    expect(result).toContain("kind=block");
    expect(result).toContain("kind=wait");
    expect(result).toContain("/slack/post-state");
    expect(result).toContain("silent block state");
    expect(result).toContain("silent final state");
    expect(result).toContain("Do not send a normal Slack reply and then a second '[block]' or '[wait]' line");
  });
});

describe("formatSlackHistoryContextForCodex", () => {
  it("renders a readable thread history block", () => {
    const result = formatSlackHistoryContextForCodex([
      {
        channelId: "C123",
        channelType: "channel",
        rootThreadTs: "111.222",
        messageTs: "111.220",
        userId: "U234",
        text: "Earlier note",
        senderKind: "user",
        mentionedUserIds: ["U345"],
        images: [
          {
            fileId: "F234",
            title: "Earlier screenshot",
            mimetype: "image/jpeg",
            url: "https://example.com/earlier.jpg"
          }
        ],
        slackMessage: {
          text: "Earlier note"
        },
        sender: {
          userId: "U234",
          mention: "<@U234>",
          displayName: "Bob"
        }
      }
    ]);

    expect(result).toContain("history_count: 1");
    expect(result).toContain("[history 1]");
    expect(result).toContain("\"source\": \"thread_history\"");
    expect(result).toContain("\"mentioned_user_ids\": [");
    expect(result).toContain("\"U345\"");
    expect(result).toContain("\"display_name\": \"Bob\"");
    expect(result).toContain("\"images\": [");
    expect(result).toContain("\"text\": \"Earlier note\"");
    expect(result).not.toContain("\"slack_message\":");
  });
});
