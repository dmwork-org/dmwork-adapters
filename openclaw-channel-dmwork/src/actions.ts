/**
 * Message tool action handlers for the DMWork channel plugin.
 *
 * Implements: send, read, member-info, channel-list, channel-info
 * Each handler is stateless — maps and config are passed in via params.
 */

import { ChannelType } from "./types.js";
import {
  sendMessage,
  getChannelMessages,
  getGroupMembers,
  fetchBotGroups,
  getGroupInfo,
} from "./api-fetch.js";
import { uploadAndSendMedia } from "./inbound.js";
import { parseMentions } from "./mention-utils.js";

export interface MessageActionResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

type LogSink = {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
  warn?: (msg: string) => void;
  debug?: (msg: string) => void;
};

/** Parse a target string into channelId + channelType */
export function parseTarget(target: string): {
  channelId: string;
  channelType: ChannelType;
} {
  if (target.startsWith("group:"))
    return { channelId: target.slice(6), channelType: ChannelType.Group };
  if (target.startsWith("user:"))
    return { channelId: target.slice(5), channelType: ChannelType.DM };
  return { channelId: target, channelType: ChannelType.DM };
}

export async function handleDmworkMessageAction(params: {
  action: string;
  args: Record<string, unknown>;
  apiUrl: string;
  botToken: string;
  memberMap?: Map<string, string>;
  uidToNameMap?: Map<string, string>;
  log?: LogSink;
}): Promise<MessageActionResult> {
  const { action, args, apiUrl, botToken, memberMap, uidToNameMap, log } =
    params;

  if (!botToken) {
    return { ok: false, error: "DMWork botToken is not configured" };
  }

  switch (action) {
    case "send":
      return handleSend({ args, apiUrl, botToken, memberMap, log });
    case "read":
      return handleRead({ args, apiUrl, botToken, uidToNameMap, log });
    case "member-info":
      return handleMemberInfo({ args, apiUrl, botToken, log });
    case "channel-list":
      return handleChannelList({ apiUrl, botToken, log });
    case "channel-info":
      return handleChannelInfo({ args, apiUrl, botToken, log });
    default:
      return { ok: false, error: `Unknown action: ${action}` };
  }
}

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

async function handleSend(params: {
  args: Record<string, unknown>;
  apiUrl: string;
  botToken: string;
  memberMap?: Map<string, string>;
  log?: LogSink;
}): Promise<MessageActionResult> {
  const { args, apiUrl, botToken, memberMap, log } = params;

  const target = args.target as string | undefined;
  if (!target) {
    return { ok: false, error: "Missing required parameter: target" };
  }

  const message = (args.message as string | undefined)?.trim();
  const mediaUrl =
    (args.media as string | undefined) ??
    (args.mediaUrl as string | undefined) ??
    (args.filePath as string | undefined);

  if (!message && !mediaUrl) {
    return {
      ok: false,
      error: "At least one of message or media/mediaUrl/filePath is required",
    };
  }

  const { channelId, channelType } = parseTarget(target);

  // Send text message
  if (message) {
    let mentionUids: string[] = [];

    if (channelType === ChannelType.Group && memberMap) {
      const mentionNames = parseMentions(message);
      for (const name of mentionNames) {
        const uid = memberMap.get(name);
        if (uid && !mentionUids.includes(uid)) {
          mentionUids.push(uid);
        }
      }
    }

    await sendMessage({
      apiUrl,
      botToken,
      channelId,
      channelType,
      content: message,
      ...(mentionUids.length > 0 ? { mentionUids } : {}),
    });
  }

  // Send media
  if (mediaUrl) {
    await uploadAndSendMedia({
      mediaUrl,
      apiUrl,
      botToken,
      channelId,
      channelType,
      log: log as any,
    });
  }

  return { ok: true, data: { sent: true, target, channelId, channelType } };
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

async function handleRead(params: {
  args: Record<string, unknown>;
  apiUrl: string;
  botToken: string;
  uidToNameMap?: Map<string, string>;
  log?: LogSink;
}): Promise<MessageActionResult> {
  const { args, apiUrl, botToken, uidToNameMap, log } = params;

  const target = args.target as string | undefined;
  if (!target) {
    return { ok: false, error: "Missing required parameter: target" };
  }

  const rawLimit = Number(args.limit) || 20;
  const limit = Math.min(Math.max(rawLimit, 1), 100);

  const { channelId, channelType } = parseTarget(target);

  const messages = await getChannelMessages({
    apiUrl,
    botToken,
    channelId,
    channelType,
    limit,
    log: log
      ? {
          info: (...a: unknown[]) => log.info?.(String(a[0])),
          error: (...a: unknown[]) => log.error?.(String(a[0])),
        }
      : undefined,
  });

  // Resolve from_uid to display names when available
  const resolved = messages.map((m) => ({
    from: uidToNameMap?.get(m.from_uid) ?? m.from_uid,
    from_uid: m.from_uid,
    content: m.content,
    timestamp: m.timestamp,
  }));

  return { ok: true, data: { messages: resolved, count: resolved.length } };
}

// ---------------------------------------------------------------------------
// member-info
// ---------------------------------------------------------------------------

async function handleMemberInfo(params: {
  args: Record<string, unknown>;
  apiUrl: string;
  botToken: string;
  log?: LogSink;
}): Promise<MessageActionResult> {
  const { args, apiUrl, botToken, log } = params;

  const target = args.target as string | undefined;
  if (!target) {
    return { ok: false, error: "Missing required parameter: target" };
  }

  const { channelId } = parseTarget(target);

  const members = await getGroupMembers({
    apiUrl,
    botToken,
    groupNo: channelId,
    log: log
      ? {
          info: (...a: unknown[]) => log.info?.(String(a[0])),
          error: (...a: unknown[]) => log.error?.(String(a[0])),
        }
      : undefined,
  });

  return { ok: true, data: { members, count: members.length } };
}

// ---------------------------------------------------------------------------
// channel-list
// ---------------------------------------------------------------------------

async function handleChannelList(params: {
  apiUrl: string;
  botToken: string;
  log?: LogSink;
}): Promise<MessageActionResult> {
  const { apiUrl, botToken, log } = params;

  const groups = await fetchBotGroups({
    apiUrl,
    botToken,
    log: log
      ? {
          info: (...a: unknown[]) => log.info?.(String(a[0])),
          error: (...a: unknown[]) => log.error?.(String(a[0])),
        }
      : undefined,
  });

  return { ok: true, data: { groups, count: groups.length } };
}

// ---------------------------------------------------------------------------
// channel-info
// ---------------------------------------------------------------------------

async function handleChannelInfo(params: {
  args: Record<string, unknown>;
  apiUrl: string;
  botToken: string;
  log?: LogSink;
}): Promise<MessageActionResult> {
  const { args, apiUrl, botToken, log } = params;

  const target = args.target as string | undefined;
  if (!target) {
    return { ok: false, error: "Missing required parameter: target" };
  }

  const { channelId } = parseTarget(target);

  const info = await getGroupInfo({
    apiUrl,
    botToken,
    groupNo: channelId,
    log: log
      ? {
          info: (...a: unknown[]) => log.info?.(String(a[0])),
          error: (...a: unknown[]) => log.error?.(String(a[0])),
        }
      : undefined,
  });

  return { ok: true, data: info };
}
