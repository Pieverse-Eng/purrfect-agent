/**
 * Bearer token authentication for the API server.
 */

import type { IncomingMessage } from "node:http";

/**
 * Authenticate an incoming HTTP request by checking the Authorization header
 * against the expected bearer token.
 *
 * @returns `true` if the token matches, `false` otherwise.
 */
export function authenticate(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (!header) return false;

  const parts = header.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return false;

  return parts[1] === token;
}
