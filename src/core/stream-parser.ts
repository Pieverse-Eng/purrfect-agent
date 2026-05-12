import { createParser, type EventSourceMessage } from "eventsource-parser";
import type { StreamDelta } from "./types.js";
import { normalizeOpenAiUsage } from "./prompt-caching.js";

/**
 * Parse an SSE response body into typed StreamDelta events.
 * Uses eventsource-parser for spec-compliant SSE parsing.
 * Mirrors hermes streaming accumulator pattern.
 */
export async function* parseSSEStream(
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

  let sawDone = false;
  let pendingFinishReason: string | undefined;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    parser.feed(decoder.decode(value, { stream: true }));

    while (events.length > 0) {
      const parsed = parseEvent(events.shift()!, pendingFinishReason);
      pendingFinishReason = parsed.pendingFinishReason;
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
    const parsed = parseEvent(events.shift()!, pendingFinishReason);
    pendingFinishReason = parsed.pendingFinishReason;
    for (const delta of parsed.deltas) {
      yield delta;
    }
    if (parsed.done) {
      sawDone = true;
      return;
    }
  }

  // If no [DONE] marker was found, emit done anyway
  if (!sawDone) {
    yield {
      type: "done" as const,
      ...(pendingFinishReason ? { finishReason: pendingFinishReason } : {}),
    };
  }
}

function parseEvent(
  event: EventSourceMessage,
  pendingFinishReason?: string,
): { deltas: StreamDelta[]; done: boolean; pendingFinishReason?: string } {
  if (event.data === "[DONE]") {
    return {
      deltas: [{
        type: "done" as const,
        ...(pendingFinishReason ? { finishReason: pendingFinishReason } : {}),
      }],
      done: true,
    };
  }

  try {
    const json = JSON.parse(event.data);
    const choice = json.choices?.[0];
    if (!choice) {
      if (json.usage) {
        return {
          deltas: [{
            type: "done" as const,
            ...(pendingFinishReason ? { finishReason: pendingFinishReason } : {}),
            usage: normalizeOpenAiUsage(json.usage),
          }],
          done: true,
        };
      }
      return { deltas: [], done: false, pendingFinishReason };
    }

    const delta = choice.delta;
    const deltas: StreamDelta[] = [];

    if (delta?.content) {
      deltas.push({ type: "text" as const, content: delta.content });
    }

    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        deltas.push({
          type: "tool_call" as const,
          toolCallIndex: tc.index,
          toolCall: {
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.function?.name,
              arguments: tc.function?.arguments,
            },
          },
        });
      }
    }

    // If finish_reason is present, append done with reason after content
    if (choice.finish_reason) {
      if (json.usage) {
        deltas.push({
          type: "done" as const,
          finishReason: choice.finish_reason,
          usage: normalizeOpenAiUsage(json.usage),
        });
        return { deltas, done: true };
      }
      return {
        deltas,
        done: false,
        pendingFinishReason: choice.finish_reason,
      };
    }

    return { deltas, done: false, pendingFinishReason };
  } catch {
    return { deltas: [], done: false, pendingFinishReason };
  }
}
