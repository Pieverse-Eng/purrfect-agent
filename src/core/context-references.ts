import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "./types.js";

export const DEFAULT_CONTEXT_REFERENCE_THRESHOLD_BYTES = 4 * 1024;
export const CONTEXT_REFERENCE_SCHEME = "ref://tool-result/";

export interface ContextReferenceStoreOptions {
  baseDir?: string;
  thresholdBytes?: number;
}

export interface MaterializeToolResultOptions {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  content: string;
}

export interface ContextReference {
  uri: string;
  bytes: number;
  sha256: string;
  path: string;
}

export interface MaterializedToolResult {
  content: string;
  reference?: ContextReference;
}

/**
 * Stores large tool results outside the active model context and returns a
 * compact, addressable placeholder. The full bytes are recoverable through
 * `read_ref` or direct store resolution.
 */
export class ContextReferenceStore {
  readonly baseDir: string;
  readonly thresholdBytes: number;

  constructor(options: ContextReferenceStoreOptions = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), ".purrfect", "refs");
    this.thresholdBytes =
      options.thresholdBytes ?? DEFAULT_CONTEXT_REFERENCE_THRESHOLD_BYTES;
  }

  async materializeToolResult(
    options: MaterializeToolResultOptions,
  ): Promise<MaterializedToolResult> {
    const bytes = Buffer.byteLength(options.content, "utf8");
    if (bytes <= this.thresholdBytes) {
      return { content: options.content };
    }

    const sessionId = sanitizeSegment(options.sessionId, "sessionId");
    const toolCallId = sanitizeSegment(options.toolCallId, "toolCallId");
    const dir = join(this.baseDir, sessionId);
    const path = join(dir, `${toolCallId}.bin`);
    const sha256 = createHash("sha256").update(options.content).digest("hex");
    const uri = `${CONTEXT_REFERENCE_SCHEME}${sessionId}/${toolCallId}`;

    await mkdir(dir, { recursive: true });
    await writeFile(path, options.content, "utf8");

    return {
      content: JSON.stringify({
        ref: uri,
        bytes,
      }),
      reference: { uri, bytes, sha256, path },
    };
  }

  async resolve(uri: string): Promise<string> {
    const parsed = parseToolResultRef(uri);
    const path = join(this.baseDir, parsed.sessionId, `${parsed.toolCallId}.bin`);
    return readFile(path, "utf8");
  }
}

export function parseToolResultRef(uri: string): {
  sessionId: string;
  toolCallId: string;
} {
  if (!uri.startsWith(CONTEXT_REFERENCE_SCHEME)) {
    throw new Error(`Unsupported reference URI: ${uri}`);
  }

  const rest = uri.slice(CONTEXT_REFERENCE_SCHEME.length);
  const parts = rest.split("/");
  if (parts.length !== 2) {
    throw new Error(`Invalid tool-result reference URI: ${uri}`);
  }

  return {
    sessionId: sanitizeSegment(parts[0], "sessionId"),
    toolCallId: sanitizeSegment(parts[1], "toolCallId"),
  };
}

export function createReadRefTool(store = new ContextReferenceStore()): ToolDefinition {
  return {
    name: "read_ref",
    description: "Resolve a ref://tool-result/... context reference and return the stored content.",
    schema: {
      type: "function",
      function: {
        name: "read_ref",
        description: "Resolve a ref://tool-result/... context reference and return the stored content.",
        parameters: {
          type: "object",
          properties: {
            uri: {
              type: "string",
              description: "Reference URI, for example ref://tool-result/<session>/<tool-call-id>.",
            },
          },
          required: ["uri"],
        },
      },
    },
    toolset: "context",
    async handler(args) {
      const uri = args.uri;
      if (typeof uri !== "string" || uri.length === 0) {
        return JSON.stringify({ error: "uri is required" });
      }

      try {
        const content = await store.resolve(uri);
        return JSON.stringify({ uri, content });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: message });
      }
    },
  };
}

function sanitizeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`${label} must contain only letters, numbers, dots, underscores, and hyphens`);
  }
  if (value === "." || value === ".." || value.includes("..")) {
    throw new Error(`${label} must not contain path traversal`);
  }
  return value;
}
