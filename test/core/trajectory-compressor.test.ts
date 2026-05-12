import { describe, it, expect } from "vitest";
import {
  TRAJECTORY_DUPLICATE_RESULT_PLACEHOLDER,
  TRAJECTORY_FILE_SNAPSHOT_HEADER,
  compressTrajectory,
} from "../../src/core/trajectory-compressor.js";
import type { Message, ToolCall } from "../../src/core/types.js";

function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

function assistantCall(...calls: ToolCall[]): Message {
  return { role: "assistant", content: null, tool_calls: calls };
}

function toolResult(id: string, content: unknown): Message {
  return {
    role: "tool",
    tool_call_id: id,
    content: typeof content === "string" ? content : JSON.stringify(content),
  };
}

describe("compressTrajectory", () => {
  it("replaces older duplicate grep results for the same path and query", () => {
    const messages: Message[] = [
      { role: "user", content: "Find router references." },
      assistantCall(toolCall("grep_1", "grep", { path: "src/core", pattern: "router" })),
      toolResult("grep_1", "old large grep output"),
      { role: "assistant", content: "I saw router references." },
      assistantCall(toolCall("grep_2", "grep", { path: "src/core", pattern: "router" })),
      toolResult("grep_2", "newer grep output"),
      { role: "assistant", content: "Final answer." },
    ];

    const result = compressTrajectory(messages, { protectLastTurns: 1 });

    expect(result.messages[0]).toEqual(messages[0]);
    expect(result.messages.at(-1)).toEqual(messages.at(-1));
    expect(result.messages.find((m) => m.tool_call_id === "grep_1")?.content)
      .toContain(TRAJECTORY_DUPLICATE_RESULT_PLACEHOLDER);
    expect(result.messages.find((m) => m.tool_call_id === "grep_2")?.content)
      .toBe("newer grep output");
    expect(result.metrics.duplicateSearchResultsRemoved).toBe(1);
  });

  it("merges consecutive file_read results into a single file snapshot", () => {
    const messages: Message[] = [
      { role: "user", content: "Read these files." },
      assistantCall(
        toolCall("read_1", "file_read", { path: "/repo/src/a.ts" }),
        toolCall("read_2", "file_read", { path: "/repo/src/b.ts" }),
      ),
      toolResult("read_1", { content: "export const a = 1;\n" }),
      toolResult("read_2", { content: "export const b = 2;\n" }),
      { role: "assistant", content: "Final answer includes both files." },
    ];

    const result = compressTrajectory(messages, { protectLastTurns: 1 });
    const firstRead = result.messages.find((m) => m.tool_call_id === "read_1");
    const secondRead = result.messages.find((m) => m.tool_call_id === "read_2");

    expect(firstRead?.content).toContain(TRAJECTORY_FILE_SNAPSHOT_HEADER);
    expect(firstRead?.content).toContain("/repo/src/a.ts");
    expect(firstRead?.content).toContain("export const a = 1;");
    expect(firstRead?.content).toContain("/repo/src/b.ts");
    expect(firstRead?.content).toContain("export const b = 2;");
    expect(secondRead?.content).toContain("Merged into file snapshot above");
    expect(result.messages.at(-1)).toEqual(messages.at(-1));
    expect(result.metrics.fileSnapshotsCreated).toBe(1);
    expect(result.metrics.fileReadResultsMerged).toBe(2);
  });

  it("truncates old shell stdout while preserving recent shell output and final assistant text", () => {
    const oldStdout = `${"old-".repeat(40)}FAIL: final-status`;
    const recentStdout = "recent-".repeat(40);
    const messages: Message[] = [
      { role: "user", content: "Run the old command." },
      assistantCall(toolCall("shell_old", "shell_exec", { command: "npm test" })),
      toolResult("shell_old", { stdout: oldStdout, stderr: "" }),
      { role: "assistant", content: "Old command finished." },
      { role: "user", content: "Run it again." },
      assistantCall(toolCall("shell_recent", "shell_exec", { command: "npm test" })),
      toolResult("shell_recent", { stdout: recentStdout, stderr: "" }),
      { role: "assistant", content: "Final result uses the recent output." },
    ];

    const result = compressTrajectory(messages, {
      protectLastTurns: 3,
      shellStdoutMaxBytes: 32,
    });

    const oldResult = JSON.parse(
      result.messages.find((m) => m.tool_call_id === "shell_old")?.content ?? "{}",
    ) as { stdout: string };
    const recentResult = JSON.parse(
      result.messages.find((m) => m.tool_call_id === "shell_recent")?.content ?? "{}",
    ) as { stdout: string };

    expect(oldResult.stdout).toContain("[stdout truncated");
    expect(oldResult.stdout.length).toBeLessThan(oldStdout.length);
    expect(oldResult.stdout).toContain("FAIL: final-status");
    expect(recentResult.stdout).toBe(recentStdout);
    expect(result.messages[0]).toEqual(messages[0]);
    expect(result.messages[4]).toEqual(messages[4]);
    expect(result.messages.at(-1)).toEqual(messages.at(-1));
    expect(result.metrics.shellStdoutTruncated).toBe(1);
  });

  it("never rewrites todo_write tool results", () => {
    const todoContent = JSON.stringify({
      success: true,
      rendered: "[~] Implement trajectory compressor\n[ ] Run tests",
      todos: [
        {
          content: "Implement trajectory compressor",
          status: "in_progress",
          activeForm: "Implementing trajectory compressor",
        },
      ],
    });
    const messages: Message[] = [
      { role: "user", content: "Handle issue 80." },
      assistantCall(toolCall("todo_1", "todo_write", { todos: [] })),
      toolResult("todo_1", todoContent),
      assistantCall(toolCall("grep_1", "grep", { path: "src", pattern: "compressor" })),
      toolResult("grep_1", "first grep"),
      assistantCall(toolCall("grep_2", "grep", { path: "src", pattern: "compressor" })),
      toolResult("grep_2", "second grep"),
      { role: "assistant", content: "Done." },
    ];

    const result = compressTrajectory(messages, { protectLastTurns: 1 });

    expect(result.messages.find((m) => m.tool_call_id === "todo_1")?.content)
      .toBe(todoContent);
    expect(result.metrics.todoWriteResultsPreserved).toBe(1);
  });
});
