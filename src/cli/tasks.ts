/**
 * Task CLI formatting — render task lists and task output for terminal display.
 */

import { existsSync, readFileSync } from "node:fs";
import type { TaskRecord } from "../core/tasks/store.js";

/**
 * Format a list of tasks for terminal display.
 * Shows id (truncated), status, and prompt for each task.
 */
export function formatTaskList(tasks: TaskRecord[]): string {
  if (tasks.length === 0) {
    return "No tasks found.";
  }

  const lines: string[] = ["\nTasks:\n"];
  for (const t of tasks) {
    const id = t.id.slice(0, 12);
    const status = t.status.padEnd(10);
    const prompt = t.prompt.length > 60 ? t.prompt.slice(0, 57) + "..." : t.prompt;
    lines.push(`  ${id}  ${status}  ${prompt}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Read output lines from a task's output.jsonl file.
 * Returns display-friendly lines extracted from JSONL events.
 */
export function readTaskOutputLines(outputPath: string): string[] {
  if (!existsSync(outputPath)) {
    return [];
  }

  const raw = readFileSync(outputPath, "utf-8").trim();
  if (!raw) return [];

  const lines: string[] = [];
  for (const line of raw.split("\n")) {
    try {
      const event = JSON.parse(line);
      if (event.type === "text_delta" && event.content) {
        lines.push(event.content);
      } else if (event.type === "completion" && event.content) {
        lines.push(event.content);
      } else if (event.type === "tool_call_start" && event.toolCall?.function?.name) {
        lines.push(`[tool] ${event.toolCall.function.name}`);
      } else if (event.type === "tool_result") {
        lines.push(`[result] ${event.name}: ${(event.result ?? "").slice(0, 200)}`);
      } else if (event.type === "error") {
        lines.push(`[error] ${event.error}`);
      }
    } catch {
      // Skip malformed lines
    }
  }
  return lines;
}

/**
 * Format a single task's output lines for terminal display.
 */
export function formatTaskOutput(task: TaskRecord, outputLines: string[]): string {
  const lines: string[] = [];
  lines.push(`\nTask ${task.id}  [${task.status}]`);
  lines.push(`Prompt: ${task.prompt}`);
  lines.push("");

  if (outputLines.length === 0) {
    lines.push("  (no output)");
  } else {
    for (const line of outputLines) {
      lines.push(`  ${line}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}
