import { describe, it, expect } from "vitest";
import {
  getModelMetadata,
  getContextLength,
} from "../../src/core/model-metadata.js";

describe("ModelMetadataRegistry", () => {
  it("known Claude model returns correct metadata", () => {
    const meta = getModelMetadata("claude-sonnet-4-20250514");
    expect(meta.contextLength).toBe(200_000);
    expect(meta.maxOutputTokens).toBe(16_384);
    expect(meta.provider).toBe("anthropic");
    expect(meta.capabilities.thinking).toBe(true);
    expect(meta.capabilities.vision).toBe(true);
    expect(meta.capabilities.toolUse).toBe(true);
  });

  it("known GPT model returns correct metadata", () => {
    const meta = getModelMetadata("gpt-4o");
    expect(meta.provider).toBe("openai");
    expect(meta.contextLength).toBe(128_000);
    expect(meta.maxOutputTokens).toBe(16_384);
    expect(meta.capabilities.vision).toBe(true);
    expect(meta.capabilities.toolUse).toBe(true);
    expect(meta.capabilities.thinking).toBe(false);
  });

  it("config overrides merge with static data", () => {
    const meta = getModelMetadata("gpt-4o", {
      contextLength: 64_000,
      maxOutputTokens: 4_096,
    });
    expect(meta.contextLength).toBe(64_000);
    expect(meta.maxOutputTokens).toBe(4_096);
    // Static fields not overridden remain intact
    expect(meta.provider).toBe("openai");
    expect(meta.capabilities.vision).toBe(true);
  });

  it("unknown model returns sensible defaults", () => {
    const meta = getModelMetadata("some-unknown-model-v99");
    expect(meta.contextLength).toBe(128_000);
    expect(meta.maxOutputTokens).toBe(4_096);
    expect(meta.provider).toBe("openai");
    expect(meta.capabilities.vision).toBe(false);
    expect(meta.capabilities.toolUse).toBe(true);
    expect(meta.capabilities.thinking).toBe(false);
  });

  it("getContextLength returns correct value for known model", () => {
    expect(getContextLength("claude-opus-4-20250514")).toBe(200_000);
    expect(getContextLength("gpt-4o-mini")).toBe(128_000);
    expect(getContextLength("totally-unknown")).toBe(128_000);
  });
});
