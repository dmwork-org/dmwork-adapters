/**
 * Contract tests for OpenClaw Plugin SDK compatibility.
 *
 * These tests verify that the SDK interface this adapter depends on
 * hasn't changed in a breaking way. Run against multiple OpenClaw
 * versions in CI to catch incompatibilities early.
 *
 * @see https://github.com/dmwork-org/dmwork-adapters/issues/168
 */

import { describe, it, expect } from "vitest";
import { probeRuntimeMethods, DEFAULT_ACCOUNT_ID } from "./sdk-compat.js";

describe("SDK contract — sdk-compat", () => {
  it("DEFAULT_ACCOUNT_ID is a non-empty string", () => {
    expect(typeof DEFAULT_ACCOUNT_ID).toBe("string");
    expect(DEFAULT_ACCOUNT_ID.length).toBeGreaterThan(0);
  });

  it("probeRuntimeMethods reports all 9 missing on empty object", () => {
    const result = probeRuntimeMethods({} as any);
    expect(result.ok).toBe(false);
    expect(result.missing.length).toBe(9);
    expect(result.missing).toContain("config.loadConfig");
    expect(result.missing).toContain("channel.routing.resolveAgentRoute");
    expect(result.missing).toContain("channel.session.resolveStorePath");
    expect(result.missing).toContain("channel.session.readSessionUpdatedAt");
    expect(result.missing).toContain("channel.session.recordInboundSession");
    expect(result.missing).toContain("channel.reply.resolveEnvelopeFormatOptions");
    expect(result.missing).toContain("channel.reply.formatAgentEnvelope");
    expect(result.missing).toContain("channel.reply.finalizeInboundContext");
    expect(result.missing).toContain("channel.reply.dispatchReplyWithBufferedBlockDispatcher");
  });

  it("probeRuntimeMethods reports ok on complete mock", () => {
    const mockRuntime = {
      config: { loadConfig: () => ({}) },
      channel: {
        routing: { resolveAgentRoute: () => ({}) },
        session: {
          resolveStorePath: () => "",
          readSessionUpdatedAt: () => null,
          recordInboundSession: async () => {},
        },
        reply: {
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope: () => "",
          finalizeInboundContext: () => ({}),
          dispatchReplyWithBufferedBlockDispatcher: async () => {},
        },
      },
    };
    const result = probeRuntimeMethods(mockRuntime as any);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("probeRuntimeMethods detects partial missing methods", () => {
    const partial = {
      config: { loadConfig: () => ({}) },
      channel: {
        routing: { resolveAgentRoute: () => ({}) },
        session: {}, // all session methods missing
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async () => {},
          // other reply methods missing
        },
      },
    };
    const result = probeRuntimeMethods(partial as any);
    expect(result.ok).toBe(false);

    // These should be detected as missing
    expect(result.missing).toContain("channel.session.resolveStorePath");
    expect(result.missing).toContain("channel.session.readSessionUpdatedAt");
    expect(result.missing).toContain("channel.session.recordInboundSession");
    expect(result.missing).toContain("channel.reply.resolveEnvelopeFormatOptions");
    expect(result.missing).toContain("channel.reply.formatAgentEnvelope");
    expect(result.missing).toContain("channel.reply.finalizeInboundContext");

    // These should NOT be missing
    expect(result.missing).not.toContain("config.loadConfig");
    expect(result.missing).not.toContain("channel.routing.resolveAgentRoute");
    expect(result.missing).not.toContain("channel.reply.dispatchReplyWithBufferedBlockDispatcher");
  });

  it("probeRuntimeMethods handles null/undefined gracefully", () => {
    expect(probeRuntimeMethods(null as any).ok).toBe(false);
    expect(probeRuntimeMethods(undefined as any).ok).toBe(false);
    expect(probeRuntimeMethods({ config: null, channel: null } as any).ok).toBe(false);
  });
});
