/**
 * Media cache and voice transcription utilities for gateway adapters.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join, extname } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function urlHash(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

function extFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const ext = extname(pathname);
    return ext || ".bin";
  } catch {
    return ".bin";
  }
}

// ---------------------------------------------------------------------------
// MediaCache
// ---------------------------------------------------------------------------

export class MediaCache {
  private readonly cacheDir: string;

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
  }

  /**
   * Download a URL to `cacheDir/{hash}.{ext}`.
   * Returns the local file path, or null on failure.
   * If the file is already cached, returns the cached path immediately.
   */
  async download(url: string): Promise<string | null> {
    const hash = urlHash(url);
    const ext = extFromUrl(url);
    const filePath = join(this.cacheDir, `${hash}${ext}`);

    // Return cached path if it already exists
    if (existsSync(filePath)) {
      return filePath;
    }

    try {
      const response = await fetch(url);
      if (!response.ok) {
        return null;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      writeFileSync(filePath, buffer);
      return filePath;
    } catch {
      return null;
    }
  }

  /**
   * Delete cached files older than maxAgeMs (default 24 hours).
   */
  async cleanup(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<void> {
    const now = Date.now();
    const entries = readdirSync(this.cacheDir);

    for (const entry of entries) {
      const filePath = join(this.cacheDir, entry);
      try {
        const stat = statSync(filePath);
        if (stat.isFile() && now - stat.mtimeMs > maxAgeMs) {
          unlinkSync(filePath);
        }
      } catch {
        // Ignore stat/unlink errors for individual files
      }
    }
  }

  /**
   * Transcribe a voice file.
   * If apiKey is provided, POST to a Whisper-compatible endpoint.
   * Otherwise, return a fallback message.
   */
  async transcribeVoice(
    filePath: string,
    apiKey?: string,
    endpoint: string = "https://api.openai.com/v1/audio/transcriptions",
  ): Promise<string> {
    if (!apiKey) {
      return "Voice message received (transcription not configured)";
    }

    const fileData = readFileSync(filePath);
    const fileName = filePath.split("/").pop() ?? "audio.ogg";

    const formData = new FormData();
    formData.append(
      "file",
      new Blob([fileData], { type: "audio/ogg" }),
      fileName,
    );
    formData.append("model", "whisper-1");

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    });

    const json = (await response.json()) as { text: string };
    return json.text;
  }
}
