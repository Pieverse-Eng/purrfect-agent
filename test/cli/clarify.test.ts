import { describe, expect, it } from "vitest";
import {
  formatClarifyPrompt,
  parseClarifyAnswer,
} from "../../src/cli/clarify.js";
import type { ClarifyRequest } from "../../src/core/tools/clarify.js";

const request: ClarifyRequest = {
  question: "Which environment should I use?",
  reason: "The target was not provided.",
  default: "dev",
  options: [
    {
      value: "dev",
      label: "Development",
      description: "Fast feedback, lower risk.",
    },
    {
      value: "prod",
      label: "Production",
      description: "Deploy to real users.",
    },
  ],
};

describe("CLI clarify helpers", () => {
  it("formats a numbered prompt with reason, descriptions, and default marker", () => {
    const prompt = formatClarifyPrompt(request);

    expect(prompt).toContain("Which environment should I use?");
    expect(prompt).toContain("The target was not provided.");
    expect(prompt).toContain("1. Development");
    expect(prompt).toContain("Fast feedback, lower risk.");
    expect(prompt).toContain("default");
  });

  it("maps numeric answers to option values", () => {
    expect(parseClarifyAnswer("2", request)).toEqual({
      answer: "prod",
      selectedOption: request.options![1],
    });
  });

  it("uses the default when the user submits an empty answer", () => {
    expect(parseClarifyAnswer("", request)).toEqual({
      answer: "dev",
      selectedOption: request.options![0],
    });
  });

  it("passes free-form answers through when no option matches", () => {
    expect(parseClarifyAnswer("use qa instead", request)).toEqual({
      answer: "use qa instead",
    });
  });
});
