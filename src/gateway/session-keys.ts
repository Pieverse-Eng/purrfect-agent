/**
 * Session key construction and reset policy logic.
 */

import type { SessionSource } from "./adapter.js";

// ---------------------------------------------------------------------------
// Session key builder
// ---------------------------------------------------------------------------

/**
 * Build a deterministic session key from a message source.
 *
 * Format: `platform:chatType:chatId[:threadId][:userId]`
 *
 * - DMs always include userId (a DM *is* per-user by definition).
 * - Groups / channels include userId only when `groupPerUser` is true (default).
 */
export function buildSessionKey(
  source: SessionSource,
  groupPerUser: boolean = true,
): string {
  const parts: string[] = [source.platform, source.chatType, source.chatId];

  if (source.threadId) {
    parts.push(source.threadId);
  }

  const includeUser =
    source.chatType === "dm" || groupPerUser;

  if (includeUser) {
    parts.push(source.userId);
  }

  return parts.join(":");
}

// ---------------------------------------------------------------------------
// Session reset policy
// ---------------------------------------------------------------------------

export interface SessionResetPolicy {
  mode: "daily" | "idle" | "both" | "none";
  idleMinutes: number;
  dailyResetHour: number;
}

/**
 * Determine whether the session should be reset based on the policy.
 *
 * @param lastActivity  Timestamp (ms) of the last user activity in this session.
 * @param policy        The reset policy to evaluate.
 * @returns `true` if the session should be reset.
 */
export function shouldResetSession(
  lastActivity: number,
  policy: SessionResetPolicy,
): boolean {
  if (policy.mode === "none") return false;

  const now = Date.now();

  // Idle check
  if (policy.mode === "idle" || policy.mode === "both") {
    const idleMs = policy.idleMinutes * 60 * 1000;
    if (now - lastActivity >= idleMs) return true;
  }

  // Daily check
  if (policy.mode === "daily" || policy.mode === "both") {
    const lastDate = new Date(lastActivity);
    const nowDate = new Date(now);

    // Did we cross the reset hour boundary since lastActivity?
    const resetToday = new Date(nowDate);
    resetToday.setHours(policy.dailyResetHour, 0, 0, 0);

    if (lastActivity < resetToday.getTime() && now >= resetToday.getTime()) {
      return true;
    }
  }

  return false;
}
