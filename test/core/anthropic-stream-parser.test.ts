import { describe, it, expect } from "vitest";
import { parseAnthropicSSEStream } from "../../src/core/anthropic-stream-parser.js";
import type { StreamDelta } from "../../src/core/types.js";

function toReadableStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function makeAnthropicSSE(
  events: Array<{ event: string; data: Record<string, unknown> }>,
): string {
  return (
    events
      .map((entry) => `event: ${entry.event}\ndata: ${JSON.stringify(entry.data)}`)
      .join("\n\n") + "\n\n"
  );
}

describe("parseAnthropicSSEStream", () => {
  it("emits streamed tool_use metadata and argument deltas", async () => {
    const sse = makeAnthropicSSE([
      {
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_1", name: "file_read" },
        },
      },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"path":"/tmp/test.txt"}' },
        },
      },
      {
        event: "message_stop",
        data: { type: "message_stop" },
      },
    ]);

    const deltas: StreamDelta[] = [];
    for await (const delta of parseAnthropicSSEStream(toReadableStream(sse))) {
      deltas.push(delta);
    }

    const toolDeltas = deltas.filter((delta) => delta.type === "tool_call");
    expect(toolDeltas).toHaveLength(2);
    expect(toolDeltas[0].toolCall?.id).toBe("toolu_1");
    expect(toolDeltas[0].toolCall?.function?.name).toBe("file_read");
    expect(toolDeltas[1].toolCall?.function?.arguments).toBe('{"path":"/tmp/test.txt"}');
    expect(deltas[deltas.length - 1]).toEqual({ type: "done" });
  });

  it("yields text before the Anthropic stream closes", async () => {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        controller = ctrl;
        controller.enqueue(
          encoder.encode(
            makeAnthropicSSE([
              {
                event: "content_block_start",
                data: {
                  type: "content_block_start",
                  index: 0,
                  content_block: { type: "text", text: "" },
                },
              },
              {
                event: "content_block_delta",
                data: {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: "hello" },
                },
              },
            ]),
          ),
        );
      },
    });

    const iter = parseAnthropicSSEStream(stream)[Symbol.asyncIterator]();
    const nextPromise = iter.next();
    const first = await Promise.race([
      nextPromise,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);

    controller.enqueue(
      encoder.encode(
        makeAnthropicSSE([{ event: "message_stop", data: { type: "message_stop" } }]),
      ),
    );
    controller.close();

    expect(first).not.toBe("timeout");
    expect(first).toEqual({ done: false, value: { type: "text", content: "hello" } });
  });

  it("propagates stop_reason 'max_tokens' from message_delta", async () => {
    const sse = makeAnthropicSSE([
      {
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
      },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "truncated" },
        },
      },
      {
        event: "message_delta",
        data: {
          type: "message_delta",
          delta: { stop_reason: "max_tokens" },
          usage: { output_tokens: 4096 },
        },
      },
    ]);

    const deltas: StreamDelta[] = [];
    for await (const delta of parseAnthropicSSEStream(toReadableStream(sse))) {
      deltas.push(delta);
    }

    const done = deltas.find((d) => d.type === "done");
    expect(done).toBeDefined();
    expect(done!.finishReason).toBe("max_tokens");
  });

  it("propagates stop_reason 'end_turn' from message_delta", async () => {
    const sse = makeAnthropicSSE([
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "complete" },
        },
      },
      {
        event: "message_delta",
        data: {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
        },
      },
    ]);

    const deltas: StreamDelta[] = [];
    for await (const delta of parseAnthropicSSEStream(toReadableStream(sse))) {
      deltas.push(delta);
    }

    const done = deltas.find((d) => d.type === "done");
    expect(done!.finishReason).toBe("end_turn");
  });
});
