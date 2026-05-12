/**
 * Tool bridge — adapts the purrfect agent loop's `onApprovalRequired` callback
 * to ACP `session/request_permission` round-trips.
 *
 * AgentLoop signature:
 *   (toolName, args, ctx?) => Promise<"allow_once" | "allow_session" | "deny">
 *
 * ACP signature:
 *   request_permission({ toolCall, options }) → { decision: "allow_once" | "allow_always" | "reject" }
 *
 * Mapping is straightforward — `allow_always` ↔ `allow_session`, `reject` ↔ `deny`.
 */

import type { PermissionRequest, PermissionResponse } from "./session-adapter.js";

export type AgentApprovalDecision = "allow_once" | "allow_session" | "deny";

export type RequestPermissionFn = (
  req: Omit<PermissionRequest, "sessionId">,
) => Promise<PermissionResponse>;

/**
 * Build an `onApprovalRequired` callback that surfaces approval prompts via
 * the editor's ACP `session/request_permission` request.
 */
export function createAcpApprovalHandler(
  request: RequestPermissionFn,
): (toolName: string, args: Record<string, unknown>, ctx?: { reason?: string }) => Promise<AgentApprovalDecision> {
  return async (toolName, args, ctx) => {
    const response = await request({
      toolCall: { name: toolName, input: args, description: ctx?.reason },
      options: ["allow_once", "allow_always", "reject"],
    });
    return acpToAgent(response.decision);
  };
}

export function acpToAgent(decision: PermissionResponse["decision"]): AgentApprovalDecision {
  switch (decision) {
    case "allow_once":
      return "allow_once";
    case "allow_always":
      return "allow_session";
    case "reject":
    default:
      return "deny";
  }
}

export function agentToAcp(decision: AgentApprovalDecision): PermissionResponse["decision"] {
  switch (decision) {
    case "allow_once":
      return "allow_once";
    case "allow_session":
      return "allow_always";
    case "deny":
    default:
      return "reject";
  }
}
