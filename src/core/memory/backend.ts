/**
 * Memory backend abstraction.
 *
 * Lets the agent's memory operations target either local markdown files
 * (default) or a remote HTTP service (Honcho / Mem0 / self-hosted) while
 * keeping the agent-facing memory tool interface unchanged.
 */

import { MemoryStore } from "./store.js";
import { resolveSecret, type SecretRef } from "../secrets.js";

export interface MemoryBackend {
  /** Add a new entry with the given tag and content. */
  add(tag: string, content: string): Promise<void>;
  /** Replace an existing entry. No-op if tag is missing. */
  replace(tag: string, content: string): Promise<void>;
  /** Remove an entry by tag. No-op if tag is missing. */
  remove(tag: string): Promise<void>;
  /** Snapshot used during prompt assembly (may be cached / frozen). */
  getSnapshot(): Promise<string>;
  /** Live snapshot — bypass any cache. */
  getLiveSnapshot(): Promise<string>;
}

// ── Local backend ─────────────────────────────────────────────────────────

export class LocalMarkdownBackend implements MemoryBackend {
  private readonly store: MemoryStore;

  constructor(dir: string) {
    this.store = new MemoryStore(dir);
  }

  async add(tag: string, content: string): Promise<void> {
    this.store.add(tag, content);
  }

  async replace(tag: string, content: string): Promise<void> {
    this.store.replace(tag, content);
  }

  async remove(tag: string): Promise<void> {
    this.store.remove(tag);
  }

  async getSnapshot(): Promise<string> {
    return this.store.getSnapshot();
  }

  async getLiveSnapshot(): Promise<string> {
    return this.store.getLiveSnapshot();
  }
}

// ── HTTP backend ──────────────────────────────────────────────────────────

export interface HttpMemoryBackendOptions {
  endpoint: string;
  apiKey?: string;
  /** Optional namespace passed to remote (Honcho-style user/session id). */
  namespace?: string;
  /** Override fetch (for tests). */
  fetchFn?: typeof fetch;
}

interface RemoteEntry {
  tag: string;
  content: string;
}

export class HttpMemoryBackend implements MemoryBackend {
  private readonly endpoint: string;
  private readonly apiKey: string | undefined;
  private readonly namespace: string | undefined;
  private readonly fetchFn: typeof fetch;

  constructor(opts: HttpMemoryBackendOptions) {
    this.endpoint = opts.endpoint.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.namespace = opts.namespace;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
  }

  async add(tag: string, content: string): Promise<void> {
    const res = await this.fetchFn(this.url("/entries"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ tag, content }),
    });
    if (!res.ok) throw new Error(await this.errorMessage(res, "add"));
  }

  async replace(tag: string, content: string): Promise<void> {
    const res = await this.fetchFn(this.url(`/entries/${encodeURIComponent(tag)}`), {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify({ content }),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(await this.errorMessage(res, "replace"));
    }
  }

  async remove(tag: string): Promise<void> {
    const res = await this.fetchFn(this.url(`/entries/${encodeURIComponent(tag)}`), {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(await this.errorMessage(res, "remove"));
    }
  }

  async getSnapshot(): Promise<string> {
    return this.getLiveSnapshot();
  }

  async getLiveSnapshot(): Promise<string> {
    const res = await this.fetchFn(this.url("/snapshot"), {
      method: "GET",
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(await this.errorMessage(res, "getSnapshot"));

    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const body = (await res.json()) as { snapshot?: string; entries?: RemoteEntry[] };
      if (typeof body.snapshot === "string") return body.snapshot;
      if (Array.isArray(body.entries)) {
        return body.entries
          .map((e) => `§ ${e.tag}\n${e.content}`)
          .join("\n\n");
      }
      return "";
    }
    return await res.text();
  }

  private url(path: string): string {
    const ns = this.namespace ? `?namespace=${encodeURIComponent(this.namespace)}` : "";
    return `${this.endpoint}${path}${ns}`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  private async errorMessage(res: Response, op: string): Promise<string> {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.text();
      if (body) detail += ` — ${body.slice(0, 200)}`;
    } catch {
      // ignore
    }
    return `Memory backend ${op} failed: ${detail}`;
  }
}

// ── Factory ──────────────────────────────────────────────────────────────

export interface MemoryBackendConfig {
  backend?: "local" | "http";
  endpoint?: string;
  /** Plain string or SecretRef ({ env: "..." } / { file: "..." }). */
  apiKey?: SecretRef;
  namespace?: string;
}

export interface CreateMemoryBackendOptions {
  /** Local backend uses this directory. */
  dir: string;
  /** Optional config selecting + parameterizing the backend. */
  config?: MemoryBackendConfig;
  /** Override fetch (for tests, only used by HTTP backend). */
  fetchFn?: typeof fetch;
}

export function createMemoryBackend(opts: CreateMemoryBackendOptions): MemoryBackend {
  const cfg = opts.config ?? {};
  if (cfg.backend === "http") {
    if (!cfg.endpoint) {
      throw new Error("memory.endpoint is required when memory.backend=http");
    }
    return new HttpMemoryBackend({
      endpoint: cfg.endpoint,
      apiKey: cfg.apiKey === undefined ? undefined : resolveSecret(cfg.apiKey),
      namespace: cfg.namespace,
      fetchFn: opts.fetchFn,
    });
  }
  return new LocalMarkdownBackend(opts.dir);
}
