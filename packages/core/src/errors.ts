export type ErrorCode =
  | "validation_failed"
  | "unauthorized"
  | "invalid_credentials"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "internal";

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const errors = {
  validation: (message = "Request validation failed.", details?: unknown) =>
    new AppError(400, "validation_failed", message, details),
  unauthorized: () =>
    new AppError(401, "unauthorized", "Authentication is required."),
  invalidCredentials: () =>
    new AppError(401, "invalid_credentials", "Email or password is incorrect."),
  forbidden: (message = "You do not have permission to perform this action.") =>
    new AppError(403, "forbidden", message),
  notFound: (message = "The requested resource was not found.") =>
    new AppError(404, "not_found", message),
  conflict: (message: string) => new AppError(409, "conflict", message),
  rateLimited: (retryAfter: number) =>
    new AppError(429, "rate_limited", "Too many requests.", {
      retry_after: retryAfter,
    }),
  // The 1 MB body cap surfaces 413 with the canonical validation_failed code
  // (specs/phase-0.md); payload_too_large is not part of the error contract.
  payloadTooLarge: () =>
    new AppError(413, "validation_failed", "The request body is too large."),
  internal: (message = "An internal error occurred.") =>
    new AppError(500, "internal", message),
};
