import { describe, it, expect } from "vitest";
import { ChannelType, MessageType, type MentionPayload, type BotMessage } from "./types.js";

/**
 * Tests for mention.all detection logic.
 *
 * The API can return mention.all as either:
 * - boolean `true` (newer API versions)
 * - number `1` (older API versions / WuKongIM native format)
 *
 * Both should be treated as "mention all".
 */
describe("mention.all detection", () => {
  // Helper to simulate the detection logic from inbound.ts
  function isMentionAll(mention?: MentionPayload): boolean {
    const mentionAllRaw = mention?.all;
    return mentionAllRaw === true || mentionAllRaw === 1;
  }

  it("should detect mention.all when all is boolean true", () => {
    const mention: MentionPayload = { all: true };
    expect(isMentionAll(mention)).toBe(true);
  });

  it("should detect mention.all when all is numeric 1", () => {
    const mention: MentionPayload = { all: 1 };
    expect(isMentionAll(mention)).toBe(true);
  });

  it("should NOT detect mention.all when all is false", () => {
    const mention: MentionPayload = { all: false as unknown as boolean | number };
    expect(isMentionAll(mention)).toBe(false);
  });

  it("should NOT detect mention.all when all is 0", () => {
    const mention: MentionPayload = { all: 0 };
    expect(isMentionAll(mention)).toBe(false);
  });

  it("should NOT detect mention.all when all is undefined", () => {
    const mention: MentionPayload = { uids: ["user1"] };
    expect(isMentionAll(mention)).toBe(false);
  });

  it("should NOT detect mention.all when mention is undefined", () => {
    expect(isMentionAll(undefined)).toBe(false);
  });

  it("should NOT detect mention.all when all is a different number", () => {
    const mention: MentionPayload = { all: 2 };
    expect(isMentionAll(mention)).toBe(false);
  });
});

/**
 * Tests for channel_type detection logic (isGroup determination).
 *
 * The channel_type can come as either:
 * - number `2` (native SDK format)
 * - string `"2"` (JSON serialization or older SDK versions)
 *
 * Both should be treated as ChannelType.Group.
 *
 * Bug: #13 - 纯人类成员无法创建群聊 (pure human members cannot create group chat)
 * Root cause: strict equality (===) fails for string "2" vs number 2
 */
describe("channel_type detection (isGroup)", () => {
  // Helper to simulate the detection logic from inbound.ts
  function isGroupMessage(message: Partial<BotMessage>): boolean {
    const channelType = Number(message.channel_type);
    return (
      typeof message.channel_id === "string" &&
      message.channel_id.length > 0 &&
      channelType === ChannelType.Group
    );
  }

  it("should detect group when channel_type is number 2", () => {
    const message: Partial<BotMessage> = {
      channel_id: "group123",
      channel_type: ChannelType.Group, // 2
    };
    expect(isGroupMessage(message)).toBe(true);
  });

  it("should detect group when channel_type is string '2'", () => {
    const message: Partial<BotMessage> = {
      channel_id: "group123",
      channel_type: "2" as unknown as ChannelType, // string from SDK
    };
    expect(isGroupMessage(message)).toBe(true);
  });

  it("should NOT detect group when channel_type is DM (number 1)", () => {
    const message: Partial<BotMessage> = {
      channel_id: "user123",
      channel_type: ChannelType.DM, // 1
    };
    expect(isGroupMessage(message)).toBe(false);
  });

  it("should NOT detect group when channel_type is DM (string '1')", () => {
    const message: Partial<BotMessage> = {
      channel_id: "user123",
      channel_type: "1" as unknown as ChannelType, // string from SDK
    };
    expect(isGroupMessage(message)).toBe(false);
  });

  it("should NOT detect group when channel_id is empty", () => {
    const message: Partial<BotMessage> = {
      channel_id: "",
      channel_type: ChannelType.Group,
    };
    expect(isGroupMessage(message)).toBe(false);
  });

  it("should NOT detect group when channel_id is undefined", () => {
    const message: Partial<BotMessage> = {
      channel_type: ChannelType.Group,
    };
    expect(isGroupMessage(message)).toBe(false);
  });

  it("should NOT detect group when channel_type is undefined", () => {
    const message: Partial<BotMessage> = {
      channel_id: "group123",
    };
    expect(isGroupMessage(message)).toBe(false);
  });

  it("should handle channel_type as 0 (falsy but valid)", () => {
    const message: Partial<BotMessage> = {
      channel_id: "channel123",
      channel_type: 0 as unknown as ChannelType,
    };
    expect(isGroupMessage(message)).toBe(false);
  });
});
