import { join } from "node:path";
import { createWriteStream } from "node:fs";
import { mkdir, unlink, readdir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";

// --- Unified temp directory layout ---
export const TEMP_BASE = join("/tmp", "dmwork-temp");
export const UPLOAD_DIR = join(TEMP_BASE, "upload");
export const MEDIA_DIR = join(TEMP_BASE, "media");
export const FILES_DIR = join(TEMP_BASE, "files");

// --- Throttled cleanup ---
const lastCleanupTime = new Map<string, number>();
const CLEANUP_THROTTLE_MS = 10 * 60 * 1000; // 10 minutes

/** Best-effort cleanup of temp files older than 1 hour in the given directory.
 *  Throttled: skips if the same directory was cleaned less than 10 minutes ago. */
export async function cleanupTempDir(dir: string): Promise<void> {
  const now = Date.now();
  const last = lastCleanupTime.get(dir) ?? 0;
  if (now - last < CLEANUP_THROTTLE_MS) return;
  lastCleanupTime.set(dir, now);

  try {
    const entries = await readdir(dir);
    const cutoff = now - 60 * 60 * 1000;
    for (const entry of entries) {
      try {
        const filePath = join(dir, entry);
        const info = await stat(filePath);
        if (info.mtimeMs < cutoff) {
          await unlink(filePath);
        }
      } catch {}
    }
  } catch { /* dir may not exist yet */ }
}

/** Reset throttle state — exposed only for testing */
export function _resetCleanupThrottle(): void {
  lastCleanupTime.clear();
}

// --- Common stream download ---
export interface StreamDownloadOptions {
  url: string;
  destDir: string;
  filename: string;
  maxSize: number;
  timeoutMs: number;
  headers?: Record<string, string>;
  /** If true, run HEAD first to pre-check content-length */
  headCheck?: boolean;
}

export interface StreamDownloadResult {
  localPath: string;
  totalBytes: number;
  contentType: string | undefined;
}

/**
 * Stream-download a URL to a temp file with backpressure and size limit.
 *
 * Uses getReader+drain pattern for consistent backpressure handling.
 * On failure, cleans up partial file and re-throws.
 */
export async function streamDownloadToFile(opts: StreamDownloadOptions): Promise<StreamDownloadResult> {
  await mkdir(opts.destDir, { recursive: true });
  const localPath = join(opts.destDir, `${randomUUID()}-${opts.filename}`);

  // Optional HEAD pre-check
  if (opts.headCheck) {
    const head = await fetch(opts.url, {
      method: "HEAD",
      headers: opts.headers,
      signal: AbortSignal.timeout(30_000),
    });
    const contentLength = Number(head.headers.get("content-length") || 0);
    if (contentLength > opts.maxSize) {
      throw new Error(`File too large (${contentLength} bytes, max ${opts.maxSize})`);
    }
  }

  const resp = await fetch(opts.url, {
    headers: opts.headers,
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  if (!resp.body) throw new Error("no response body");

  const contentType = resp.headers.get("content-type") ?? undefined;

  const ws = createWriteStream(localPath);
  let totalBytes = 0;
  try {
    const reader = (resp.body as any).getReader() as ReadableStreamDefaultReader<Uint8Array>;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > opts.maxSize) {
        reader.cancel();
        ws.destroy();
        try { await unlink(localPath); } catch {}
        throw new Error(`File too large (${totalBytes} bytes, max ${opts.maxSize})`);
      }
      if (!ws.write(value)) {
        await new Promise<void>(r => ws.once("drain", r));
      }
    }
    ws.end();
    await new Promise<void>((resolve, reject) => {
      ws.on("finish", resolve);
      ws.on("error", reject);
    });
  } catch (err) {
    ws.destroy();
    try { await unlink(localPath); } catch {}
    throw err;
  }

  return { localPath, totalBytes, contentType };
}
