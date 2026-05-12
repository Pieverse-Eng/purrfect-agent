import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  runOnboard,
  loadAgentEnv,
  agentEnvPath,
  defaultAgentName,
} from "../../src/cli/onboard.js";
import { createTempDir } from "../helpers/fixtures.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups) try { fn(); } catch { /* best effort */ }
  cleanups = [];
});

function fakeFetch(payload: {
  status?: number;
  body: unknown;
  capture?: (url: string, init?: RequestInit) => void;
}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    payload.capture?.(url, init);
    const status = payload.status ?? 200;
    return new Response(JSON.stringify(payload.body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("runOnboard", () => {
  it("success with provisioned wallet → writes complete agent.env", async () => {
    const tmp = createTempDir("onboard-");
    cleanups.push(tmp.cleanup);
    const lines: string[] = [];

    let captured: { url?: string; init?: RequestInit } = {};
    const result = await runOnboard({
      configDir: tmp.path,
      agentName: "my-agent",
      chainType: "ethereum",
      fetchFn: fakeFetch({
        body: {
          ok: true,
          data: {
            agentId: "agent_abc",
            apiKey: "sk-pv-test-123",
            walletProvisioned: true,
            wallet: { address: "0xdeadbeef", chainId: 1, chainType: "ethereum" },
          },
        },
        capture: (url, init) => {
          captured = { url, init };
        },
      }),
      output: (line) => lines.push(line),
    });

    expect(captured.url).toBe("https://purr.pieverse.io/v1/agents/register");
    const body = JSON.parse(String(captured.init?.body ?? "{}"));
    expect(body).toEqual({ name: "my-agent", chainType: "ethereum" });

    expect(result.agentId).toBe("agent_abc");
    expect(result.apiKey).toBe("sk-pv-test-123");
    expect(result.wallet).toEqual({ address: "0xdeadbeef", chainId: 1, chainType: "ethereum" });
    expect(result.envPath).toBe(agentEnvPath(tmp.path));
    expect(existsSync(agentEnvPath(tmp.path))).toBe(true);

    const envText = readFileSync(agentEnvPath(tmp.path), "utf-8");
    expect(envText).toContain("AGENT_ID=agent_abc");
    expect(envText).toContain("AGENT_API_KEY=sk-pv-test-123");
    expect(envText).toContain("AGENT_WALLET_PROVISIONED=true");
    expect(envText).toContain("AGENT_WALLET_ADDRESS=0xdeadbeef");
    expect(envText).toContain("AGENT_WALLET_CHAIN_ID=1");
    expect(envText).toContain("AGENT_WALLET_CHAIN_TYPE=ethereum");
  });

  it("success with wallet pending → writes env without wallet keys", async () => {
    const tmp = createTempDir("onboard-");
    cleanups.push(tmp.cleanup);

    await runOnboard({
      configDir: tmp.path,
      agentName: "later-agent",
      fetchFn: fakeFetch({
        body: {
          ok: true,
          data: {
            agentId: "agent_xyz",
            apiKey: "sk-pv-pending",
            walletProvisioned: false,
            wallet: null,
          },
        },
      }),
      output: () => undefined,
    });

    const envText = readFileSync(agentEnvPath(tmp.path), "utf-8");
    expect(envText).toContain("AGENT_WALLET_PROVISIONED=false");
    expect(envText).not.toContain("AGENT_WALLET_ADDRESS");
    expect(envText).not.toContain("AGENT_WALLET_CHAIN_ID");
  });

  it("name conflict (409) → throws with helpful message", async () => {
    const tmp = createTempDir("onboard-");
    cleanups.push(tmp.cleanup);

    await expect(
      runOnboard({
        configDir: tmp.path,
        agentName: "taken",
        fetchFn: fakeFetch({
          status: 409,
          body: { ok: false, error: "name already exists" },
        }),
        output: () => undefined,
      }),
    ).rejects.toThrow(/already taken/i);

    expect(existsSync(agentEnvPath(tmp.path))).toBe(false);
  });

  it("network error → throws wrapped error and writes no file", async () => {
    const tmp = createTempDir("onboard-");
    cleanups.push(tmp.cleanup);

    const failingFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    await expect(
      runOnboard({ configDir: tmp.path, agentName: "neterr", fetchFn: failingFetch, output: () => undefined }),
    ).rejects.toThrow(/network/i);

    expect(existsSync(agentEnvPath(tmp.path))).toBe(false);
  });

  it("non-JSON server response → throws cleanly", async () => {
    const tmp = createTempDir("onboard-");
    cleanups.push(tmp.cleanup);

    const badFetch = (async () =>
      new Response("<!DOCTYPE html>not json", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })) as unknown as typeof fetch;

    await expect(
      runOnboard({ configDir: tmp.path, agentName: "html", fetchFn: badFetch, output: () => undefined }),
    ).rejects.toThrow(/non-JSON|JSON/i);
  });

  it("loadAgentEnv reads back what runOnboard wrote", async () => {
    const tmp = createTempDir("onboard-");
    cleanups.push(tmp.cleanup);

    expect(loadAgentEnv(tmp.path)).toBeNull();

    await runOnboard({
      configDir: tmp.path,
      agentName: "roundtrip",
      fetchFn: fakeFetch({
        body: {
          ok: true,
          data: {
            agentId: "agent_round",
            apiKey: "sk-pv-round",
            walletProvisioned: true,
            wallet: { address: "0xcafe", chainId: 137, chainType: "polygon" },
          },
        },
      }),
      output: () => undefined,
    });

    const env = loadAgentEnv(tmp.path);
    expect(env).not.toBeNull();
    expect(env!.AGENT_ID).toBe("agent_round");
    expect(env!.AGENT_API_KEY).toBe("sk-pv-round");
    expect(env!.AGENT_WALLET_ADDRESS).toBe("0xcafe");
    expect(env!.AGENT_WALLET_CHAIN_ID).toBe("137");
    expect(env!.AGENT_WALLET_CHAIN_TYPE).toBe("polygon");
  });

  it("defaultAgentName produces a safe, host-derived identifier", () => {
    const name = defaultAgentName();
    expect(name).toMatch(/^[a-z0-9-]+$/);
    expect(name.length).toBeGreaterThan(3);
  });
});
