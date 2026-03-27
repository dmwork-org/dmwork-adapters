import { describe, it, expect } from "vitest";
import {
  parseMentions,
  extractMentionMatches,
  MENTION_PATTERN,
  STRUCTURED_MENTION_PATTERN,
  parseStructuredMentions,
  convertStructuredMentions,
  buildEntitiesFromFallback,
  extractMentionUids,
  convertContentForLLM,
} from "./mention-utils.js";
import type { MentionEntity, MentionPayload } from "./types.js";

// ── Existing tests (updated for new MENTION_PATTERN with lookbehind) ──

describe("parseMentions", () => {
  it("should parse English alphanumeric mentions", () => {
    const result = parseMentions("Hello @user123 and @test_user!");
    expect(result).toEqual(["user123", "test_user"]);
  });

  it("should parse Chinese character mentions", () => {
    const result = parseMentions("你好 @陈皮皮 请回复");
    expect(result).toEqual(["陈皮皮"]);
  });

  it("should parse mixed Chinese and English mentions", () => {
    const result = parseMentions("@陈皮皮 @bob_123 @托马斯");
    expect(result).toEqual(["陈皮皮", "bob_123", "托马斯"]);
  });

  it("should parse mentions with dots", () => {
    const result = parseMentions("Hi @thomas.ford how are you?");
    expect(result).toEqual(["thomas.ford"]);
  });

  it("should parse mentions with hyphens", () => {
    const result = parseMentions("CC @user-name please");
    expect(result).toEqual(["user-name"]);
  });

  it("should parse complex mixed mentions", () => {
    const result = parseMentions("@陈皮皮_test @user.name-123 @普通用户");
    expect(result).toEqual(["陈皮皮_test", "user.name-123", "普通用户"]);
  });

  it("should return empty array for no mentions", () => {
    const result = parseMentions("Hello world! No mentions here.");
    expect(result).toEqual([]);
  });

  it("should handle @all-like patterns", () => {
    const result = parseMentions("@all please check @everyone");
    expect(result).toEqual(["all", "everyone"]);
  });

  it("should handle mentions at start and end", () => {
    const result = parseMentions("@start middle @end");
    expect(result).toEqual(["start", "end"]);
  });
});

describe("extractMentionMatches", () => {
  it("should return matches with @ prefix", () => {
    const result = extractMentionMatches("Hello @陈皮皮 and @bob!");
    expect(result).toEqual(["@陈皮皮", "@bob"]);
  });

  it("should return empty array for no mentions", () => {
    const result = extractMentionMatches("No mentions");
    expect(result).toEqual([]);
  });
});

describe("MENTION_PATTERN", () => {
  it("should be a valid regex", () => {
    expect(MENTION_PATTERN).toBeInstanceOf(RegExp);
  });

  it("should have global flag", () => {
    expect(MENTION_PATTERN.flags).toContain("g");
  });

  it("should match Chinese characters (CJK range)", () => {
    const result = parseMentions("@中文名字");
    expect(result).toEqual(["中文名字"]);
  });

  it("should match underscores", () => {
    const result = parseMentions("@user_name_123");
    expect(result).toEqual(["user_name_123"]);
  });
});

// ── New tests: MENTION_PATTERN Unicode extension ──

describe("MENTION_PATTERN Unicode extension", () => {
  it("should match accented Latin characters", () => {
    const result = parseMentions("Hi @José and @André");
    expect(result).toEqual(["José", "André"]);
  });

  it("should match Japanese kana", () => {
    const result = parseMentions("@たなか さんへ");
    expect(result).toEqual(["たなか"]);
  });

  it("should match Korean syllables", () => {
    const result = parseMentions("안녕 @김철수 님");
    expect(result).toEqual(["김철수"]);
  });

  it("should exclude email-like @ patterns", () => {
    // lookbehind excludes user@domain (r is alphanumeric)
    const result = parseMentions("Send to user@company.com");
    expect(result).toEqual([]);
  });

  it("should match @mention at start of line", () => {
    const result = parseMentions("@陈皮皮 你好");
    expect(result).toEqual(["陈皮皮"]);
  });

  it("should match @mention after whitespace", () => {
    const result = parseMentions("你好 @Bob 请看");
    expect(result).toEqual(["Bob"]);
  });
});

// ── parseStructuredMentions ──

describe("parseStructuredMentions", () => {
  it("should parse @[uid:name] format", () => {
    const text = "Hi @[uid_bob:Bob] and @[uid_chen:陈皮皮]";
    const result = parseStructuredMentions(text);
    expect(result).toEqual([
      { uid: "uid_bob", name: "Bob", offset: 3, length: 14 },
      { uid: "uid_chen", name: "陈皮皮", offset: 22, length: 15 },
    ]);
    // Verify substring
    expect(text.substring(3, 3 + 14)).toBe("@[uid_bob:Bob]");
    expect(text.substring(22, 22 + 15)).toBe("@[uid_chen:陈皮皮]");
  });

  it("should handle uid with dots and hyphens", () => {
    const text = "@[thomas.ford-1:Thomas Ford]";
    const result = parseStructuredMentions(text);
    expect(result).toEqual([
      {
        uid: "thomas.ford-1",
        name: "Thomas Ford",
        offset: 0,
        length: 28,
      },
    ]);
  });

  it("should handle 32-char hex uid", () => {
    const text = "@[11be65096f214886b69ef9d8fcfa5c55:张三]";
    const result = parseStructuredMentions(text);
    expect(result).toHaveLength(1);
    expect(result[0].uid).toBe("11be65096f214886b69ef9d8fcfa5c55");
    expect(result[0].name).toBe("张三");
    expect(result[0].offset).toBe(0);
    expect(result[0].length).toBe(38);
  });

  it("should return empty array when no matches", () => {
    const result = parseStructuredMentions("Hello @Bob no structured");
    expect(result).toEqual([]);
  });

  it("should not match newline in name", () => {
    const result = parseStructuredMentions("@[uid:name\nmore]");
    expect(result).toEqual([]);
  });
});

// ── convertStructuredMentions ──

describe("convertStructuredMentions", () => {
  it("should convert single mention correctly", () => {
    const text = "Hi @[uid_bob:Bob]!";
    const mentions = parseStructuredMentions(text);
    const validUids = new Set(["uid_bob"]);
    const result = convertStructuredMentions(text, mentions, validUids);

    expect(result.content).toBe("Hi @Bob!");
    expect(result.entities).toEqual([
      { uid: "uid_bob", offset: 3, length: 4 },
    ]);
    expect(result.uids).toEqual(["uid_bob"]);
    // Verify offset/length via substring
    expect(result.content.substring(3, 7)).toBe("@Bob");
  });

  it("should handle multiple mentions", () => {
    const text = "@[uid_a:Alice] and @[uid_b:Bob]";
    const mentions = parseStructuredMentions(text);
    const validUids = new Set(["uid_a", "uid_b"]);
    const result = convertStructuredMentions(text, mentions, validUids);

    expect(result.content).toBe("@Alice and @Bob");
    expect(result.entities).toHaveLength(2);
    expect(result.entities[0]).toEqual({ uid: "uid_a", offset: 0, length: 6 });
    expect(result.entities[1]).toEqual({ uid: "uid_b", offset: 11, length: 4 });
    expect(result.content.substring(0, 6)).toBe("@Alice");
    expect(result.content.substring(11, 15)).toBe("@Bob");
  });

  it("should handle invalid uid (keep @name text but exclude from entities)", () => {
    const text = "@[fake:Bob] and @[uid_bob:Bob]";
    const mentions = parseStructuredMentions(text);
    const validUids = new Set(["uid_bob"]);
    const result = convertStructuredMentions(text, mentions, validUids);

    expect(result.content).toBe("@Bob and @Bob");
    expect(result.entities).toEqual([
      { uid: "uid_bob", offset: 9, length: 4 },
    ]);
    // Verify correct @Bob is bound (second one)
    expect(result.content.substring(9, 13)).toBe("@Bob");
  });

  it("should handle Chinese usernames with correct offsets", () => {
    const text = "你好 @[uid_chen:陈皮皮] 和 @[uid_bob:Bob]";
    const mentions = parseStructuredMentions(text);
    const validUids = new Set(["uid_chen", "uid_bob"]);
    const result = convertStructuredMentions(text, mentions, validUids);

    expect(result.content).toBe("你好 @陈皮皮 和 @Bob");
    expect(result.entities).toHaveLength(2);
    expect(result.entities[0]).toEqual({ uid: "uid_chen", offset: 3, length: 4 });
    expect(result.entities[1]).toEqual({ uid: "uid_bob", offset: 10, length: 4 });
    expect(result.content.substring(3, 7)).toBe("@陈皮皮");
    expect(result.content.substring(10, 14)).toBe("@Bob");
  });

  it("should handle same name different uid (incremental build)", () => {
    const text = "@[uid_a:Bob] and @[uid_b:Bob]";
    const mentions = parseStructuredMentions(text);
    const validUids = new Set(["uid_a", "uid_b"]);
    const result = convertStructuredMentions(text, mentions, validUids);

    expect(result.content).toBe("@Bob and @Bob");
    expect(result.entities).toHaveLength(2);
    expect(result.entities[0]).toEqual({ uid: "uid_a", offset: 0, length: 4 });
    expect(result.entities[1]).toEqual({ uid: "uid_b", offset: 9, length: 4 });
    expect(result.content.substring(0, 4)).toBe("@Bob");
    expect(result.content.substring(9, 13)).toBe("@Bob");
  });
});

// ── buildEntitiesFromFallback ──

describe("buildEntitiesFromFallback", () => {
  it("should resolve @name from memberMap", () => {
    const memberMap = new Map([
      ["陈皮皮", "uid_chen"],
      ["Bob", "uid_bob"],
    ]);
    const content = "你好 @陈皮皮 和 @Bob";
    const { entities, uids } = buildEntitiesFromFallback(content, memberMap);

    expect(uids).toEqual(["uid_chen", "uid_bob"]);
    expect(entities).toHaveLength(2);
    expect(entities[0]).toEqual({ uid: "uid_chen", offset: 3, length: 4 });
    expect(entities[1]).toEqual({ uid: "uid_bob", offset: 10, length: 4 });
    // Verify via substring
    expect(content.substring(3, 7)).toBe("@陈皮皮");
    expect(content.substring(10, 14)).toBe("@Bob");
  });

  it("should skip names not in memberMap", () => {
    const memberMap = new Map([["Bob", "uid_bob"]]);
    const content = "@Unknown @Bob";
    const { entities, uids } = buildEntitiesFromFallback(content, memberMap);

    expect(uids).toEqual(["uid_bob"]);
    expect(entities).toHaveLength(1);
    expect(entities[0]).toEqual({ uid: "uid_bob", offset: 9, length: 4 });
  });

  it("should exclude email patterns (lookbehind)", () => {
    const memberMap = new Map([["company.com", "uid_x"]]);
    const content = "Send to user@company.com";
    const { entities, uids } = buildEntitiesFromFallback(content, memberMap);

    expect(uids).toEqual([]);
    expect(entities).toEqual([]);
  });

  it("should return empty for empty memberMap", () => {
    const { entities, uids } = buildEntitiesFromFallback(
      "@Bob @陈皮皮",
      new Map(),
    );
    expect(uids).toEqual([]);
    expect(entities).toEqual([]);
  });
});

// ── extractMentionUids ──

describe("extractMentionUids", () => {
  it("should extract uids from entities (v2 priority)", () => {
    const mention: MentionPayload = {
      entities: [
        { uid: "uid_a", offset: 0, length: 4 },
        { uid: "uid_b", offset: 5, length: 4 },
      ],
      uids: ["uid_old"],
    };
    expect(extractMentionUids(mention)).toEqual(["uid_a", "uid_b"]);
  });

  it("should fallback to uids when all entities are invalid", () => {
    const mention: MentionPayload = {
      entities: [{} as any, null as any],
      uids: ["bot_uid"],
    };
    expect(extractMentionUids(mention)).toEqual(["bot_uid"]);
  });

  it("should use uids when no entities", () => {
    const mention: MentionPayload = {
      uids: ["uid_a", "uid_b"],
    };
    expect(extractMentionUids(mention)).toEqual(["uid_a", "uid_b"]);
  });

  it("should return empty array for undefined/empty mention", () => {
    expect(extractMentionUids(undefined)).toEqual([]);
    expect(extractMentionUids({})).toEqual([]);
  });

  it("should filter non-string uids", () => {
    const mention: MentionPayload = {
      uids: ["uid_a", 123 as any, null as any, "uid_b"],
    };
    expect(extractMentionUids(mention)).toEqual(["uid_a", "uid_b"]);
  });
});

// ── convertContentForLLM ──

describe("convertContentForLLM", () => {
  it("entities path: should convert @name to @[uid:name]", () => {
    const content = "你好 @陈皮皮 和 @Bob 请看下";
    const mention: MentionPayload = {
      uids: ["uid_chen", "uid_bob"],
      entities: [
        { uid: "uid_chen", offset: 3, length: 4 },
        { uid: "uid_bob", offset: 10, length: 4 },
      ],
    };
    const result = convertContentForLLM(content, mention);
    expect(result).toBe("你好 @[uid_chen:陈皮皮] 和 @[uid_bob:Bob] 请看下");
  });

  it("should fallback to uids when entities are invalid", () => {
    const content = "@Alice @Bob";
    const mention: MentionPayload = {
      entities: [{} as any],
      uids: ["uid_a", "uid_b"],
    };
    const result = convertContentForLLM(content, mention);
    expect(result).toBe("@[uid_a:Alice] @[uid_b:Bob]");
  });

  it("should skip entities with out-of-bounds offset", () => {
    const content = "Hi @Bob";
    const mention: MentionPayload = {
      entities: [
        { uid: "uid_bob", offset: 3, length: 4 },
        { uid: "uid_x", offset: 100, length: 5 }, // out of bounds
      ],
    };
    const result = convertContentForLLM(content, mention);
    expect(result).toBe("Hi @[uid_bob:Bob]");
  });

  it("should return original content when no mention", () => {
    expect(convertContentForLLM("Hello world")).toBe("Hello world");
    expect(convertContentForLLM("Hello world", undefined)).toBe("Hello world");
  });

  it("should handle same-name different-uid users", () => {
    const content = "请 @陈皮皮 和 @陈皮皮 一起看下";
    const mention: MentionPayload = {
      uids: ["uid_chen_a", "uid_chen_b"],
      entities: [
        { uid: "uid_chen_a", offset: 2, length: 4 },
        { uid: "uid_chen_b", offset: 9, length: 4 },
      ],
    };
    const result = convertContentForLLM(content, mention);
    expect(result).toContain("@[uid_chen_a:陈皮皮]");
    expect(result).toContain("@[uid_chen_b:陈皮皮]");
  });
});

// ── Edge cases ──

describe("edge cases", () => {
  it("entity offset beyond content length", () => {
    const result = convertContentForLLM("Hi", {
      entities: [{ uid: "uid", offset: 100, length: 4 }],
    });
    expect(result).toBe("Hi");
  });

  it("entity length is 0", () => {
    const result = convertContentForLLM("@Bob", {
      entities: [{ uid: "uid", offset: 0, length: 0 }],
    });
    expect(result).toBe("@Bob");
  });

  it("entity offset is negative", () => {
    const result = convertContentForLLM("@Bob", {
      entities: [{ uid: "uid", offset: -1, length: 4 }],
    });
    expect(result).toBe("@Bob");
  });

  it("entity offset or length is NaN", () => {
    const result = convertContentForLLM("@Bob", {
      entities: [{ uid: "uid", offset: NaN, length: 4 }],
    });
    expect(result).toBe("@Bob");
  });

  it("entity offset or length is Infinity", () => {
    const result = convertContentForLLM("@Bob", {
      entities: [{ uid: "uid", offset: 0, length: Infinity }],
    });
    expect(result).toBe("@Bob");
  });

  it("entities array contains null", () => {
    const uids = extractMentionUids({
      entities: [null as any, { uid: "valid_uid", offset: 0, length: 4 }],
    });
    expect(uids).toEqual(["valid_uid"]);
  });

  it("content at entity offset does not start with @", () => {
    const result = convertContentForLLM("Hello world", {
      entities: [{ uid: "uid", offset: 0, length: 5 }],
    });
    expect(result).toBe("Hello world");
  });

  it("Emoji username: UTF-16 offset/length correct", () => {
    // "@张三🐱 你好" — 🐱 is 2 UTF-16 code units
    // "@张三🐱" length = 1 + 1 + 1 + 2 = 5
    const content = "@张三🐱 你好";
    const mention: MentionPayload = {
      entities: [{ uid: "uid_zhang", offset: 0, length: 5 }],
    };
    const result = convertContentForLLM(content, mention);
    expect(result).toBe("@[uid_zhang:张三🐱] 你好");
  });

  it("mixed v2 + fallback: uids order after sort", () => {
    const text = "Hi @[uid_chen:Chen] and @Bob";
    const structured = parseStructuredMentions(text);
    const validUids = new Set(["uid_chen"]);
    const converted = convertStructuredMentions(text, structured, validUids);

    const memberMap = new Map([["Bob", "uid_bob"]]);
    const remaining = buildEntitiesFromFallback(converted.content, memberMap);

    const allEntities = [...converted.entities, ...remaining.entities];
    allEntities.sort((a, b) => a.offset - b.offset);
    const uids = allEntities.map((e) => e.uid);

    // Chen before Bob
    expect(uids).toEqual(["uid_chen", "uid_bob"]);
    expect(allEntities[0]).toEqual({ uid: "uid_chen", offset: 3, length: 5 });
    expect(allEntities[1]).toEqual({ uid: "uid_bob", offset: 13, length: 4 });
    // Verify substring
    expect(converted.content.substring(3, 8)).toBe("@Chen");
    expect(converted.content.substring(13, 17)).toBe("@Bob");
  });
});
