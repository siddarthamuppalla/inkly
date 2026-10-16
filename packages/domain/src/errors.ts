// The typed error every package throws for expected failures (CLAUDE.md paved road).
// API routes map `status` straight to the HTTP response; `code` is the stable value
// clients and tests match on.

export type AppErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "invalid_input"
  | "limit_exceeded"
  | "rate_limited"
  | "pdf_encrypted"
  | "pdf_malformed"
  | "too_large_for_worker"
  | "conflict"
  | "email_failed"
  | "internal";

const STATUS: Record<AppErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid_input: 422,
  limit_exceeded: 402,
  rate_limited: 429,
  pdf_encrypted: 422,
  pdf_malformed: 422,
  too_large_for_worker: 413,
  conflict: 409,
  email_failed: 502,
  internal: 500,
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;

  constructor(code: AppErrorCode, message: string = code, status: number = STATUS[code]) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
  }

  toJSON(): { error: AppErrorCode; message: string } {
    return { error: this.code, message: this.message };
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
