import { describe, expect, it, vi } from "vitest";
import { createClarifyTool } from "../../../src/core/tools/clarify.js";

describe("clarify tool", () => {
  it("asks through the supplied runtime handler and returns the answer", async () => {
    const askClarification = vi.fn().mockResolvedValue({
      answer: "staging",
      selectedOption: {
        value: "staging",
        label: "Staging",
        description: "Use the staging environment.",
      },
    });
    const tool = createClarifyTool({ askClarification });

    const result = JSON.parse(
      await tool.handler({
        question: "Which environment should I deploy to?",
        options: [
          {
            value: "dev",
            label: "Development",
            description: "Use the development environment.",
          },
          {
            value: "staging",
            label: "Staging",
            description: "Use the staging environment.",
          },
        ],
        default: "dev",
        reason: "Deployment target is missing.",
      }),
    );

    expect(askClarification).toHaveBeenCalledWith({
      question: "Which environment should I deploy to?",
      options: [
        {
          value: "dev",
          label: "Development",
          description: "Use the development environment.",
        },
        {
          value: "staging",
          label: "Staging",
          description: "Use the staging environment.",
        },
      ],
      default: "dev",
      reason: "Deployment target is missing.",
    });
    expect(result).toEqual({
      success: true,
      question: "Which environment should I deploy to?",
      answer: "staging",
      selectedOption: {
        value: "staging",
        label: "Staging",
        description: "Use the staging environment.",
      },
    });
  });

  it("returns validation errors for missing question and malformed options", async () => {
    const tool = createClarifyTool({
      askClarification: vi.fn().mockResolvedValue({ answer: "unused" }),
    });

    const missingQuestion = JSON.parse(await tool.handler({ question: "" }));
    expect(missingQuestion.error).toContain("question");

    const badOption = JSON.parse(
      await tool.handler({
        question: "Pick one?",
        options: [{ value: "", label: "Empty value" }],
      }),
    );
    expect(badOption.error).toContain("options[0].value");
  });

  it("returns an unavailable error when no runtime handler is configured", async () => {
    const tool = createClarifyTool();

    const result = JSON.parse(
      await tool.handler({ question: "What should I do next?" }),
    );

    expect(result.error).toContain("not available");
  });

  it("exposes the issue 78 parameter shape in the function schema", () => {
    const tool = createClarifyTool();
    const parameters = tool.schema.function.parameters as {
      properties: Record<string, unknown>;
      required: string[];
    };

    expect(parameters.required).toEqual(["question"]);
    expect(parameters.properties).toHaveProperty("question");
    expect(parameters.properties).toHaveProperty("options");
    expect(parameters.properties).toHaveProperty("default");
    expect(parameters.properties).toHaveProperty("reason");
  });
});
