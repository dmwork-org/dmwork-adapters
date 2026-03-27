/**
 * Shared @mention parsing utilities.
 * Ensures consistent mention detection across inbound and outbound code paths.
 *
 * Fixes: https://github.com/dmwork-org/dmwork-adapters/issues/31
 */

import type { MentionEntity, MentionPayload } from "./types.js";

/**
 * Regex pattern for matching @mentions in message content.
 *
 * Lookbehind: @ must be preceded by start-of-string or a non-alphanumeric
 * character (blacklist approach — excludes email-like user@domain).
 *
 * Name supports: letters, digits, underscores, CJK characters, Latin
 * extended (accented), Japanese kana, Korean syllables, dots, hyphens.
 *
 * Capture groups:
 *   match[0] = full match (@name, lookbehind does not consume)
 *   match[1] = name (without @)
 */
export const MENTION_PATTERN =
  /(?:^|(?<=\s|[^a-zA-Z0-9]))@([\w\u00C0-\u024F\u4e00-\u9fff\u3040-\u30FF\uAC00-\uD7AF.\-]+)/g;

/**
 * Match @[uid:displayName] format (adapter↔LLM internal use).
 *
 * uid charset: [\w.\-]+ — covers all known dmwork uid formats:
 *   - alphanumeric with underscores: uid_chen, boris_dev_bot
 *   - 32-char hex: 11be65096f214886b69ef9d8fcfa5c55
 *   - dots/hyphens: thomas.ford-1
 *
 * name charset: [^\]\n]+ — forbids brackets and newlines, allows everything else
 */
export const STRUCTURED_MENTION_PATTERN = /@\[([\w.\-]+):([^\]\n]+)\]/g;

/**
 * Parse @mentions from message content.
 * Returns an array of mentioned names (without the @ prefix).
 *
 * @example
 * parseMentions("Hello @陈皮皮 and @bob_123!")
 * // Returns: ["陈皮皮", "bob_123"]
 */
export function parseMentions(content: string): string[] {
  const regex = new RegExp(MENTION_PATTERN.source, "g");
  const results: string[] = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    results.push(match[1]);
  }
  return results;
}

/**
 * Extract raw @mention matches including the @ prefix.
 * Useful when you need the full match text.
 *
 * @example
 * extractMentionMatches("Hello @陈皮皮!")
 * // Returns: ["@陈皮皮"]
 */
export function extractMentionMatches(content: string): string[] {
  const regex = new RegExp(MENTION_PATTERN.source, "g");
  const results: string[] = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    results.push(match[0]);
  }
  return results;
}

// ── Structured mention types ──

export interface StructuredMention {
  uid: string;
  name: string;
  /** Start position of @[uid:name] in the original text */
  offset: number;
  /** Full length of @[uid:name] */
  length: number;
}

/**
 * Parse @[uid:name] format mentions from text.
 * Used to process structured mentions in LLM replies.
 */
export function parseStructuredMentions(text: string): StructuredMention[] {
  const results: StructuredMention[] = [];
  const pattern = new RegExp(STRUCTURED_MENTION_PATTERN.source, "g");
  let match;
  while ((match = pattern.exec(text)) !== null) {
    results.push({
      uid: match[1],
      name: match[2],
      offset: match.index,
      length: match[0].length,
    });
  }
  return results;
}

// ── Conversion result ──

export interface ConvertResult {
  /** Human-readable content (@[uid:name] → @name) */
  content: string;
  /** Valid mention entities with precise positions */
  entities: MentionEntity[];
  /** Valid mention UIDs in offset-ascending order (matches entities order) */
  uids: string[];
}

/**
 * Convert @[uid:name] in text to @name, building entities and uids.
 *
 * Uses incremental construction: traverses mentions in offset-ascending
 * order, concatenating output segments to naturally track each mention's
 * precise position — avoids indexOf re-scanning that causes same-name
 * mentions to bind to wrong positions.
 *
 * @param text - Original text containing @[uid:name] (typically from LLM reply)
 * @param mentions - Result from parseStructuredMentions
 * @param validUids - Set of known valid UIDs (from uidToNameMap keys)
 */
export function convertStructuredMentions(
  text: string,
  mentions: StructuredMention[],
  validUids: Set<string>,
): ConvertResult {
  const sorted = [...mentions].sort((a, b) => a.offset - b.offset);

  const entities: MentionEntity[] = [];
  const uids: string[] = [];
  let content = "";
  let cursor = 0;

  for (const m of sorted) {
    // 1. Add plain text before this mention
    content += text.substring(cursor, m.offset);

    // 2. Replace @[uid:name] → @name
    const replacement = `@${m.name}`;
    const newOffset = content.length; // precise position in output
    content += replacement;

    // 3. Record entity if uid is valid
    if (validUids.has(m.uid)) {
      entities.push({
        uid: m.uid,
        offset: newOffset,
        length: replacement.length,
      });
      uids.push(m.uid);
    }
    // Invalid uid: @name stays as plain text, not added to entities

    cursor = m.offset + m.length;
  }

  // 4. Add remaining text after last mention
  content += text.substring(cursor);

  return { content, entities, uids };
}

/**
 * Build entities from plain @name text (fallback path).
 * Resolves each @name to a uid via memberMap (displayName → uid).
 *
 * Depends on MENTION_PATTERN capture group: match[1] is name (without @).
 * Lookbehind does not consume characters, so match.index points to @.
 *
 * @param content - Human-readable content (no @[uid:name])
 * @param memberMap - displayName → uid mapping
 */
export function buildEntitiesFromFallback(
  content: string,
  memberMap: Map<string, string>,
): { entities: MentionEntity[]; uids: string[] } {
  const entities: MentionEntity[] = [];
  const uids: string[] = [];

  const pattern = new RegExp(MENTION_PATTERN.source, "g");
  let match;

  while ((match = pattern.exec(content)) !== null) {
    // match[1] is name (without @) — depends on MENTION_PATTERN capture group
    const name = match[1];
    const uid = memberMap.get(name);

    if (!uid) {
      // Cannot resolve uid (hallucination, email false positive, etc.) — skip
      continue;
    }

    // Lookbehind does not consume characters, match.index is @ position
    const atName = `@${name}`;
    entities.push({ uid, offset: match.index, length: atName.length });
    uids.push(uid);
  }

  return { entities, uids };
}

/**
 * Extract mention UIDs with compatibility fallback.
 *
 * Priority:
 * 1. Valid entries from entities → use their UIDs
 * 2. All entities invalid → fall through to uids
 * 3. No uids either → empty array
 *
 * Fixes: invalid entities suppressing uids fallback.
 */
export function extractMentionUids(mention?: MentionPayload): string[] {
  if (!mention) return [];

  // Try entities first
  if (mention.entities && Array.isArray(mention.entities)) {
    const validUids = mention.entities
      .filter(
        (e): e is MentionEntity =>
          e != null &&
          typeof e === "object" &&
          !Array.isArray(e) &&
          typeof e.uid === "string",
      )
      .map((e) => e.uid);

    // Only return if we got valid results; otherwise fall through to uids
    if (validUids.length > 0) return validUids;
  }

  // Fallback to uids
  if (mention.uids && Array.isArray(mention.uids)) {
    return mention.uids.filter((uid): uid is string => typeof uid === "string");
  }

  return [];
}

/**
 * Convert @name in historical messages to @[uid:name] for LLM comprehension.
 *
 * Priority:
 * 1. Valid entities → precise replacement (v2)
 * 2. Invalid/missing entities → uids + regex sequential pairing (v1 fallback)
 * 3. No mention → return original content
 *
 * Replaces back-to-front to avoid offset drift.
 *
 * Fallback path depends on MENTION_PATTERN capture group (match[1]).
 * Lookbehind does not consume characters, match.index points to @.
 */
export function convertContentForLLM(
  content: string,
  mention?: MentionPayload,
): string {
  if (!mention) return content;

  // Try entities (v2)
  if (mention.entities && Array.isArray(mention.entities)) {
    const validEntities = mention.entities.filter(
      (e): e is MentionEntity =>
        e != null &&
        typeof e === "object" &&
        !Array.isArray(e) &&
        typeof e.uid === "string" &&
        typeof e.offset === "number" &&
        typeof e.length === "number" &&
        Number.isFinite(e.offset) &&
        Number.isFinite(e.length) &&
        e.offset >= 0 &&
        e.length > 0 &&
        e.offset + e.length <= content.length, // bounds check against original content
    );

    // Only use v2 path if we have valid entities
    if (validEntities.length > 0) {
      // Replace back-to-front to avoid offset drift
      const sorted = [...validEntities].sort((a, b) => b.offset - a.offset);
      let result = content;
      for (const entity of sorted) {
        const original = result.substring(
          entity.offset,
          entity.offset + entity.length,
        );
        if (!original.startsWith("@")) continue; // defense: skip if position mismatch
        const name = original.substring(1);
        const replacement = `@[${entity.uid}:${name}]`;
        result =
          result.substring(0, entity.offset) +
          replacement +
          result.substring(entity.offset + entity.length);
      }
      return result;
    }
    // No valid entities → fall through to uids
  }

  // Fallback: uids + regex sequential pairing (v1)
  if (mention.uids && Array.isArray(mention.uids) && mention.uids.length > 0) {
    let result = content;
    const pattern = new RegExp(MENTION_PATTERN.source, "g");
    let match;
    let i = 0;
    const replacements: {
      start: number;
      end: number;
      replacement: string;
    }[] = [];

    while (
      (match = pattern.exec(content)) !== null &&
      i < mention.uids.length
    ) {
      // match[1] is name — depends on MENTION_PATTERN capture group
      const name = match[1];
      // Lookbehind does not consume characters, match.index points to @
      const uid = mention.uids[i];
      if (typeof uid === "string") {
        replacements.push({
          start: match.index,
          end: match.index + 1 + name.length,
          replacement: `@[${uid}:${name}]`,
        });
      }
      i++;
    }

    // Replace back-to-front
    for (let j = replacements.length - 1; j >= 0; j--) {
      const r = replacements[j];
      result =
        result.substring(0, r.start) +
        r.replacement +
        result.substring(r.end);
    }
    return result;
  }

  return content;
}
