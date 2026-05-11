import { describe, it, expect } from "vitest";
import { shellExecTool } from "../../src/core/tools/shell-exec.js";

describe("shellExecTool", () => {
  it("rejects non-positive timeout values", async () => {
    const result = await shellExecTool.handler({
      command: "/usr/bin/printf ok",
      timeout_ms: 0,
    });

    expect(JSON.parse(result)).toEqual({
      error: "timeout_ms must be a positive finite number",
    });
  });
});
