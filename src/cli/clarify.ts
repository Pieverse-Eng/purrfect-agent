import type * as readline from "node:readline";
import type {
  ClarifyRequest,
  ClarifyResponse,
} from "../core/tools/clarify.js";
import {
  renderClarifyRequest,
  resolveClarifyAnswer,
} from "../core/tools/clarify.js";

export function formatClarifyPrompt(request: ClarifyRequest): string {
  return renderClarifyRequest(request);
}

export function parseClarifyAnswer(
  answer: string,
  request: ClarifyRequest,
): ClarifyResponse {
  return resolveClarifyAnswer(answer, request);
}

export async function askClarificationWithReadline(
  rl: readline.Interface,
  request: ClarifyRequest,
): Promise<ClarifyResponse> {
  console.log();
  console.log(formatClarifyPrompt(request));
  const answer = await new Promise<string>((resolve) => {
    rl.question("Answer: ", resolve);
  });
  return parseClarifyAnswer(answer, request);
}
