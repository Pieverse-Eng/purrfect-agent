import { describe, it, expect, vi } from "vitest";
import {
  acpToAgent,
  agentToAcp,
  createAcpApprovalHandler,
} from "../../src/acp/tool-bridge.js";

describe("decision conversion", () => {
  it("acpToAgent maps ACP decisions to agent loop strings", () => {
    expect(acpToAgent("allow_once")).toBe("allow_once");
    expect(acpToAgent("allow_always")).toBe("allow_session");
    expect(acpToAgent("reject")).toBe("deny");
  });

  it("agentToAcp inverts the mapping", () => {
    expect(agentToAcp("allow_once")).toBe("allow_once");
    expect(agentToAcp("allow_session")).toBe("allow_always");
    expect(agentToAcp("deny")).toBe("reject");
  });
});

describe("createAcpApprovalHandler", () => {
  it("requests permission via ACP and converts the response", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ decision: "allow_once" })
      .mockResolvedValueOnce({ decision: "allow_always" })
      .mockResolvedValueOnce({ decision: "reject" });

    const handler = createAcpApprovalHandler(request);

    const a = await handler("file_write", { path: "/tmp/x" }, { reason: "first attempt" });
    expect(a).toBe("allow_once");
    expect(request).toHaveBeenLastCalledWith({
      toolCall: { name: "file_write", input: { path: "/tmp/x" }, description: "first attempt" },
      options: ["allow_once", "allow_always", "reject"],
    });

    expect(await handler("shell_exec", { cmd: "ls" })).toBe("allow_session");
    expect(await handler("shell_exec", { cmd: "rm -rf /" })).toBe("deny");
  });
});
