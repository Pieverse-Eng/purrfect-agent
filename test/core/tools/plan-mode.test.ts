import { describe, it, expect, vi } from "vitest";
import { createEnterPlanModeTool, createExitPlanModeTool } from "../../../src/core/tools/plan-mode.js";

describe("enter_plan_mode tool", () => {
  it("activates plan mode", async () => {
    let planMode = false;
    const tool = createEnterPlanModeTool({
      getPlanMode: () => planMode,
      setPlanMode: (v) => { planMode = v; },
      onExitApproval: vi.fn(),
    });

    const result = JSON.parse(await tool.handler({}));
    expect(result.plan_mode).toBe(true);
    expect(planMode).toBe(true);
  });

  it("returns already-active message when already in plan mode", async () => {
    let planMode = true;
    const tool = createEnterPlanModeTool({
      getPlanMode: () => planMode,
      setPlanMode: (v) => { planMode = v; },
      onExitApproval: vi.fn(),
    });

    const result = JSON.parse(await tool.handler({}));
    expect(result.plan_mode).toBe(true);
    expect(result.message).toContain("Already");
  });

  it("has correct name and toolset", () => {
    const tool = createEnterPlanModeTool({
      getPlanMode: () => false,
      setPlanMode: vi.fn(),
      onExitApproval: vi.fn(),
    });
    expect(tool.name).toBe("enter_plan_mode");
    expect(tool.toolset).toBe("session");
  });
});

describe("exit_plan_mode tool", () => {
  it("deactivates plan mode when approved", async () => {
    let planMode = true;
    const tool = createExitPlanModeTool({
      getPlanMode: () => planMode,
      setPlanMode: (v) => { planMode = v; },
      onExitApproval: vi.fn().mockResolvedValue(true),
    });

    const result = JSON.parse(await tool.handler({}));
    expect(result.plan_mode).toBe(false);
    expect(planMode).toBe(false);
  });

  it("stays in plan mode when denied", async () => {
    let planMode = true;
    const tool = createExitPlanModeTool({
      getPlanMode: () => planMode,
      setPlanMode: (v) => { planMode = v; },
      onExitApproval: vi.fn().mockResolvedValue(false),
    });

    const result = JSON.parse(await tool.handler({}));
    expect(result.plan_mode).toBe(true);
    expect(planMode).toBe(true);
    expect(result.message).toContain("denied");
  });

  it("returns not-in-plan-mode message when already deactivated", async () => {
    const tool = createExitPlanModeTool({
      getPlanMode: () => false,
      setPlanMode: vi.fn(),
      onExitApproval: vi.fn(),
    });

    const result = JSON.parse(await tool.handler({}));
    expect(result.plan_mode).toBe(false);
    expect(result.message).toContain("Not in Plan Mode");
  });

  it("has correct name and toolset", () => {
    const tool = createExitPlanModeTool({
      getPlanMode: () => false,
      setPlanMode: vi.fn(),
      onExitApproval: vi.fn(),
    });
    expect(tool.name).toBe("exit_plan_mode");
    expect(tool.toolset).toBe("session");
  });
});
