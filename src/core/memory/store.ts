import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseEntries, serializeEntries } from "./parser.js";
import type { MemoryEntry } from "./parser.js";
import { scanContextContent } from "../prompt-builder.js";

const MEMORY_FILE = "MEMORY.md";
const USER_FILE = "USER.md";

/**
 * MemoryStore: durable structured memory backed by § delimited markdown files.
 *
 * Reads/writes MEMORY.md and USER.md from a configurable directory.
 * Operations (add, replace, remove) target MEMORY.md.
 * getSnapshot() returns combined text from both files.
 */
export class MemoryStore {
  private readonly dir: string;
  private frozenSnapshot: string | undefined;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** Add an entry with the given tag and content to MEMORY.md. Throws if content contains injection patterns. */
  add(tag: string, content: string): void {
    this.scanOrThrow(tag, content);
    const entries = this.readEntries(MEMORY_FILE);
    entries.push({ tag, content });
    this.writeEntries(MEMORY_FILE, entries);
  }

  /** Replace the content of an existing entry by tag. No-op if tag not found. Throws if content contains injection patterns. */
  replace(tag: string, content: string): void {
    this.scanOrThrow(tag, content);
    const entries = this.readEntries(MEMORY_FILE);
    const idx = entries.findIndex((e) => e.tag === tag);
    if (idx === -1) return;
    entries[idx] = { tag, content };
    this.writeEntries(MEMORY_FILE, entries);
  }

  /** Remove an entry by tag. No-op if tag not found. */
  remove(tag: string): void {
    const entries = this.readEntries(MEMORY_FILE);
    const filtered = entries.filter((e) => e.tag !== tag);
    this.writeEntries(MEMORY_FILE, filtered);
  }

  /**
   * Freeze the current memory state. After calling this, getSnapshot()
   * returns the frozen version to keep the system prompt stable for
   * Anthropic prompt caching. Use getLiveSnapshot() for live reads.
   */
  freezeSnapshot(): string {
    this.frozenSnapshot = this.readCombined();
    return this.frozenSnapshot;
  }

  /**
   * Return the frozen snapshot if available, otherwise read from disk.
   * Used by PromptBuilder for system prompt assembly.
   */
  getSnapshot(): string {
    return this.frozenSnapshot ?? this.readCombined();
  }

  /**
   * Always read from disk, bypassing the frozen cache.
   * Used by the memory tool read action so the agent sees latest state.
   */
  getLiveSnapshot(): string {
    return this.readCombined();
  }

  // --- private helpers ---

  private readCombined(): string {
    const memoryText = this.scanOnRead(this.readRaw(MEMORY_FILE), MEMORY_FILE);
    const userText = this.scanOnRead(this.readRaw(USER_FILE), USER_FILE);
    const parts = [memoryText.trim(), userText.trim()].filter(Boolean);
    return parts.join("\n\n");
  }

  /** Scan content for prompt injection; throw if threats detected. */
  private scanOrThrow(tag: string, content: string): void {
    const scanned = scanContextContent(content, `memory:${tag}`);
    if (scanned !== content) {
      throw new Error(scanned);
    }
  }

  /**
   * Scan raw file content on read. Returns original content if clean,
   * or a BLOCKED message if injection patterns are detected.
   * Unlike scanOrThrow, this does not throw, so snapshot assembly never
   * injects raw malicious text into the prompt.
   */
  private scanOnRead(content: string, filename: string): string {
    if (!content.trim()) return content;
    return scanContextContent(content, `memory:${filename}`);
  }

  private readEntries(file: string): MemoryEntry[] {
    return parseEntries(this.readRaw(file));
  }

  private writeEntries(file: string, entries: MemoryEntry[]): void {
    this.ensureDir();
    writeFileSync(join(this.dir, file), serializeEntries(entries), "utf-8");
  }

  private readRaw(file: string): string {
    const filePath = join(this.dir, file);
    if (!existsSync(filePath)) return "";
    return readFileSync(filePath, "utf-8");
  }

  private ensureDir(): void {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }
}
