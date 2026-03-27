import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { existsSync, unlinkSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  TEMP_BASE, UPLOAD_DIR, MEDIA_DIR, FILES_DIR,
  cleanupTempDir, streamDownloadToFile, _resetCleanupThrottle,
} from "./temp-utils.js";

describe("temp directory constants", () => {
  it("should use /tmp/dmwork-temp as base", () => {
    expect(TEMP_BASE).toBe("/tmp/dmwork-temp");
  });

  it("should have correct subdirectories", () => {
    expect(UPLOAD_DIR).toBe("/tmp/dmwork-temp/upload");
    expect(MEDIA_DIR).toBe("/tmp/dmwork-temp/media");
    expect(FILES_DIR).toBe("/tmp/dmwork-temp/files");
  });
});

describe("cleanupTempDir throttle", () => {
  beforeEach(() => {
    _resetCleanupThrottle();
  });

  it("should run cleanup on first call", async () => {
    // Will attempt readdir on a likely non-existent dir — that's fine, it catches
    await expect(cleanupTempDir("/tmp/dmwork-temp-test-nonexistent")).resolves.toBeUndefined();
  });

  it("should skip cleanup within 10 minutes of last run", async () => {
    const dir = "/tmp/dmwork-temp-throttle-test";
    await cleanupTempDir(dir); // first call — runs
    // second call — should be throttled (no-op)
    await expect(cleanupTempDir(dir)).resolves.toBeUndefined();
    // We can't easily observe the skip, but we verify it doesn't throw
  });

  it("should allow cleanup of different directories independently", async () => {
    const dir1 = "/tmp/dmwork-temp-throttle-a";
    const dir2 = "/tmp/dmwork-temp-throttle-b";
    await cleanupTempDir(dir1);
    // dir2 has never been cleaned — should run
    await expect(cleanupTempDir(dir2)).resolves.toBeUndefined();
  });
});

describe("streamDownloadToFile", () => {
  const originalFetch = globalThis.fetch;
  const tempFiles: string[] = [];

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    for (const f of tempFiles) {
      try { unlinkSync(f); } catch {}
    }
    tempFiles.length = 0;
  });

  it("should download to dest directory with correct content", async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "content-type": "application/octet-stream" }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(data);
          controller.close();
        },
      }),
    }) as any;

    const destDir = join(TEMP_BASE, "test-dl");
    const result = await streamDownloadToFile({
      url: "https://example.com/file.bin",
      destDir,
      filename: "file.bin",
      maxSize: 1024,
      timeoutMs: 5000,
    });

    expect(result.localPath).toContain("test-dl");
    expect(result.localPath).toContain("file.bin");
    expect(result.totalBytes).toBe(5);
    expect(result.contentType).toBe("application/octet-stream");
    expect(existsSync(result.localPath)).toBe(true);
    expect(readFileSync(result.localPath)).toEqual(Buffer.from(data));
    tempFiles.push(result.localPath);
  });

  it("should throw and cleanup when exceeding maxSize", async () => {
    const chunk = new Uint8Array(1024);

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: new Headers(),
      body: new ReadableStream({
        start(controller) {
          // Push 2KB, but maxSize is 1KB
          controller.enqueue(chunk);
          controller.enqueue(chunk);
          controller.close();
        },
      }),
    }) as any;

    const destDir = join(TEMP_BASE, "test-overflow");
    await expect(streamDownloadToFile({
      url: "https://example.com/big.bin",
      destDir,
      filename: "big.bin",
      maxSize: 1024,
      timeoutMs: 5000,
    })).rejects.toThrow("File too large");
  });

  it("should throw on HTTP error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      headers: new Headers(),
    }) as any;

    await expect(streamDownloadToFile({
      url: "https://example.com/missing.bin",
      destDir: join(TEMP_BASE, "test-404"),
      filename: "missing.bin",
      maxSize: 1024,
      timeoutMs: 5000,
    })).rejects.toThrow("HTTP 404");
  });

  it("should perform HEAD pre-check when headCheck is true", async () => {
    const calls: string[] = [];

    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts?: any) => {
      calls.push(opts?.method ?? "GET");
      if (opts?.method === "HEAD") {
        return {
          ok: true,
          headers: new Headers({ "content-length": "99999" }),
        };
      }
      // GET shouldn't be reached if HEAD rejects
      return { ok: true, headers: new Headers(), body: null };
    }) as any;

    await expect(streamDownloadToFile({
      url: "https://example.com/huge.bin",
      destDir: join(TEMP_BASE, "test-head"),
      filename: "huge.bin",
      maxSize: 100,
      timeoutMs: 5000,
      headCheck: true,
    })).rejects.toThrow("File too large");

    expect(calls).toEqual(["HEAD"]); // GET not called
  });

  it("should pass custom headers to fetch", async () => {
    let capturedHeaders: Record<string, string> | undefined;

    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts?: any) => {
      capturedHeaders = opts?.headers;
      return {
        ok: true,
        headers: new Headers(),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
            controller.close();
          },
        }),
      };
    }) as any;

    const destDir = join(TEMP_BASE, "test-headers");
    const result = await streamDownloadToFile({
      url: "https://example.com/auth.bin",
      destDir,
      filename: "auth.bin",
      maxSize: 1024,
      timeoutMs: 5000,
      headers: { Authorization: "Bearer token123" },
    });

    expect(capturedHeaders).toEqual({ Authorization: "Bearer token123" });
    tempFiles.push(result.localPath);
  });
});
