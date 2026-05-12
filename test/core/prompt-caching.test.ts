import { describe, expect, it } from "vitest";
import { applyAnthropicPromptCaching } from "../../src/core/prompt-caching.js";

describe("applyAnthropicPromptCaching", () => {
  it("marks Anthropic system, tools, and stable conversation prefix without mutating input", () => {
    const payload = {
      system: [
        { type: "text", text: "identity" },
        { type: "text", text: "skills index" },
      ],
      tools: [
        { name: "file_read", description: "Read file", input_schema: {} },
        { name: "file_edit", description: "Edit file", input_schema: {} },
      ],
      messages: [
        { role: "user", content: "first turn" },
        { role: "assistant", content: [{ type: "text", text: "first answer" }] },
        { role: "user", content: "current turn" },
      ],
    };

    const cached = applyAnthropicPromptCaching(payload);

    expect(cached).not.toBe(payload);
    expect(payload.system[1]).not.toHaveProperty("cache_control");
    expect(payload.tools[1]).not.toHaveProperty("cache_control");
    expect(payload.messages[1].content[0]).not.toHaveProperty("cache_control");

    expect(cached.system?.[1]).toMatchObject({
      cache_control: { type: "ephemeral" },
    });
    expect(cached.tools?.[1]).toMatchObject({
      cache_control: { type: "ephemeral" },
    });
    expect(cached.messages?.[1].content[0]).toMatchObject({
      cache_control: { type: "ephemeral" },
    });
    expect(cached.messages?.[2].content).toBe("current turn");
  });

  it("converts a string stable message into a cacheable Anthropic text block", () => {
    const cached = applyAnthropicPromptCaching({
      messages: [
        { role: "user", content: "stable user turn" },
        { role: "user", content: "current user turn" },
      ],
    });

    expect(cached.messages?.[0].content).toEqual([
      {
        type: "text",
        text: "stable user turn",
        cache_control: { type: "ephemeral" },
      },
    ]);
    expect(cached.messages?.[1].content).toBe("current user turn");
  });

  it("uses no more than four cache breakpoints", () => {
    const cached = applyAnthropicPromptCaching({
      system: [{ type: "text", text: "system" }],
      tools: [{ name: "tool", description: "Tool", input_schema: {} }],
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: [{ type: "text", text: "two" }] },
        { role: "user", content: "three" },
        { role: "assistant", content: [{ type: "text", text: "four" }] },
        { role: "user", content: "current" },
      ],
    });

    const serialized = JSON.stringify(cached);
    const markerCount = serialized.match(/cache_control/g)?.length ?? 0;
    expect(markerCount).toBeLessThanOrEqual(4);
  });
});
