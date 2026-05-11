import type { ToolDefinition } from "../types.js";

export interface ClarifyOption {
  value: string;
  label: string;
  description?: string;
}

export interface ClarifyRequest {
  /** Runtime-generated identifier for interactive surfaces. Not part of the model-facing schema. */
  id?: string;
  question: string;
  options?: ClarifyOption[];
  default?: string;
  reason?: string;
}

export interface ClarifyResponse {
  answer: string;
  selectedOption?: ClarifyOption;
  timedOut?: boolean;
  alreadyPending?: boolean;
}

export type ClarifyHandler = (
  request: ClarifyRequest,
) => Promise<ClarifyResponse | string>;

export interface ClarifyToolOptions {
  askClarification?: ClarifyHandler;
}

export function createClarifyTool(options?: ClarifyToolOptions): ToolDefinition {
  return {
    name: "clarify",
    description:
      "Ask the user a structured clarifying question when requirements are ambiguous, " +
      "high-risk, or missing required parameters. Supports labeled options, a default, " +
      "and a concise reason.",
    schema: {
      type: "function",
      function: {
        name: "clarify",
        description:
          "Ask the user a structured clarifying question. Use when the request is ambiguous, " +
          "high-risk, or missing required parameters. Prefer reasonable assumptions for low-risk routine choices.",
        parameters: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "The specific question to present to the user.",
            },
            options: {
              type: "array",
              description:
                "Optional mutually exclusive choices. Each value is returned to the agent when selected.",
              items: {
                type: "object",
                properties: {
                  value: {
                    type: "string",
                    description: "Stable machine-readable answer value.",
                  },
                  label: {
                    type: "string",
                    description: "Short user-facing option label.",
                  },
                  description: {
                    type: "string",
                    description: "Brief explanation of the option's impact or trade-off.",
                  },
                },
                required: ["value", "label"],
                additionalProperties: false,
              },
            },
            default: {
              type: "string",
              description:
                "Optional default answer value used when the user submits an empty response.",
            },
            reason: {
              type: "string",
              description: "Why clarification is needed before proceeding.",
            },
          },
          required: ["question"],
          additionalProperties: false,
        },
      },
    },
    toolset: "clarify",
    checkFn: () => true,
    async handler(args) {
      const normalized = normalizeClarifyRequest(args);
      if ("error" in normalized) {
        return JSON.stringify({ error: normalized.error });
      }

      if (!options?.askClarification) {
        return JSON.stringify({
          error: "clarify is not available in this execution context",
        });
      }

      try {
        const rawResponse = await options.askClarification(normalized.request);
        const response = normalizeClarifyResponse(
          rawResponse,
          normalized.request,
        );
        return JSON.stringify({
          success: true,
          question: normalized.request.question,
          answer: response.answer,
          ...(response.timedOut ? { timedOut: true } : {}),
          ...(response.alreadyPending ? { alreadyPending: true } : {}),
          ...(response.selectedOption
            ? { selectedOption: response.selectedOption }
            : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: `Failed to clarify: ${message}` });
      }
    },
  };
}

export function normalizeClarifyRequest(
  args: Record<string, unknown>,
): { request: ClarifyRequest } | { error: string } {
  const question = readNonEmptyString(args.question, "question");
  if ("error" in question) return question;

  let options: ClarifyOption[] | undefined;
  if (args.options !== undefined) {
    if (!Array.isArray(args.options)) {
      return { error: "options must be an array" };
    }
    options = [];
    for (let i = 0; i < args.options.length; i++) {
      const raw = args.options[i];
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { error: `options[${i}] must be an object` };
      }
      const item = raw as Record<string, unknown>;
      const value = readNonEmptyString(item.value, `options[${i}].value`);
      if ("error" in value) return value;
      const label = readNonEmptyString(item.label, `options[${i}].label`);
      if ("error" in label) return label;

      const description =
        typeof item.description === "string" && item.description.trim()
          ? item.description.trim()
          : undefined;
      options.push({
        value: value.value,
        label: label.value,
        ...(description ? { description } : {}),
      });
    }
    if (options.length === 0) options = undefined;
  }

  const defaultAnswer =
    typeof args.default === "string" && args.default.trim()
      ? args.default.trim()
      : undefined;
  const reason =
    typeof args.reason === "string" && args.reason.trim()
      ? args.reason.trim()
      : undefined;

  return {
    request: {
      question: question.value,
      ...(options ? { options } : {}),
      ...(defaultAnswer ? { default: defaultAnswer } : {}),
      ...(reason ? { reason } : {}),
    },
  };
}

export function resolveClarifyAnswer(
  answer: string,
  request: ClarifyRequest,
): ClarifyResponse {
  const trimmed = answer.trim();
  const effective = trimmed || request.default || "";
  const options = request.options ?? [];

  const numeric = Number.parseInt(effective, 10);
  if (
    /^\d+$/.test(effective) &&
    numeric >= 1 &&
    numeric <= options.length
  ) {
    const selectedOption = options[numeric - 1];
    return {
      answer: selectedOption.value,
      selectedOption,
    };
  }

  const selectedOption = options.find(
    (option) =>
      option.value === effective ||
      option.label.toLowerCase() === effective.toLowerCase(),
  );
  if (selectedOption) {
    return {
      answer: selectedOption.value,
      selectedOption,
    };
  }

  return { answer: effective };
}

export function renderClarifyRequest(request: ClarifyRequest): string {
  const lines: string[] = [request.question];

  if (request.reason) {
    lines.push(`Reason: ${request.reason}`);
  }

  const options = request.options ?? [];
  if (options.length > 0) {
    lines.push("");
    for (let i = 0; i < options.length; i++) {
      const option = options[i];
      const defaultMarker =
        request.default && option.value === request.default ? " (default)" : "";
      lines.push(`${i + 1}. ${option.label}${defaultMarker}`);
      if (option.description) {
        lines.push(`   ${option.description}`);
      }
    }
  } else if (request.default) {
    lines.push("");
    lines.push(`Default: ${request.default}`);
  }

  return lines.join("\n");
}

function normalizeClarifyResponse(
  response: ClarifyResponse | string,
  request: ClarifyRequest,
): ClarifyResponse {
  if (typeof response === "string") {
    return resolveClarifyAnswer(response, request);
  }

  const answer = response.answer.trim() || request.default || "";
  const resolved = resolveClarifyAnswer(answer, request);
  return {
    answer: resolved.answer,
    selectedOption: response.selectedOption ?? resolved.selectedOption,
    ...(response.timedOut ? { timedOut: true } : {}),
    ...(response.alreadyPending ? { alreadyPending: true } : {}),
  };
}

function readNonEmptyString(
  value: unknown,
  name: string,
): { value: string } | { error: string } {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { error: `${name} must be a non-empty string` };
  }
  return { value: value.trim() };
}
