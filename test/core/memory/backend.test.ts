import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createMemoryBackend,
  HttpMemoryBackend,
  LocalMarkdownBackend,
} from "../../../src/core/memory/backend.js";

describe("LocalMarkdownBackend", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memory-local-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes, reads, replaces, and removes entries", async () => {
    const backend = new LocalMarkdownBackend(dir);
    await backend.add("note", "hello");
    let snap = await backend.getSnapshot();
    expect(snap).toContain("§ note");
    expect(snap).toContain("hello");

    await backend.replace("note", "world");
    snap = await backend.getLiveSnapshot();
    expect(snap).toContain("world");
    expect(snap).not.toContain("hello");

    await backend.remove("note");
    snap = await backend.getLiveSnapshot();
    expect(snap).not.toContain("§ note");
  });

  it("persists to MEMORY.md on disk", async () => {
    const backend = new LocalMarkdownBackend(dir);
    await backend.add("k", "v");
    const onDisk = readFileSync(join(dir, "MEMORY.md"), "utf-8");
    expect(onDisk).toContain("§ k");
    expect(onDisk).toContain("v");
  });
});

describe("HttpMemoryBackend", () => {
  function makeFetchMock(handler: (input: Request) => Response | Promise<Response>): typeof fetch {
    return (async (input: any, init: any) => {
      const url = typeof input === "string" ? input : input.url;
      const req = new Request(url, init);
      return await handler(req);
    }) as unknown as typeof fetch;
  }

  it("POSTs to /entries on add", async () => {
    const calls: { method: string; url: string; body: string; auth?: string }[] = [];
    const backend = new HttpMemoryBackend({
      endpoint: "https://example.com/api",
      apiKey: "k1",
      fetchFn: makeFetchMock(async (req) => {
        calls.push({
          method: req.method,
          url: req.url,
          body: await req.text(),
          auth: req.headers.get("authorization") ?? undefined,
        });
        return new Response("{}", { status: 200 });
      }),
    });
    await backend.add("note", "hello");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://example.com/api/entries");
    expect(JSON.parse(calls[0].body)).toEqual({ tag: "note", content: "hello" });
    expect(calls[0].auth).toBe("Bearer k1");
  });

  it("PUTs to /entries/<tag> on replace and ignores 404", async () => {
    const backend = new HttpMemoryBackend({
      endpoint: "https://x",
      fetchFn: makeFetchMock(async () => new Response("not found", { status: 404 })),
    });
    await expect(backend.replace("missing", "v")).resolves.toBeUndefined();
  });

  it("DELETEs to /entries/<tag> on remove", async () => {
    const calls: string[] = [];
    const backend = new HttpMemoryBackend({
      endpoint: "https://x",
      fetchFn: makeFetchMock(async (req) => {
        calls.push(`${req.method} ${req.url}`);
        return new Response(null, { status: 204 });
      }),
    });
    await backend.remove("note");
    expect(calls).toEqual(["DELETE https://x/entries/note"]);
  });

  it("getSnapshot accepts JSON {snapshot} response", async () => {
    const backend = new HttpMemoryBackend({
      endpoint: "https://x",
      fetchFn: makeFetchMock(async () =>
        new Response(JSON.stringify({ snapshot: "§ a\nb" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    });
    expect(await backend.getSnapshot()).toBe("§ a\nb");
  });

  it("getSnapshot reconstructs from JSON {entries}", async () => {
    const backend = new HttpMemoryBackend({
      endpoint: "https://x",
      fetchFn: makeFetchMock(async () =>
        new Response(
          JSON.stringify({ entries: [{ tag: "a", content: "1" }, { tag: "b", content: "2" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    });
    const snap = await backend.getSnapshot();
    expect(snap).toContain("§ a\n1");
    expect(snap).toContain("§ b\n2");
  });

  it("getSnapshot accepts plain text response", async () => {
    const backend = new HttpMemoryBackend({
      endpoint: "https://x",
      fetchFn: makeFetchMock(async () =>
        new Response("plaintext snap", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      ),
    });
    expect(await backend.getSnapshot()).toBe("plaintext snap");
  });

  it("appends ?namespace=<x> when namespace provided", async () => {
    const calls: string[] = [];
    const backend = new HttpMemoryBackend({
      endpoint: "https://x",
      namespace: "user-1",
      fetchFn: makeFetchMock(async (req) => {
        calls.push(req.url);
        return new Response("", { status: 200 });
      }),
    });
    await backend.add("k", "v");
    expect(calls[0]).toBe("https://x/entries?namespace=user-1");
  });

  it("throws on non-2xx for add and getSnapshot", async () => {
    const backend = new HttpMemoryBackend({
      endpoint: "https://x",
      fetchFn: makeFetchMock(async () => new Response("boom", { status: 500 })),
    });
    await expect(backend.add("k", "v")).rejects.toThrow(/HTTP 500/);
    await expect(backend.getSnapshot()).rejects.toThrow(/HTTP 500/);
  });
});

describe("createMemoryBackend factory", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memory-factory-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to LocalMarkdownBackend", () => {
    const backend = createMemoryBackend({ dir });
    expect(backend).toBeInstanceOf(LocalMarkdownBackend);
  });

  it("returns LocalMarkdownBackend for backend=local", () => {
    const backend = createMemoryBackend({ dir, config: { backend: "local" } });
    expect(backend).toBeInstanceOf(LocalMarkdownBackend);
  });

  it("returns HttpMemoryBackend for backend=http with endpoint", () => {
    const backend = createMemoryBackend({
      dir,
      config: { backend: "http", endpoint: "https://x" },
    });
    expect(backend).toBeInstanceOf(HttpMemoryBackend);
  });

  it("throws when backend=http but endpoint missing", () => {
    expect(() =>
      createMemoryBackend({ dir, config: { backend: "http" } }),
    ).toThrow(/endpoint is required/);
  });

  it("resolves an env-based SecretRef apiKey before constructing the backend", async () => {
    process.env.MEMORY_API_KEY_TEST = "k-from-env";
    try {
      const calls: string[] = [];
      const backend = createMemoryBackend({
        dir,
        config: {
          backend: "http",
          endpoint: "https://x",
          apiKey: { env: "MEMORY_API_KEY_TEST" },
        },
        fetchFn: (async (input: any, init: any) => {
          const headers = new Headers(init?.headers);
          calls.push(headers.get("authorization") ?? "");
          return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch,
      });
      await backend.add("k", "v");
      expect(calls[0]).toBe("Bearer k-from-env");
    } finally {
      delete process.env.MEMORY_API_KEY_TEST;
    }
  });

  it("resolves a file-based SecretRef apiKey before constructing the backend", async () => {
    const secretFile = join(dir, "key.txt");
    writeFileSync(secretFile, "k-from-file\n", "utf-8");
    const calls: string[] = [];
    const backend = createMemoryBackend({
      dir,
      config: {
        backend: "http",
        endpoint: "https://x",
        apiKey: { file: secretFile },
      },
      fetchFn: (async (input: any, init: any) => {
        const headers = new Headers(init?.headers);
        calls.push(headers.get("authorization") ?? "");
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    await backend.add("k", "v");
    expect(calls[0]).toBe("Bearer k-from-file");
  });

  it("preserves a plain-string apiKey", async () => {
    const calls: string[] = [];
    const backend = createMemoryBackend({
      dir,
      config: {
        backend: "http",
        endpoint: "https://x",
        apiKey: "k-literal",
      },
      fetchFn: (async (input: any, init: any) => {
        const headers = new Headers(init?.headers);
        calls.push(headers.get("authorization") ?? "");
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    await backend.add("k", "v");
    expect(calls[0]).toBe("Bearer k-literal");
  });
});
