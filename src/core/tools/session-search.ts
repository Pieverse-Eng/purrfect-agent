import type { ToolDefinition } from "../types.js";
import type { SessionStore } from "../session-store.js";

/**
 * Factory that creates a session_search tool bound to a given SessionStore.
 *
 * The tool accepts { query: string } and returns JSON with matching messages
 * including session_id and timestamp.
 */
export function createSessionSearchTool(store: SessionStore): ToolDefinition {
  return {
    name: "session_search",
    description:
      "Search past session messages by keyword. Returns matching messages with session_id and timestamp.",
    schema: {
      type: "function",
      function: {
        name: "session_search",
        description:
          "Search past session messages by keyword. Returns matching messages with session_id and timestamp.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The search query to match against message content.",
            },
          },
          required: ["query"],
        },
      },
    },
    toolset: "session",
    async handler(args) {
      const query = (args.query as string | undefined) ?? "";
      if (!query.trim()) {
        return JSON.stringify({ matches: [] });
      }

      try {
        const results = store.search(query);
        const matches = results.map((r) => ({
          message_id: r.message_id,
          session_id: r.session_id,
          role: r.role,
          content: r.content,
          timestamp: r.timestamp,
        }));
        return JSON.stringify({ matches });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: message });
      }
    },
  };
}
