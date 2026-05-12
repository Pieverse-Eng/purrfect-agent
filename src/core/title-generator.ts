/**
 * Auto-generate a short descriptive title for a REPL session from the
 * first user message (and optional first assistant reply).
 *
 * Mirrors hermes-agent/agent/title_generator.py: a cheap, fire-and-forget
 * LLM call that updates the session title on the first turn. Failure is
 * silent — the agent loop should never be blocked by title generation.
 */

import type { Message, ToolSchema } from "./types.js";

const DEFAULT_MAX_CHARS = 40;

const TITLE_SYSTEM_PROMPT = `You generate very short session titles.

Rules:
- Output ONLY the title text. No quotes, no punctuation at the end, no preamble.
- Keep it under 40 characters.
- Use title case, but keep common acronyms (API, CLI, SQL).
- Describe the task, not the conversation. e.g. "Fix SQLite retry logic" not "Helping user with code".`;

const USER_WRAP = (userMessage: string, assistantReply?: string): string => {
  const lines = [
    "Generate a short title for this session.",
    "",
    "First user message:",
    userMessage.slice(0, 2000),
  ];
  if (assistantReply && assistantReply.trim().length > 0) {
    lines.push("", "Assistant's first reply:", assistantReply.slice(0, 2000));
  }
  return lines.join("\n");
};

export interface TitleChatResponse {
  choices: Array<{
    message: { content: string | null };
  }>;
}

export interface TitleProvider {
  chat(
    messages: Message[],
    tools: ToolSchema[],
    options?: { signal?: AbortSignal; maxTokens?: number },
  ): Promise<TitleChatResponse>;
}

export interface GenerateTitleOptions {
  provider: TitleProvider;
  firstUserMessage: string;
  firstAssistantReply?: string;
  maxChars?: number;
  signal?: AbortSignal;
}

/**
 * Strip quotes, trailing punctuation, and runaway length from a model title.
 * Returns `null` if nothing usable is left.
 */
export function sanitizeTitle(raw: string | null | undefined, maxChars = DEFAULT_MAX_CHARS): string | null {
  if (!raw) return null;
  let out = raw.trim();
  if (!out) return null;

  // Take only the first non-empty line — the model sometimes adds follow-ups.
  const firstLine = out.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (!firstLine) return null;
  out = firstLine.trim();

  // Strip surrounding quotes, trailing punctuation, and leading markers.
  // Iterate so we can peel off nested patterns like `` `title`; `` correctly.
  const QUOTE_OR_TRAILING = /(^["'`“”‘’]+)|([\s.!?:;,"'`“”‘’]+$)/g;
  const LEADING_MARKER = /^[\s\-–—•*]+/;
  let previous = "";
  while (previous !== out) {
    previous = out;
    out = out.replace(QUOTE_OR_TRAILING, "");
    out = out.replace(LEADING_MARKER, "");
  }

  if (out.length === 0) return null;
  if (out.length > maxChars) {
    out = out.slice(0, maxChars - 1).trimEnd() + "…";
  }
  return out;
}

/**
 * Call the provider to generate a short title. Returns `null` when the
 * provider returns nothing usable. Callers should treat failures as
 * non-fatal — the session keeps its default title.
 */
export async function generateSessionTitle(
  options: GenerateTitleOptions,
): Promise<string | null> {
  const { provider, firstUserMessage, firstAssistantReply, signal } = options;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

  const trimmedUser = firstUserMessage.trim();
  if (!trimmedUser) return null;

  try {
    const response = await provider.chat(
      [
        { role: "system", content: TITLE_SYSTEM_PROMPT },
        { role: "user", content: USER_WRAP(trimmedUser, firstAssistantReply) },
      ],
      [],
      { signal, maxTokens: 40 },
    );
    const content = response.choices?.[0]?.message?.content ?? null;
    return sanitizeTitle(content, maxChars);
  } catch {
    // Title generation is best-effort; never propagate the error.
    return null;
  }
}
