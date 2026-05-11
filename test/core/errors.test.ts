import { describe, it, expect } from "vitest";
import {
  AwesomeCliError,
  ProviderError,
  RateLimitError,
  AuthError,
  NetworkError,
  ToolExecutionError,
  PermissionDeniedError,
  SessionStoreError,
  CompressorError,
} from "../../src/core/errors.js";

describe("AwesomeCliError", () => {
  it("is an instance of Error", () => {
    const err = new AwesomeCliError("test");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AwesomeCliError);
    expect(err.message).toBe("test");
    expect(err.name).toBe("AwesomeCliError");
  });
});

describe("ProviderError hierarchy", () => {
  it("ProviderError extends AwesomeCliError", () => {
    const err = new ProviderError("provider failed", { status: 500 });
    expect(err).toBeInstanceOf(AwesomeCliError);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.name).toBe("ProviderError");
    expect(err.status).toBe(500);
  });

  it("ProviderError carries contextLengthExceeded flag", () => {
    const err = new ProviderError("context too long", {
      status: 413,
      contextLengthExceeded: true,
    });
    expect(err.contextLengthExceeded).toBe(true);
  });

  it("RateLimitError extends ProviderError with retryAfter", () => {
    const err = new RateLimitError("rate limited", { retryAfter: 30 });
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toBeInstanceOf(AwesomeCliError);
    expect(err.name).toBe("RateLimitError");
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe(30);
  });

  it("AuthError extends ProviderError with status 401", () => {
    const err = new AuthError("invalid key");
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.name).toBe("AuthError");
    expect(err.status).toBe(401);
  });

  it("NetworkError extends ProviderError", () => {
    const err = new NetworkError("connection refused");
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.name).toBe("NetworkError");
    expect(err.status).toBeUndefined();
  });
});

describe("ToolExecutionError", () => {
  it("extends AwesomeCliError with tool name", () => {
    const err = new ToolExecutionError("file_read", "file not found");
    expect(err).toBeInstanceOf(AwesomeCliError);
    expect(err.name).toBe("ToolExecutionError");
    expect(err.toolName).toBe("file_read");
    expect(err.message).toBe("file_read: file not found");
  });
});

describe("PermissionDeniedError", () => {
  it("extends AwesomeCliError with tool name and reason", () => {
    const err = new PermissionDeniedError("shell_exec", "dangerous command");
    expect(err).toBeInstanceOf(AwesomeCliError);
    expect(err.name).toBe("PermissionDeniedError");
    expect(err.toolName).toBe("shell_exec");
    expect(err.reason).toBe("dangerous command");
  });
});

describe("SessionStoreError", () => {
  it("extends AwesomeCliError", () => {
    const err = new SessionStoreError("disk full");
    expect(err).toBeInstanceOf(AwesomeCliError);
    expect(err.name).toBe("SessionStoreError");
  });
});

describe("CompressorError", () => {
  it("extends AwesomeCliError", () => {
    const err = new CompressorError("summarization failed");
    expect(err).toBeInstanceOf(AwesomeCliError);
    expect(err.name).toBe("CompressorError");
  });
});

describe("Error cause chains", () => {
  it("preserves nested cause via options.cause", () => {
    const root = new Error("root cause");
    const provider = new ProviderError("api failed", { status: 500, cause: root });
    const wrapper = new AwesomeCliError("operation failed", { cause: provider });

    expect(wrapper.cause).toBe(provider);
    expect((wrapper.cause as ProviderError).cause).toBe(root);
  });
});
