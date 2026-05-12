import { createParser, type EventSourceMessage } from "eventsource-parser";
import type { ProviderUsage, StreamDelta } from "./types.js";

/**
 * Parse an Anthropic SSE response body into typed StreamDelta events.
 *
 * Anthropic uses named SSE events (message_start, content_block_start,
 * content_block_delta, content_block_stop, message_delta, message_stop)
 * rather than OpenAI's unnamed "data:" lines.
 */
export async function* parseAnthropicSSEStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamDelta> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  const events: EventSourceMessage[] = [];
  const parser = createParser({
    onEvent(event: EventSourceMessage) {
      events.push(event);
    },
  });

  // Track block types by index for delta routing
  const blockTypes = new Map<number, string>();
  const usage: Partial<ProviderUsage> = {};
  let sawDone = false;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    parser.feed(decoder.decode(value, { stream: true }));

    while (events.length > 0) {
      const parsed = parseEvent(events.shift()!, blockTypes, usage);
      for (const delta of parsed.deltas) {
        yield delta;
      }
      if (parsed.done) {
        sawDone = true;
        return;
      }
    }
  }

  parser.feed(decoder.decode());
  while (events.length > 0) {
    const parsed = parseEvent(events.shift()!, blockTypes, usage);
    for (const delta of parsed.deltas) {
      yield delta;
    }
    if (parsed.done) {
      sawDone = true;
      return;
    }
  }

  // If no message_stop was found, emit done anyway
  if (!sawDone) {
    yield { type: "done" as const };
  }
}

function parseEvent(
  event: EventSourceMessage,
  blockTypes: Map<number, string>,
  usage: Partial<ProviderUsage>,
): { deltas: StreamDelta[]; done: boolean } {
  try {
    const json = JSON.parse(event.data);
    const eventType = json.type ?? event.event;

    switch (eventType) {
      case "message_start": {
        mergeAnthropicUsage(usage, json.message?.usage);
        return { deltas: [], done: false };
      }

      case "content_block_start": {
        const index = json.index as number;
        const blockType = json.content_block?.type as string;
        blockTypes.set(index, blockType);

        if (blockType === "tool_use") {
          return {
            deltas: [
              {
                type: "tool_call" as const,
                toolCallIndex: index,
                toolCall: {
                  id: json.content_block?.id,
                  type: "function" as const,
                  function: {
                    name: json.content_block?.name,
                    arguments: "",
                  },
                },
              },
            ],
            done: false,
          };
        }
        return { deltas: [], done: false };
      }

      case "content_block_delta": {
        const delta = json.delta;
        if (!delta) return { deltas: [], done: false };

        if (delta.type === "text_delta" && delta.text) {
          return {
            deltas: [{ type: "text" as const, content: delta.text }],
            done: false,
          };
        }
        if (delta.type === "thinking_delta" && delta.thinking) {
          return {
            deltas: [{ type: "thinking" as const, content: delta.thinking }],
            done: false,
          };
        }
        if (delta.type === "input_json_delta" && delta.partial_json !== undefined) {
          const index = json.index as number;
          if (blockTypes.get(index) !== "tool_use") {
            return { deltas: [], done: false };
          }
          return {
            deltas: [
              {
                type: "tool_call" as const,
                toolCallIndex: index,
                toolCall: {
                  type: "function" as const,
                  function: {
                    arguments: delta.partial_json,
                    name: "",
                  },
                },
              },
            ],
            done: false,
          };
        }
        return { deltas: [], done: false };
      }

      case "message_delta": {
        // message_delta carries stop_reason and usage
        mergeAnthropicUsage(usage, json.usage);
        const stopReason = json.delta?.stop_reason as string | undefined;
        if (stopReason) {
          return {
            deltas: [{
              type: "done" as const,
              finishReason: stopReason,
              usage: finalizeUsage(usage),
            }],
            done: true,
          };
        }
        return { deltas: [], done: false };
      }

      case "message_stop":
        return {
          deltas: [{
            type: "done" as const,
            usage: finalizeUsage(usage),
          }],
          done: true,
        };

      default:
        return { deltas: [], done: false };
    }
  } catch {
    return { deltas: [], done: false };
  }
}

function mergeAnthropicUsage(
  target: Partial<ProviderUsage>,
  raw: Record<string, unknown> | undefined,
): void {
  if (!raw) return;
  if (typeof raw.input_tokens === "number") {
    target.prompt_tokens = raw.input_tokens;
  }
  if (typeof raw.output_tokens === "number") {
    target.completion_tokens = raw.output_tokens;
  }
  if (typeof raw.cache_creation_input_tokens === "number") {
    target.cache_creation_input_tokens = raw.cache_creation_input_tokens;
  }
  if (typeof raw.cache_read_input_tokens === "number") {
    target.cache_read_input_tokens = raw.cache_read_input_tokens;
  }
}

function finalizeUsage(usage: Partial<ProviderUsage>): ProviderUsage | undefined {
  if (
    usage.prompt_tokens === undefined &&
    usage.completion_tokens === undefined &&
    usage.cache_creation_input_tokens === undefined &&
    usage.cache_read_input_tokens === undefined
  ) {
    return undefined;
  }

  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
  };
}
