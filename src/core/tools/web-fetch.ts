import type { ToolDefinition } from "../types.js";
import { sanitizeToolResultObject } from "../safety/redact.js";
import { checkUrlPolicy } from "../safety/url-policy.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export const webFetchTool: ToolDefinition = {
  name: "web_fetch",
  description: "Fetch a URL and return the response body.",
  schema: {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch a URL and return the response body.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to fetch." },
          method: { type: "string", description: "HTTP method (default GET)." },
          timeout_ms: {
            type: "number",
            description: "Timeout in milliseconds (default 30000).",
          },
        },
        required: ["url"],
      },
    },
  },
  toolset: "web",
  async handler(args) {
    const url = args.url as string;
    const method = (args.method as string | undefined) ?? "GET";
    const timeout = (args.timeout_ms as number | undefined) ?? DEFAULT_TIMEOUT_MS;
    const policy = checkUrlPolicy(url);
    if (!policy.allowed) {
      return JSON.stringify({
        error: `URL blocked: ${policy.reason ?? "policy denied"}`,
        safety: {
          action: "block",
          findings: policy.findings,
          redactions: [],
        },
      });
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, {
        method,
        signal: controller.signal,
      });
      clearTimeout(timer);

      const body = await response.text();
      return JSON.stringify(sanitizeToolResultObject({
        status: response.status,
        body,
      }));
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return JSON.stringify(sanitizeToolResultObject({ error: "Timeout: request exceeded time limit" }));
      }
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify(sanitizeToolResultObject({ error: message }));
    }
  },
};
