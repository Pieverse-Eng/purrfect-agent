import { describe, it, expect, vi } from "vitest";
import {
  formatToolCall,
  formatToolResult,
  formatError,
  ansiColor,
} from "../../src/cli/formatter.js";

describe("Rich TUI formatters", () => {
  it("formatToolCall renders colored name + args preview", () => {
    const result = formatToolCall("readFile", { path: "/tmp/foo.txt" });
    // Should contain the tool name wrapped in cyan ANSI
    expect(result).toContain(ansiColor("readFile", "cyan"));
    // Should contain a preview of the args
    expect(result).toContain("/tmp/foo.txt");
  });

  it("formatToolResult truncates long output", () => {
    const longOutput = "x".repeat(500);
    const result = formatToolResult("readFile", longOutput);
    // Default maxLen is 200; result should be truncated
    expect(result.length).toBeLessThan(longOutput.length);
    expect(result).toContain("…");
    // Should contain a success marker (green check)
    expect(result).toContain(ansiColor("✔", "green"));
    expect(result).toContain("readFile");
  });

  it("formatToolResult truncates to configurable limit", () => {
    const longOutput = "abcdefghij".repeat(10); // 100 chars
    const result50 = formatToolResult("myTool", longOutput, 50);
    // The preview portion should be at most 50 chars + ellipsis
    expect(result50).toContain("…");
    const result200 = formatToolResult("myTool", longOutput, 200);
    // 100 chars fits within 200, so no truncation
    expect(result200).not.toContain("…");
  });

  it("formatError wraps message in red ANSI", () => {
    const result = formatError("something went wrong");
    expect(result).toBe(ansiColor("✖ something went wrong", "red"));
  });

  it("spinner start/stop lifecycle (mock @clack)", async () => {
    // We test our own spinner helper from formatter.ts
    const writeStub = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const { spinner } = await import("../../src/cli/formatter.js");
    const s = spinner();
    s.start();
    // Let one frame tick
    await new Promise((r) => setTimeout(r, 100));
    s.stop();

    // start should have written at least one spinner frame
    expect(writeStub).toHaveBeenCalled();
    const calls = writeStub.mock.calls.map((c) => String(c[0]));
    // At least one frame character and the clear sequence on stop
    expect(calls.some((c) => c.includes("\r"))).toBe(true);

    writeStub.mockRestore();
  });
});
