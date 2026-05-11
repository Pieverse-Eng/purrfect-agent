import { describe, it, expect } from "vitest";
import { parseArgs } from "../../src/cli/index.js";
import { HealthMonitor } from "../../src/gateway/health.js";
import { formatGatewayStatus } from "../../src/cli/gateway.js";

// ── parseArgs: gateway ─────────────────────────────────────────────────

describe("parseArgs: gateway subcommand", () => {
  it("parses 'gateway start' into command with action", () => {
    const result = parseArgs(["node", "purrfect", "gateway", "start"]);
    expect(result).toEqual({ command: "gateway", action: "start" });
  });
});

// ── HealthMonitor ──────────────────────────────────────────────────────

describe("HealthMonitor: adapter state tracking", () => {
  it("snapshot reflects connect, messages, and disconnect", () => {
    const monitor = new HealthMonitor();

    monitor.recordConnect("telegram");
    monitor.recordMessage("telegram");
    monitor.recordMessage("telegram");
    monitor.recordError("discord", "token invalid");
    monitor.recordConnect("discord");

    const snap = monitor.getSnapshot();
    const tg = snap.find((s) => s.platform === "telegram")!;
    const dc = snap.find((s) => s.platform === "discord")!;

    expect(tg.connected).toBe(true);
    expect(tg.messageCount).toBe(2);
    expect(tg.reconnectAttempts).toBe(0);

    expect(dc.connected).toBe(true);
    expect(dc.lastError).toBe("token invalid");
    // recordConnect resets reconnectAttempts
    expect(dc.reconnectAttempts).toBe(0);
  });
});

// ── Backoff calculation ────────────────────────────────────────────────

describe("HealthMonitor.calculateBackoff", () => {
  it("calculates exponential backoff correctly", () => {
    expect(HealthMonitor.calculateBackoff(0)).toBe(5000);   // 5000 * 2^0
    expect(HealthMonitor.calculateBackoff(1)).toBe(10000);  // 5000 * 2^1
    expect(HealthMonitor.calculateBackoff(3)).toBe(40000);  // 5000 * 2^3
  });

  it("caps backoff at maxMs", () => {
    // 5000 * 2^10 = 5_120_000, capped at 300_000
    expect(HealthMonitor.calculateBackoff(10)).toBe(300000);
    expect(HealthMonitor.calculateBackoff(20)).toBe(300000);
  });
});

// ── formatGatewayStatus ────────────────────────────────────────────────

describe("formatGatewayStatus: terminal table", () => {
  it("renders a table with header and adapter rows", () => {
    const snapshot = [
      {
        platform: "telegram",
        connected: true,
        uptime: 60000,
        messageCount: 42,
        reconnectAttempts: 0,
      },
      {
        platform: "discord",
        connected: false,
        uptime: 0,
        messageCount: 0,
        lastError: "timeout",
        reconnectAttempts: 3,
      },
    ];

    const output = formatGatewayStatus(snapshot);
    const lines = output.split("\n");

    // Header + separator + 2 data rows
    expect(lines.length).toBe(4);
    expect(lines[0]).toContain("Platform");
    expect(lines[0]).toContain("Status");
    expect(lines[2]).toContain("telegram");
    expect(lines[2]).toContain("connected");
    expect(lines[2]).toContain("42");
    expect(lines[3]).toContain("discord");
    expect(lines[3]).toContain("disconnected");
    expect(lines[3]).toContain("3");
  });
});
