/**
 * SDK Compatibility Layer
 *
 * Single contact point for all OpenClaw Plugin SDK runtime dependencies.
 * Type-only imports (`import type`) in other modules are safe (compile-time only).
 * This module centralizes all runtime value imports and PluginRuntime method probing.
 *
 * @see https://github.com/dmwork-org/dmwork-adapters/issues/168
 */

import type { PluginRuntime } from "openclaw/plugin-sdk";

// ── Runtime singleton ─────────────────────────────────────────────────────

let _runtime: PluginRuntime | null = null;

export function setRuntime(rt: PluginRuntime): void {
  _runtime = rt;
}

export function getRuntime(): PluginRuntime {
  if (!_runtime) throw new Error("dmwork: SDK runtime not initialized");
  return _runtime;
}

// ── Value re-exports with safe fallback ───────────────────────────────────

let _DEFAULT_ACCOUNT_ID = "__default__";
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sdk = require("openclaw/plugin-sdk");
  if (sdk.DEFAULT_ACCOUNT_ID) _DEFAULT_ACCOUNT_ID = sdk.DEFAULT_ACCOUNT_ID;
} catch { /* fallback if SDK not resolvable at require time */ }

export const DEFAULT_ACCOUNT_ID = _DEFAULT_ACCOUNT_ID;

// ── Optional SDK exports with fallbacks ───────────────────────────────────

let _clearHistoryEntriesIfEnabled:
  | ((map: Map<string, unknown[]>, limit: number) => void)
  | null = null;
let _defaultGroupHistoryLimit = 20;

/**
 * Load optional SDK exports that may not exist in older versions.
 * Call once during startAccount after probe passes.
 */
export async function loadOptionalSdkExports(): Promise<void> {
  try {
    const sdk: Record<string, unknown> = await import("openclaw/plugin-sdk");
    if (typeof sdk.clearHistoryEntriesIfEnabled === "function") {
      _clearHistoryEntriesIfEnabled = sdk.clearHistoryEntriesIfEnabled as typeof _clearHistoryEntriesIfEnabled;
    }
    if (typeof sdk.DEFAULT_GROUP_HISTORY_LIMIT === "number") {
      _defaultGroupHistoryLimit = sdk.DEFAULT_GROUP_HISTORY_LIMIT as number;
    }
  } catch { /* older SDK — use fallbacks */ }
}

/**
 * Clear history entries if the SDK function is available, otherwise trim manually.
 */
export function clearHistoryIfEnabled(map: Map<string, unknown[]>, limit: number): void {
  if (_clearHistoryEntriesIfEnabled) {
    _clearHistoryEntriesIfEnabled(map, limit);
    return;
  }
  // Built-in fallback: trim each entry list to the limit
  for (const [key, entries] of map) {
    if (entries.length > limit) map.set(key, entries.slice(-limit));
  }
}

/**
 * Get the default group history limit from SDK or fallback (20).
 */
export function getDefaultGroupHistoryLimit(): number {
  return _defaultGroupHistoryLimit;
}

// ── Startup probe ─────────────────────────────────────────────────────────

export interface ProbeResult {
  ok: boolean;
  missing: string[];
}

/**
 * Probe the 9 deep PluginRuntime methods required by this adapter.
 * Call once during startAccount. Any missing method = refuse to start.
 */
export function probeRuntimeMethods(rt: PluginRuntime): ProbeResult {
  const missing: string[] = [];

  const check = (path: string, obj: unknown, method: string) => {
    if (typeof (obj as Record<string, unknown>)?.[method] !== "function") {
      missing.push(path);
    }
  };

  check("config.loadConfig", rt?.config, "loadConfig");
  check("channel.routing.resolveAgentRoute", rt?.channel?.routing, "resolveAgentRoute");
  check("channel.session.resolveStorePath", rt?.channel?.session, "resolveStorePath");
  check("channel.session.readSessionUpdatedAt", rt?.channel?.session, "readSessionUpdatedAt");
  check("channel.session.recordInboundSession", rt?.channel?.session, "recordInboundSession");
  check("channel.reply.resolveEnvelopeFormatOptions", rt?.channel?.reply, "resolveEnvelopeFormatOptions");
  check("channel.reply.formatAgentEnvelope", rt?.channel?.reply, "formatAgentEnvelope");
  check("channel.reply.finalizeInboundContext", rt?.channel?.reply, "finalizeInboundContext");
  check("channel.reply.dispatchReplyWithBufferedBlockDispatcher", rt?.channel?.reply, "dispatchReplyWithBufferedBlockDispatcher");

  return { ok: missing.length === 0, missing };
}
