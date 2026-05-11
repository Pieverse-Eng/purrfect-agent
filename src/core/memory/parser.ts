/**
 * MemoryParser: handles § delimited memory entries.
 *
 * Entry format:
 *   § tag-name
 *   content lines
 *
 * Entries are separated by blank lines between the end of one entry's
 * content and the next § header.
 */

export interface MemoryEntry {
  tag: string;
  content: string;
}

const ENTRY_HEADER = "§ ";

/**
 * Parse raw text into structured memory entries.
 */
export function parseEntries(text: string): MemoryEntry[] {
  if (!text.trim()) return [];

  const entries: MemoryEntry[] = [];
  const lines = text.split("\n");
  let currentTag: string | null = null;
  let contentLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith(ENTRY_HEADER)) {
      // Flush previous entry
      if (currentTag !== null) {
        entries.push({ tag: currentTag, content: contentLines.join("\n").trim() });
      }
      currentTag = line.slice(ENTRY_HEADER.length).trim();
      contentLines = [];
    } else if (currentTag !== null) {
      contentLines.push(line);
    }
  }

  // Flush last entry
  if (currentTag !== null) {
    entries.push({ tag: currentTag, content: contentLines.join("\n").trim() });
  }

  return entries;
}

/**
 * Serialize structured entries back to § delimited text.
 */
export function serializeEntries(entries: MemoryEntry[]): string {
  if (entries.length === 0) return "";

  return entries
    .map((e) => `${ENTRY_HEADER}${e.tag}\n${e.content}`)
    .join("\n\n") + "\n";
}
