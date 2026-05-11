import { estimateTotalTokens } from "./compressor.js";
import type { Message, ToolCall } from "./types.js";

export const TRAJECTORY_DUPLICATE_RESULT_PLACEHOLDER =
  "[Duplicate search result omitted; the latest result for this path/query is preserved later in the trajectory.]";

export const TRAJECTORY_FILE_SNAPSHOT_HEADER = "[File snapshot]";

const DEFAULT_PROTECT_LAST_TURNS = 8;
const DEFAULT_SHELL_STDOUT_MAX_BYTES = 8_000;

const DEFAULT_SEARCH_TOOL_NAMES = [
  "glob",
  "grep",
  "rg",
  "ripgrep",
  "search",
  "file_search",
];

const DEFAULT_FILE_READ_TOOL_NAMES = [
  "file_read",
  "read_file",
  "fileread",
];

const DEFAULT_SHELL_TOOL_NAMES = [
  "shell_exec",
  "exec_command",
  "bash",
  "shell",
];

const DEFAULT_TODO_WRITE_TOOL_NAMES = [
  "todo_write",
  "todowrite",
  "todo",
];

interface IndexedToolCall {
  name: string;
  args: Record<string, unknown>;
  raw: ToolCall;
}

export interface TrajectoryCompressionOptions {
  /** Recent tail messages left untouched. Default: 8. */
  protectLastTurns?: number;
  /** Old shell stdout longer than this many UTF-8 bytes is truncated. Default: 8000. */
  shellStdoutMaxBytes?: number;
  /** Optional cap for each file body inside a file snapshot. Undefined preserves full file text. */
  fileSnapshotMaxBytesPerFile?: number;
  searchToolNames?: string[];
  fileReadToolNames?: string[];
  shellToolNames?: string[];
  todoWriteToolNames?: string[];
  duplicateResultPlaceholder?: string;
}

export interface TrajectoryCompressionMetrics {
  originalMessages: number;
  compressedMessages: number;
  originalTokens: number;
  compressedTokens: number;
  tokensSaved: number;
  compressionRatio: number;
  duplicateSearchResultsRemoved: number;
  fileSnapshotsCreated: number;
  fileReadResultsMerged: number;
  shellStdoutTruncated: number;
  todoWriteResultsPreserved: number;
}

export interface TrajectoryCompressionResult {
  messages: Message[];
  metrics: TrajectoryCompressionMetrics;
}

interface NormalizedOptions {
  protectLastTurns: number;
  shellStdoutMaxBytes: number;
  fileSnapshotMaxBytesPerFile?: number;
  searchToolNames: Set<string>;
  fileReadToolNames: Set<string>;
  shellToolNames: Set<string>;
  todoWriteToolNames: Set<string>;
  duplicateResultPlaceholder: string;
}

export class TrajectoryCompressor {
  private readonly options: NormalizedOptions;

  constructor(options: TrajectoryCompressionOptions = {}) {
    this.options = normalizeOptions(options);
  }

  compress(messages: Message[]): TrajectoryCompressionResult {
    const originalTokens = estimateTotalTokens(messages);
    const compressed = messages.map(cloneMessage);
    const callIndex = buildToolCallIndex(compressed);
    const protectedStart = Math.max(
      0,
      compressed.length - this.options.protectLastTurns,
    );
    const lastAssistantIndex = findLastAssistantIndex(compressed);

    const metrics: TrajectoryCompressionMetrics = {
      originalMessages: messages.length,
      compressedMessages: compressed.length,
      originalTokens,
      compressedTokens: originalTokens,
      tokensSaved: 0,
      compressionRatio: 1,
      duplicateSearchResultsRemoved: 0,
      fileSnapshotsCreated: 0,
      fileReadResultsMerged: 0,
      shellStdoutTruncated: 0,
      todoWriteResultsPreserved: countTodoWriteResults(
        compressed,
        callIndex,
        this.options,
      ),
    };

    this.replaceDuplicateSearchResults(
      compressed,
      callIndex,
      protectedStart,
      lastAssistantIndex,
      metrics,
    );
    this.mergeFileReadSnapshots(
      compressed,
      callIndex,
      protectedStart,
      lastAssistantIndex,
      metrics,
    );
    this.truncateOldShellStdout(
      compressed,
      callIndex,
      protectedStart,
      lastAssistantIndex,
      metrics,
    );

    metrics.compressedMessages = compressed.length;
    metrics.compressedTokens = estimateTotalTokens(compressed);
    metrics.tokensSaved = Math.max(0, originalTokens - metrics.compressedTokens);
    metrics.compressionRatio =
      originalTokens > 0 ? metrics.compressedTokens / originalTokens : 1;

    return { messages: compressed, metrics };
  }

  private replaceDuplicateSearchResults(
    messages: Message[],
    callIndex: Map<string, IndexedToolCall>,
    protectedStart: number,
    lastAssistantIndex: number,
    metrics: TrajectoryCompressionMetrics,
  ): void {
    const latestByKey = new Map<string, number>();

    for (let i = 0; i < messages.length; i++) {
      const key = this.searchResultKey(messages[i], callIndex);
      if (key) latestByKey.set(key, i);
    }

    for (let i = 0; i < messages.length; i++) {
      if (isProtectedMessage(messages[i], i, protectedStart, lastAssistantIndex)) {
        continue;
      }
      if (isTodoWriteResult(messages[i], callIndex, this.options)) continue;

      const key = this.searchResultKey(messages[i], callIndex);
      if (!key || latestByKey.get(key) === i) continue;

      messages[i] = {
        ...messages[i],
        content: this.options.duplicateResultPlaceholder,
      };
      metrics.duplicateSearchResultsRemoved++;
    }
  }

  private mergeFileReadSnapshots(
    messages: Message[],
    callIndex: Map<string, IndexedToolCall>,
    protectedStart: number,
    lastAssistantIndex: number,
    metrics: TrajectoryCompressionMetrics,
  ): void {
    let i = 0;
    while (i < messages.length) {
      if (
        !this.isFileReadResult(
          messages[i],
          i,
          callIndex,
          protectedStart,
          lastAssistantIndex,
        )
      ) {
        i++;
        continue;
      }

      const start = i;
      while (
        i < messages.length &&
        this.isFileReadResult(
          messages[i],
          i,
          callIndex,
          protectedStart,
          lastAssistantIndex,
        )
      ) {
        i++;
      }

      const end = i;
      if (end - start < 2) continue;

      const snapshot = this.buildFileSnapshot(messages.slice(start, end), callIndex);
      messages[start] = { ...messages[start], content: snapshot };

      for (let idx = start + 1; idx < end; idx++) {
        const call = toolCallForResult(messages[idx], callIndex);
        const path = firstString(call?.args, ["path", "file", "filePath"]) ??
          "unknown file";
        messages[idx] = {
          ...messages[idx],
          content: `[Merged into file snapshot above: ${path}]`,
        };
      }

      metrics.fileSnapshotsCreated++;
      metrics.fileReadResultsMerged += end - start;
    }
  }

  private truncateOldShellStdout(
    messages: Message[],
    callIndex: Map<string, IndexedToolCall>,
    protectedStart: number,
    lastAssistantIndex: number,
    metrics: TrajectoryCompressionMetrics,
  ): void {
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (isProtectedMessage(msg, i, protectedStart, lastAssistantIndex)) continue;
      if (isTodoWriteResult(msg, callIndex, this.options)) continue;

      const call = toolCallForResult(msg, callIndex);
      if (!call || !this.options.shellToolNames.has(call.name)) continue;
      if (typeof msg.content !== "string") continue;

      const truncated = truncateShellResultContent(
        msg.content,
        this.options.shellStdoutMaxBytes,
      );
      if (truncated === msg.content) continue;

      messages[i] = { ...msg, content: truncated };
      metrics.shellStdoutTruncated++;
    }
  }

  private searchResultKey(
    msg: Message,
    callIndex: Map<string, IndexedToolCall>,
  ): string | null {
    const call = toolCallForResult(msg, callIndex);
    if (!call || !this.options.searchToolNames.has(call.name)) return null;

    const path = firstString(call.args, [
      "path",
      "cwd",
      "directory",
      "dir",
      "root",
      "folder",
    ]);
    const query = firstString(call.args, [
      "pattern",
      "query",
      "regex",
      "regexp",
      "glob",
      "include",
    ]);

    if (!path && !query) return `${call.name}:${stableStringify(call.args)}`;
    return `${call.name}:${path ?? ""}:${query ?? ""}`;
  }

  private isFileReadResult(
    msg: Message,
    index: number,
    callIndex: Map<string, IndexedToolCall>,
    protectedStart: number,
    lastAssistantIndex: number,
  ): boolean {
    if (isProtectedMessage(msg, index, protectedStart, lastAssistantIndex)) {
      return false;
    }
    if (isTodoWriteResult(msg, callIndex, this.options)) return false;

    const call = toolCallForResult(msg, callIndex);
    return Boolean(call && this.options.fileReadToolNames.has(call.name));
  }

  private buildFileSnapshot(
    results: Message[],
    callIndex: Map<string, IndexedToolCall>,
  ): string {
    const parts = [
      `${TRAJECTORY_FILE_SNAPSHOT_HEADER}: ${results.length} consecutive file_read results`,
    ];

    for (const result of results) {
      const call = toolCallForResult(result, callIndex);
      const path = firstString(call?.args, ["path", "file", "filePath"]) ??
        "unknown file";
      const body = extractFileReadBody(result.content);
      const text = this.options.fileSnapshotMaxBytesPerFile === undefined
        ? body
        : truncateWithMarker(
          body,
          this.options.fileSnapshotMaxBytesPerFile,
          "file content",
        );

      parts.push(`--- ${path} ---\n${text}`);
    }

    return parts.join("\n\n");
  }
}

export function compressTrajectory(
  messages: Message[],
  options: TrajectoryCompressionOptions = {},
): TrajectoryCompressionResult {
  return new TrajectoryCompressor(options).compress(messages);
}

function normalizeOptions(
  options: TrajectoryCompressionOptions,
): NormalizedOptions {
  return {
    protectLastTurns: options.protectLastTurns ?? DEFAULT_PROTECT_LAST_TURNS,
    shellStdoutMaxBytes:
      options.shellStdoutMaxBytes ?? DEFAULT_SHELL_STDOUT_MAX_BYTES,
    fileSnapshotMaxBytesPerFile: options.fileSnapshotMaxBytesPerFile,
    searchToolNames: normalizeNameSet(
      options.searchToolNames ?? DEFAULT_SEARCH_TOOL_NAMES,
    ),
    fileReadToolNames: normalizeNameSet(
      options.fileReadToolNames ?? DEFAULT_FILE_READ_TOOL_NAMES,
    ),
    shellToolNames: normalizeNameSet(
      options.shellToolNames ?? DEFAULT_SHELL_TOOL_NAMES,
    ),
    todoWriteToolNames: normalizeNameSet(
      options.todoWriteToolNames ?? DEFAULT_TODO_WRITE_TOOL_NAMES,
    ),
    duplicateResultPlaceholder:
      options.duplicateResultPlaceholder ??
      TRAJECTORY_DUPLICATE_RESULT_PLACEHOLDER,
  };
}

function normalizeNameSet(names: string[]): Set<string> {
  return new Set(names.map(normalizeToolName));
}

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase().replace(/[-\s]+/g, "_");
}

function cloneMessage(msg: Message): Message {
  return {
    ...msg,
    tool_calls: msg.tool_calls?.map((tc) => ({
      ...tc,
      function: { ...tc.function },
    })),
  };
}

function buildToolCallIndex(messages: Message[]): Map<string, IndexedToolCall> {
  const result = new Map<string, IndexedToolCall>();
  for (const msg of messages) {
    if (msg.role !== "assistant" || !msg.tool_calls) continue;
    for (const call of msg.tool_calls) {
      result.set(call.id, {
        name: normalizeToolName(call.function.name),
        args: parseJsonObject(call.function.arguments),
        raw: call,
      });
    }
  }
  return result;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function findLastAssistantIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return i;
  }
  return -1;
}

function isProtectedMessage(
  msg: Message,
  index: number,
  protectedStart: number,
  lastAssistantIndex: number,
): boolean {
  return msg.role === "user" || index >= protectedStart || index === lastAssistantIndex;
}

function toolCallForResult(
  msg: Message,
  callIndex: Map<string, IndexedToolCall>,
): IndexedToolCall | null {
  if (msg.role !== "tool" || !msg.tool_call_id) return null;
  return callIndex.get(msg.tool_call_id) ?? null;
}

function isTodoWriteResult(
  msg: Message,
  callIndex: Map<string, IndexedToolCall>,
  options: NormalizedOptions,
): boolean {
  const call = toolCallForResult(msg, callIndex);
  return Boolean(call && options.todoWriteToolNames.has(call.name));
}

function countTodoWriteResults(
  messages: Message[],
  callIndex: Map<string, IndexedToolCall>,
  options: NormalizedOptions,
): number {
  let count = 0;
  for (const msg of messages) {
    if (isTodoWriteResult(msg, callIndex, options)) count++;
  }
  return count;
}

function firstString(
  obj: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function stableStringify(value: unknown): string {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(",")}}`;
}

function extractFileReadBody(content: string | null): string {
  if (content == null) return "";
  const parsed = parseJsonObject(content);
  if (typeof parsed.content === "string") return parsed.content;
  if (typeof parsed.error === "string") return `[error] ${parsed.error}`;
  return content;
}

function truncateShellResultContent(content: string, maxBytes: number): string {
  const parsed = parseJsonObject(content);
  if (typeof parsed.stdout === "string") {
    const nextStdout = truncateWithMarker(parsed.stdout, maxBytes, "stdout");
    if (nextStdout === parsed.stdout) return content;
    return JSON.stringify({ ...parsed, stdout: nextStdout });
  }

  return truncateWithMarker(content, maxBytes, "tool output");
}

function truncateWithMarker(
  text: string,
  maxBytes: number,
  label: string,
): string {
  if (maxBytes < 0 || Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }

  const kept = truncateUtf8FromEnd(text, maxBytes);
  const removed = Buffer.byteLength(text, "utf8") -
    Buffer.byteLength(kept, "utf8");
  return `[${label} truncated: removed ${removed} bytes]\n${kept}`;
}

function truncateUtf8FromEnd(text: string, maxBytes: number): string {
  let bytes = 0;
  const chars: string[] = [];
  const allChars = Array.from(text);
  for (let i = allChars.length - 1; i >= 0; i--) {
    const char = allChars[i];
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes) break;
    chars.push(char);
    bytes += size;
  }
  return chars.reverse().join("");
}
