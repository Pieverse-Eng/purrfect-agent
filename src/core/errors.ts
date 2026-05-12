export class AwesomeCliError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AwesomeCliError";
  }
}

export interface ProviderErrorOptions extends ErrorOptions {
  status?: number;
  contextLengthExceeded?: boolean;
}

export class ProviderError extends AwesomeCliError {
  readonly status?: number;
  readonly contextLengthExceeded: boolean;

  constructor(message: string, options: ProviderErrorOptions = {}) {
    super(message, options);
    this.name = "ProviderError";
    this.status = options.status;
    this.contextLengthExceeded = options.contextLengthExceeded ?? false;
  }
}

export class RateLimitError extends ProviderError {
  readonly retryAfter?: number;

  constructor(
    message: string,
    options: { retryAfter?: number } & ErrorOptions = {},
  ) {
    super(message, { ...options, status: 429 });
    this.name = "RateLimitError";
    this.retryAfter = options.retryAfter;
  }
}

export class AuthError extends ProviderError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, { ...options, status: 401 });
    this.name = "AuthError";
  }
}

export class NetworkError extends ProviderError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NetworkError";
  }
}

export class ToolExecutionError extends AwesomeCliError {
  readonly toolName: string;

  constructor(toolName: string, detail: string, options?: ErrorOptions) {
    super(`${toolName}: ${detail}`, options);
    this.name = "ToolExecutionError";
    this.toolName = toolName;
  }
}

export class PermissionDeniedError extends AwesomeCliError {
  readonly toolName: string;
  readonly reason: string;

  constructor(toolName: string, reason: string, options?: ErrorOptions) {
    super(`Permission denied for ${toolName}: ${reason}`, options);
    this.name = "PermissionDeniedError";
    this.toolName = toolName;
    this.reason = reason;
  }
}

export class SessionStoreError extends AwesomeCliError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionStoreError";
  }
}

export class CompressorError extends AwesomeCliError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CompressorError";
  }
}
