/**
 * Gateway CLI — format adapter health snapshots for terminal display.
 */

import type { AdapterHealth } from "../gateway/health.js";

/**
 * Format a health snapshot as a terminal-friendly table string.
 */
export function formatGatewayStatus(snapshot: AdapterHealth[]): string {
  if (snapshot.length === 0) {
    return "No adapters registered.";
  }

  const header = "Platform     Status       Messages  Reconnects  Uptime (s)";
  const sep    = "───────────  ───────────  ────────  ──────────  ──────────";

  const rows = snapshot.map((s) => {
    const platform = s.platform.padEnd(11);
    const status = (s.connected ? "connected" : "disconnected").padEnd(11);
    const msgs = String(s.messageCount).padStart(8);
    const reconnects = String(s.reconnectAttempts).padStart(10);
    const uptime = String(Math.round(s.uptime / 1000)).padStart(10);
    return `${platform}  ${status}  ${msgs}  ${reconnects}  ${uptime}`;
  });

  return [header, sep, ...rows].join("\n");
}
