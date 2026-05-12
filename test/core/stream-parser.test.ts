import { describe, it, expect } from "vitest";
import { parseSSEStream } from "../../src/core/stream-parser.js";
import type { StreamDelta } from "../../src/core/types.js";
import { makeStreamChunk, makeSSEStream } from "../helpers/mock-server.js";

function toReadableStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe("parseSSEStream", () => {
  it("yields text deltas from SSE stream", async () => {
    const sse = makeSSEStream([
      makeStreamChunk("Hello"),
      makeStreamChunk(" world"),
      makeStreamChunk("!", undefined, "stop"),
    ]);
    const stream = toReadableStream(sse);
    const deltas: StreamDelta[] = [];
    for await (const delta of parseSSEStream(stream)) {
      deltas.push(delta);
    }

    expect(deltas.filter((d) => d.type === "text")).toHaveLength(3);
    expect(deltas[0]).toEqual({ type: "text", content: "Hello" });
    expect(deltas[1]).toEqual({ type: "text", content: " world" });
    expect(deltas[2]).toEqual({ type: "text", content: "!" });
    expect(deltas[deltas.length - 1]).toEqual({ type: "done", finishReason: "stop" });
  });

  it("accumulates tool call deltas by index", async () => {
    const sse = makeSSEStream([
      makeStreamChunk(undefined, [
        { index: 0, id: "call_1", function: { name: "file_read", arguments: "" } },
      ]),
      makeStreamChunk(undefined, [
        { index: 0, function: { arguments: '{"path":' } },
      ]),
      makeStreamChunk(undefined, [
        { index: 0, function: { arguments: '"/tmp"}' } },
      ]),
      makeStreamChunk(undefined, undefined, "tool_calls"),
    ]);
    const stream = toReadableStream(sse);
    const deltas: StreamDelta[] = [];
    for await (const delta of parseSSEStream(stream)) {
      deltas.push(delta);
    }

    const toolDeltas = deltas.filter((d) => d.type === "tool_call");
    expect(toolDeltas.length).toBeGreaterThanOrEqual(1);
    expect(deltas[deltas.length - 1]).toEqual({ type: "done", finishReason: "tool_calls" });
  });

  it("handles finish_reason with content in same chunk", async () => {
    const sse = makeSSEStream([makeStreamChunk("hi", undefined, "stop")]);
    const stream = toReadableStream(sse);
    const deltas: StreamDelta[] = [];
    for await (const delta of parseSSEStream(stream)) {
      deltas.push(delta);
    }
    expect(deltas[0]).toEqual({ type: "text", content: "hi" });
    expect(deltas[deltas.length - 1]).toEqual({ type: "done", finishReason: "stop" });
  });

  it("handles empty stream gracefully", async () => {
    const sse = "data: [DONE]\n\n";
    const stream = toReadableStream(sse);
    const deltas: StreamDelta[] = [];
    for await (const delta of parseSSEStream(stream)) {
      deltas.push(delta);
    }
    expect(deltas).toEqual([{ type: "done" }]);
  });

  it("propagates finish_reason 'length' on truncation", async () => {
    const sse = makeSSEStream([
      makeStreamChunk("partial text"),
      makeStreamChunk(undefined, undefined, "length"),
    ]);
    const stream = toReadableStream(sse);
    const deltas: StreamDelta[] = [];
    for await (const delta of parseSSEStream(stream)) {
      deltas.push(delta);
    }

    const done = deltas.find((d) => d.type === "done");
    expect(done).toBeDefined();
    expect(done!.finishReason).toBe("length");
  });

  it("yields the first parsed event before the stream closes", async () => {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        controller = ctrl;
        controller.enqueue(encoder.encode("data: {\"choices\":[{\"delta\":{\"content\":\"A\"}}]}\n\n"));
      },
    });

    const iter = parseSSEStream(stream)[Symbol.asyncIterator]();
    const nextPromise = iter.next();
    const first = await Promise.race([
      nextPromise,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);

    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    controller.close();

    expect(first).not.toBe("timeout");
    expect(first).toEqual({ done: false, value: { type: "text", content: "A" } });
  });
});
