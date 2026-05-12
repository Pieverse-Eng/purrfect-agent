/**
 * Plan Mode tools — enter_plan_mode / exit_plan_mode.
 *
 * These tools allow the agent (or the user via --plan flag) to toggle
 * read-only planning mode.  While active, mutating tools are filtered
 * out by the AgentLoop so the agent can only inspect the codebase.
 *
 * Exiting plan mode requires human approval via an interactive prompt.
 */

import type { ToolDefinition } from "../types.js";
import { planModeAllowedToolList, planModeBlockedToolList } from "../plan-mode.js";

export interface PlanModeToolOptions {
  getPlanMode: () => boolean;
  setPlanMode: (value: boolean) => void;
  /** Called when the agent requests to exit plan mode. Must return true to allow. */
  onExitApproval: () => Promise<boolean>;
}

export function createEnterPlanModeTool(
  options: PlanModeToolOptions,
): ToolDefinition {
  return {
    name: "enter_plan_mode",
    description:
      `Activate Plan Mode. While active only read-only tools (${planModeAllowedToolList()}) ` +
      "are available. Use this before producing a plan so that no mutations occur accidentally.",
    schema: {
      type: "function",
      function: {
        name: "enter_plan_mode",
        description:
          "Activate Plan Mode — restricts the session to read-only tools.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    },
    handler: async () => {
      if (options.getPlanMode()) {
        return JSON.stringify({
          plan_mode: true,
          message: "Already in Plan Mode.",
        });
      }
      options.setPlanMode(true);
      return JSON.stringify({
        plan_mode: true,
        message:
          `Plan Mode activated. Mutating tools (${planModeBlockedToolList()}) are now disabled. ` +
          "Produce your plan, then call exit_plan_mode when ready to execute.",
      });
    },
    toolset: "session",
  };
}

export function createExitPlanModeTool(
  options: PlanModeToolOptions,
): ToolDefinition {
  return {
    name: "exit_plan_mode",
    description:
      "Request to leave Plan Mode. Triggers a human approval prompt — " +
      "if approved, all tools are restored; if denied, Plan Mode stays active.",
    schema: {
      type: "function",
      function: {
        name: "exit_plan_mode",
        description:
          "Request to exit Plan Mode and restore mutating tools (requires human approval).",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    },
    handler: async () => {
      if (!options.getPlanMode()) {
        return JSON.stringify({
          plan_mode: false,
          message: "Not in Plan Mode — nothing to exit.",
        });
      }

      const approved = await options.onExitApproval();
      if (approved) {
        options.setPlanMode(false);
        return JSON.stringify({
          plan_mode: false,
          message: "Plan Mode deactivated. All tools are now available.",
        });
      }

      return JSON.stringify({
        plan_mode: true,
        message:
          "Exit denied — Plan Mode remains active. Revise your plan and try again.",
      });
    },
    toolset: "session",
  };
}
