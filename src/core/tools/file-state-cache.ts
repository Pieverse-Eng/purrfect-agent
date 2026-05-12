import { createHash } from "node:crypto";
import { resolve } from "node:path";

export interface FileStateEntry {
  readonly mtimeMs: number;
  readonly contentHash: string;
}

/**
 * Tracks which files have been read during a session, recording their
 * mtime and content hash so that file_write can enforce read-before-write.
 *
 * One instance is shared between file_read and file_write tools within
 * a single session. Not persisted — lives in memory only.
 */
export class FileStateCache {
  private readonly entries = new Map<string, FileStateEntry>();

  /** Normalize path so lookups are consistent regardless of relative segments. */
  private normalize(filePath: string): string {
    return resolve(filePath);
  }

  /** Record that a file was read (or just written) with the given state. */
  recordRead(filePath: string, mtimeMs: number, content: string): void {
    this.entries.set(this.normalize(filePath), {
      mtimeMs,
      contentHash: createHash("sha256").update(content).digest("hex"),
    });
  }

  /** Return the recorded state for a file, or undefined if never read. */
  getEntry(filePath: string): FileStateEntry | undefined {
    return this.entries.get(this.normalize(filePath));
  }

  /** Check whether a file has been read in this session. */
  hasBeenRead(filePath: string): boolean {
    return this.entries.has(this.normalize(filePath));
  }

  /** Clear all entries (useful for testing). */
  clear(): void {
    this.entries.clear();
  }
}
