import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { CredentialPool } from "../../src/core/credential-pool.js";
import { HttpProvider } from "../../src/core/provider.js";
import { createMockFetch, makeTextResponse } from "../helpers/mock-server.js";
import { createTempDir } from "../helpers/fixtures.js";

describe("CredentialPool", () => {
  it("rotates to the next healthy key after one is exhausted", () => {
    const tmp = createTempDir();
    const pool = new CredentialPool({ path: join(tmp.path, "credentials.json") });

    try {
      pool.add({ provider: "openai", key: "sk-first", label: "first" });
      pool.add({ provider: "openai", key: "sk-second", label: "second" });

      const first = pool.acquire("openai");
      expect(first?.key).toBe("sk-first");
      pool.markExhausted(first!, "rate limited", Date.now() + 60_000);

      const second = pool.acquire("openai");
      expect(second?.key).toBe("sk-second");

      pool.reset("openai");
      expect(pool.list("openai").every((entry) => entry.status === "healthy")).toBe(true);
    } finally {
      tmp.cleanup();
    }
  });
});

describe("HttpProvider credential pool integration", () => {
  it("retries with the next healthy key on 429", async () => {
    const tmp = createTempDir();
    const pool = new CredentialPool({ path: join(tmp.path, "credentials.json") });
    pool.add({ provider: "openai", key: "sk-first", label: "first" });
    pool.add({ provider: "openai", key: "sk-second", label: "second" });

    try {
      const mockFetch = createMockFetch([
        { status: 429, body: '{"error":{"message":"rate limited"}}' },
        { body: makeTextResponse("ok", "gpt-4o") },
      ]);
      const provider = new HttpProvider(
        {
          baseUrl: "https://api.openai.test/v1",
          apiKey: "sk-fallback",
          model: "gpt-4o",
          credentialPool: pool,
          providerType: "openai",
        },
        mockFetch,
      );

      const response = await provider.chat([{ role: "user", content: "hi" }], []);

      expect(response.choices[0].message.content).toBe("ok");
      const calls = (mockFetch as any).calls as Array<{ init: RequestInit }>;
      expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer sk-first");
      expect((calls[1].init.headers as Record<string, string>).Authorization).toBe("Bearer sk-second");
      expect(pool.list("openai")[0].status).toBe("exhausted");
    } finally {
      tmp.cleanup();
    }
  });

  it("falls back to configured apiKey after pool keys are exhausted", async () => {
    const tmp = createTempDir();
    const pool = new CredentialPool({ path: join(tmp.path, "credentials.json") });
    pool.add({ provider: "openai", key: "sk-pooled", label: "pooled" });

    try {
      const mockFetch = createMockFetch([
        { status: 429, body: '{"error":{"message":"rate limited"}}' },
        { body: makeTextResponse("ok", "gpt-4o") },
      ]);
      const provider = new HttpProvider(
        {
          baseUrl: "https://api.openai.test/v1",
          apiKey: "sk-fallback",
          model: "gpt-4o",
          credentialPool: pool,
          providerType: "openai",
        },
        mockFetch,
      );

      const response = await provider.chat([{ role: "user", content: "hi" }], []);

      expect(response.choices[0].message.content).toBe("ok");
      const calls = (mockFetch as any).calls as Array<{ init: RequestInit }>;
      expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer sk-pooled");
      expect((calls[1].init.headers as Record<string, string>).Authorization).toBe("Bearer sk-fallback");
      expect(pool.list("openai")[0].status).toBe("exhausted");
    } finally {
      tmp.cleanup();
    }
  });
});
