import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTempDir } from "../helpers/fixtures.js";
import { existsSync, writeFileSync, utimesSync, readdirSync } from "node:fs";
import { join } from "node:path";

// We test the MediaCache class from src/gateway/media.ts
import { MediaCache } from "../../src/gateway/media.js";

describe("MediaCache", () => {
  let cacheDir: string;
  let cleanup: () => void;
  let cache: MediaCache;

  beforeEach(() => {
    const tmp = createTempDir("media-cache-test-");
    cacheDir = tmp.path;
    cleanup = tmp.cleanup;
    cache = new MediaCache(cacheDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  // -------------------------------------------------------------------------
  // 1. download URL → file cached (mock fetch with Response)
  // -------------------------------------------------------------------------
  it("downloads a URL and caches the file locally", async () => {
    const fakeBody = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    const fakeResponse = new Response(fakeBody, {
      status: 200,
      headers: { "Content-Type": "image/png" },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(fakeResponse);

    const result = await cache.download("https://example.com/photo.png");

    expect(result).not.toBeNull();
    expect(result!.endsWith(".png")).toBe(true);
    expect(existsSync(result!)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 2. same URL returns cached path (no second fetch)
  // -------------------------------------------------------------------------
  it("returns cached path for the same URL without re-fetching", async () => {
    const fakeBody = new Uint8Array([0xff, 0xd8]);
    const fakeResponse = new Response(fakeBody, {
      status: 200,
      headers: { "Content-Type": "image/jpeg" },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(fakeResponse);

    const first = await cache.download("https://example.com/img.jpg");
    const second = await cache.download("https://example.com/img.jpg");

    expect(first).toBe(second);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 3. cleanup removes old files
  // -------------------------------------------------------------------------
  it("cleanup removes files older than maxAgeMs", async () => {
    const oldFile = join(cacheDir, "old.png");
    writeFileSync(oldFile, "old");
    // Set mtime to 2 days ago
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(oldFile, twoDaysAgo, twoDaysAgo);

    const freshFile = join(cacheDir, "fresh.png");
    writeFileSync(freshFile, "fresh");

    await cache.cleanup(); // default 24h

    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(freshFile)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 4. download failure returns null
  // -------------------------------------------------------------------------
  it("returns null when the download fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new Error("Network error"),
    );

    const result = await cache.download("https://example.com/broken.mp3");

    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 5. transcribeVoice with API key (mock endpoint)
  // -------------------------------------------------------------------------
  it("transcribes voice via Whisper-compatible endpoint when apiKey is provided", async () => {
    const audioFile = join(cacheDir, "voice.ogg");
    writeFileSync(audioFile, "fake-audio-data");

    const mockResponse = new Response(
      JSON.stringify({ text: "Hello world" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse);

    const text = await cache.transcribeVoice(
      audioFile,
      "sk-test-key",
      "https://api.openai.com/v1/audio/transcriptions",
    );

    expect(text).toBe("Hello world");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    // Verify the request was sent correctly
    const call = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(call[0]).toBe("https://api.openai.com/v1/audio/transcriptions");
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.headers).toHaveProperty("Authorization", "Bearer sk-test-key");
  });

  // -------------------------------------------------------------------------
  // 6. transcribeVoice without API key returns fallback
  // -------------------------------------------------------------------------
  it("returns fallback message when no apiKey is provided", async () => {
    const audioFile = join(cacheDir, "voice.ogg");
    writeFileSync(audioFile, "fake-audio-data");

    const text = await cache.transcribeVoice(audioFile);

    expect(text).toBe(
      "Voice message received (transcription not configured)",
    );
  });
});
