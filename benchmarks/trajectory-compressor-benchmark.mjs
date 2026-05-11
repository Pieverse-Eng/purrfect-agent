#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const DEFAULT_SIZES = [10_000, 50_000, 200_000];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sizes = args.sizes ?? DEFAULT_SIZES;
  const distPath = new URL("../dist/core/index.js", import.meta.url);

  if (!existsSync(distPath)) {
    console.error("dist/core/index.js not found. Run `npm run build` before this benchmark.");
    process.exitCode = 1;
    return;
  }

  const { compressTrajectory, estimateTotalTokens } = await import(distPath);
  const sourceMessages = args.input ? loadMessages(args.input) : null;

  console.log("Trajectory compressor benchmark");
  console.log(`Source: ${args.input ?? "generated realistic Message trajectory"}`);
  console.log("");
  console.log([
    "target",
    "baseline_tokens",
    "compressed_tokens",
    "saved_tokens",
    "ratio",
    "ms",
    "duplicate_results",
    "file_snapshots",
    "shell_truncations",
  ].join("\t"));

  for (const target of sizes) {
    const messages = sourceMessages
      ? fitToTokenTarget(sourceMessages, target, estimateTotalTokens)
      : generateTrajectory(target, estimateTotalTokens);

    const baselineTokens = estimateTotalTokens(messages);
    const started = performance.now();
    const result = compressTrajectory(messages, {
      protectLastTurns: 8,
      shellStdoutMaxBytes: args.shellStdoutMaxBytes ?? 512,
      fileSnapshotMaxBytesPerFile: args.fileSnapshotMaxBytesPerFile,
    });
    const elapsed = performance.now() - started;

    console.log([
      target,
      baselineTokens,
      result.metrics.compressedTokens,
      result.metrics.tokensSaved,
      result.metrics.compressionRatio.toFixed(3),
      elapsed.toFixed(1),
      result.metrics.duplicateSearchResultsRemoved,
      result.metrics.fileSnapshotsCreated,
      result.metrics.shellStdoutTruncated,
    ].join("\t"));
  }
}

function parseArgs(argv) {
  const result = {};
  for (const arg of argv) {
    if (arg.startsWith("--sizes=")) {
      result.sizes = arg.slice("--sizes=".length)
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value) && value > 0);
    } else if (arg.startsWith("--input=")) {
      result.input = arg.slice("--input=".length);
    } else if (arg.startsWith("--shell-stdout-max-bytes=")) {
      result.shellStdoutMaxBytes = Number(arg.slice("--shell-stdout-max-bytes=".length));
    } else if (arg.startsWith("--file-snapshot-max-bytes-per-file=")) {
      result.fileSnapshotMaxBytesPerFile = Number(
        arg.slice("--file-snapshot-max-bytes-per-file=".length),
      );
    }
  }
  return result;
}

function loadMessages(path) {
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return [];

  if (raw.startsWith("[")) {
    return normalizeEntry(JSON.parse(raw));
  }

  const messages = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    messages.push(...normalizeEntry(JSON.parse(line)));
  }
  return messages;
}

function normalizeEntry(entry) {
  if (Array.isArray(entry)) {
    if (entry.every((item) => typeof item.role === "string")) return entry;
    return entry.map(fromHermesTurn);
  }

  if (Array.isArray(entry.messages)) return normalizeEntry(entry.messages);
  if (Array.isArray(entry.trajectory)) return normalizeEntry(entry.trajectory);
  if (Array.isArray(entry.conversations)) return normalizeEntry(entry.conversations);
  return [];
}

function fromHermesTurn(turn) {
  const from = turn.from ?? turn.role ?? "user";
  const role = from === "human" ? "user" : from === "gpt" ? "assistant" : from;
  return {
    role,
    content: turn.value ?? turn.content ?? "",
  };
}

function fitToTokenTarget(seedMessages, targetTokens, estimateTotalTokens) {
  if (seedMessages.length === 0) return generateTrajectory(targetTokens, estimateTotalTokens);

  const fitted = [];
  let cursor = 0;
  while (estimateTotalTokens(fitted) < targetTokens) {
    fitted.push(seedMessages[cursor % seedMessages.length]);
    cursor++;
  }
  return fitted;
}

function generateTrajectory(targetTokens, estimateTotalTokens) {
  const messages = [
    { role: "system", content: "You are a coding agent working in a repository." },
    { role: "user", content: "Inspect and fix a context-management issue." },
    { role: "assistant", content: "I will inspect the repository and related tests." },
  ];

  let i = 0;
  while (estimateTotalTokens(messages) < targetTokens) {
    const grepId1 = `grep_${i}_a`;
    const grepId2 = `grep_${i}_b`;
    const readId1 = `read_${i}_a`;
    const readId2 = `read_${i}_b`;
    const shellId = `shell_${i}`;
    const path = "src/core";
    const pattern = i % 2 === 0 ? "compressor" : "messages";

    messages.push(
      {
        role: "assistant",
        content: null,
        tool_calls: [toolCall(grepId1, "grep", { path, pattern })],
      },
      {
        role: "tool",
        tool_call_id: grepId1,
        content: makeSearchOutput(path, pattern, i),
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          toolCall(readId1, "file_read", { path: `/repo/src/core/${pattern}.ts` }),
          toolCall(readId2, "file_read", { path: `/repo/test/core/${pattern}.test.ts` }),
        ],
      },
      {
        role: "tool",
        tool_call_id: readId1,
        content: JSON.stringify({ content: makeFileContent(pattern, i) }),
      },
      {
        role: "tool",
        tool_call_id: readId2,
        content: JSON.stringify({ content: makeFileContent(`${pattern}-test`, i) }),
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [toolCall(shellId, "shell_exec", { command: "npm test -- test/core/compressor.test.ts" })],
      },
      {
        role: "tool",
        tool_call_id: shellId,
        content: JSON.stringify({ stdout: makeShellStdout(i), stderr: "" }),
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [toolCall(grepId2, "grep", { path, pattern })],
      },
      {
        role: "tool",
        tool_call_id: grepId2,
        content: makeSearchOutput(path, pattern, i + 1),
      },
      {
        role: "assistant",
        content: `Iteration ${i}: found repeated scan output, read snapshots, and test output.`,
      },
    );

    if (i % 5 === 0) {
      messages.push({
        role: "user",
        content: `Follow-up ${i}: keep the final behavior intact.`,
      });
    }
    i++;
  }

  messages.push({ role: "assistant", content: "Final answer: trajectory compression completed." });
  return messages;
}

function toolCall(id, name, args) {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

function makeSearchOutput(path, pattern, seed) {
  return Array.from(
    { length: 36 },
    (_, line) => `${path}/file-${line % 12}.ts:${line + 1}: ${pattern} match ${seed}.${line}`,
  ).join("\n");
}

function makeFileContent(name, seed) {
  return Array.from(
    { length: 16 },
    (_, line) => `export const ${name.replace(/[^a-zA-Z0-9_]/g, "_")}_${line} = ${seed + line};`,
  ).join("\n");
}

function makeShellStdout(seed) {
  return Array.from(
    { length: 72 },
    (_, line) => `stdout ${seed}.${line}: repeated test and scan log data that is useful near the head but noisy later`,
  ).join("\n");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
