import type { CacheStats } from "../core/cache-stats.js";

// ── Token display ──────────────────────────────────────────────────

/**
 * Format a human-readable token summary.
 * Returns e.g. "[tokens: 150/50]" or "[tokens: 150/50 | cache: 80%]".
 */
export function formatTokenDisplay(
  promptTokens: number,
  completionTokens: number,
  cacheStats?: CacheStats,
): string {
  let out = `[tokens: ${promptTokens}/${completionTokens}`;
  if (cacheStats) {
    const pct = Math.round(cacheStats.hitRate() * 100);
    out += ` | cache: ${pct}%`;
  }
  out += "]";
  return out;
}

// ── Cost estimation ────────────────────────────────────────────────

/** Rough per-1K-token rates (input / output) in USD. */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-20250514": { input: 0.003, output: 0.015 },
  "claude-3-5-sonnet-20241022": { input: 0.003, output: 0.015 },
  "claude-3-opus-20240229": { input: 0.015, output: 0.075 },
  "claude-3-haiku-20240307": { input: 0.00025, output: 0.00125 },
  "gpt-4o": { input: 0.005, output: 0.015 },
  "gpt-4o-mini": { input: 0.00015, output: 0.0006 },
};

const DEFAULT_PRICING = { input: 0.003, output: 0.015 };

/**
 * Estimate cost string like "~$0.03".
 */
export function formatCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): string {
  const pricing = MODEL_PRICING[model] ?? DEFAULT_PRICING;
  const cost =
    (promptTokens / 1000) * pricing.input +
    (completionTokens / 1000) * pricing.output;
  return `~$${cost.toFixed(2)}`;
}

// ── ANSI colors ────────────────────────────────────────────────────

const ANSI_CODES: Record<string, number> = {
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
};

/** Wrap `text` with ANSI escape codes for the given color. */
export function ansiColor(text: string, color: string): string {
  const code = ANSI_CODES[color] ?? 37;
  return `\x1b[${code}m${text}\x1b[0m`;
}

// ── Tool call / result / error display ─────────────────────────────

/**
 * Format a tool invocation for display: colored name + compact JSON args preview.
 */
export function formatToolCall(
  name: string,
  args: Record<string, unknown>,
): string {
  const colored = ansiColor(name, "cyan");
  const preview = JSON.stringify(args);
  return `${colored} ${ansiColor(preview, "gray")}`;
}

/**
 * Format a tool result with a status icon and optional truncation.
 * @param maxLen  Maximum length of the result preview (default 200).
 */
export function formatToolResult(
  name: string,
  result: string,
  maxLen = 200,
): string {
  const icon = ansiColor("✔", "green");
  const preview =
    result.length > maxLen ? result.slice(0, maxLen) + "…" : result;
  return `${icon} ${ansiColor(name, "cyan")}: ${preview}`;
}

/**
 * Format an error message in red with a cross icon.
 */
export function formatError(message: string): string {
  return ansiColor(`✖ ${message}`, "red");
}

// ── Todo list rendering ───────────────────────────────────────────

interface TodoLike {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

/**
 * Render a todo list as a bordered box with colored status glyphs.
 * Used by REPL/oneshot to display the session task list after todo_write.
 */
export function formatTodoList(todos: TodoLike[]): string {
  const title = "Task List";
  if (todos.length === 0) {
    return ansiColor(`┏━ ${title} ━┓\n┃ (empty)     ┃\n┗━━━━━━━━━━━━┛`, "gray");
  }

  const rows = todos.map((t) => {
    switch (t.status) {
      case "completed":
        return `${ansiColor("✔", "green")} ${ansiColor(t.content, "gray")}`;
      case "in_progress":
        return `${ansiColor("●", "yellow")} ${ansiColor(
          t.activeForm ?? t.content,
          "yellow",
        )}`;
      default:
        return `${ansiColor("○", "gray")} ${t.content}`;
    }
  });

  const contentWidth = Math.max(
    title.length + 2,
    ...rows.map((r) => stripAnsi(r).length),
  );
  const horiz = "━".repeat(contentWidth + 2);
  const pad = (s: string): string =>
    " " + s + " ".repeat(contentWidth - stripAnsi(s).length) + " ";

  const lines = [
    ansiColor(`┏${horiz}┓`, "cyan"),
    ansiColor("┃", "cyan") +
      pad(ansiColor(title, "cyan")) +
      ansiColor("┃", "cyan"),
    ansiColor(`┠${horiz}┨`, "cyan"),
    ...rows.map((r) => ansiColor("┃", "cyan") + pad(r) + ansiColor("┃", "cyan")),
    ansiColor(`┗${horiz}┛`, "cyan"),
  ];
  return lines.join("\n");
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ── Spinner ────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Returns a simple terminal spinner { start(), stop() }.
 */
export function spinner(): { start(): void; stop(): void } {
  let timer: ReturnType<typeof setInterval> | null = null;
  let frame = 0;

  return {
    start() {
      if (timer) return;
      frame = 0;
      timer = setInterval(() => {
        process.stderr.write(`\r${SPINNER_FRAMES[frame++ % SPINNER_FRAMES.length]} `);
      }, 80);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        process.stderr.write("\r  \r");
      }
    },
  };
}
