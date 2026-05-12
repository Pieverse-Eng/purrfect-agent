import { describe, it, expect, vi } from "vitest";
import {
  generateSessionTitle,
  sanitizeTitle,
  type TitleProvider,
} from "../../src/core/title-generator.js";

function fakeProvider(content: string | null): TitleProvider {
  return {
    chat: vi.fn(async () => ({
      choices: [{ message: { content } }],
    })),
  };
}

describe("sanitizeTitle", () => {
  it("returns null for empty, whitespace, or null input", () => {
    expect(sanitizeTitle(null)).toBeNull();
    expect(sanitizeTitle(undefined)).toBeNull();
    expect(sanitizeTitle("")).toBeNull();
    expect(sanitizeTitle("   \n\t  ")).toBeNull();
  });

  it("strips surrounding quotes and trailing punctuation", () => {
    expect(sanitizeTitle('"Fix SQLite retry logic."')).toBe("Fix SQLite retry logic");
    expect(sanitizeTitle("'Refactor auth flow'")).toBe("Refactor auth flow");
    expect(sanitizeTitle("`Add title generator`;")).toBe("Add title generator");
    expect(sanitizeTitle("“Smart quotes”")).toBe("Smart quotes");
  });

  it("keeps only the first non-empty line", () => {
    const out = sanitizeTitle("  \nDebug flaky test\n\nSome follow-up");
    expect(out).toBe("Debug flaky test");
  });

  it("truncates with an ellipsis when over the limit", () => {
    const long = "A ".repeat(30).trim(); // 59 chars
    const out = sanitizeTitle(long, 40);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(40);
    expect(out!.endsWith("…")).toBe(true);
  });

  it("drops leading bullet/dash markers", () => {
    expect(sanitizeTitle("- Build PR dashboard")).toBe("Build PR dashboard");
    expect(sanitizeTitle("* Ship retry fix")).toBe("Ship retry fix");
  });
});

describe("generateSessionTitle", () => {
  it("returns null when the user message is empty", async () => {
    const provider = fakeProvider("should not be called");
    const title = await generateSessionTitle({
      provider,
      firstUserMessage: "   ",
    });
    expect(title).toBeNull();
    expect((provider.chat as any).mock.calls.length).toBe(0);
  });

  it("sanitises provider output into a usable title", async () => {
    const provider = fakeProvider('"Investigate Login Bug"');
    const title = await generateSessionTitle({
      provider,
      firstUserMessage: "there is a login bug, investigate please",
    });
    expect(title).toBe("Investigate Login Bug");
  });

  it("returns null when the provider throws", async () => {
    const provider: TitleProvider = {
      chat: vi.fn(async () => {
        throw new Error("network down");
      }),
    };
    const title = await generateSessionTitle({
      provider,
      firstUserMessage: "hello",
    });
    expect(title).toBeNull();
  });

  it("returns null when the provider returns empty content", async () => {
    const provider = fakeProvider(null);
    const title = await generateSessionTitle({
      provider,
      firstUserMessage: "some task",
    });
    expect(title).toBeNull();
  });

  it("forwards the assistant reply to the provider prompt", async () => {
    const provider = fakeProvider("Debug Title");
    await generateSessionTitle({
      provider,
      firstUserMessage: "please debug this",
      firstAssistantReply: "Here is what I'll look at first",
    });
    const call = (provider.chat as any).mock.calls[0];
    const messages = call[0];
    expect(messages[0].role).toBe("system");
    const userContent: string = messages[1].content;
    expect(userContent).toContain("please debug this");
    expect(userContent).toContain("Here is what I'll look at first");
  });

  it("asks for small maxTokens to keep the call cheap", async () => {
    const provider = fakeProvider("Title");
    await generateSessionTitle({
      provider,
      firstUserMessage: "task",
    });
    const call = (provider.chat as any).mock.calls[0];
    const options = call[2];
    expect(options.maxTokens).toBeLessThanOrEqual(60);
  });
});
