// The SPA talks to the API over HTTP only (ADR-0002). Errors arrive as
// `{ error, message }` (AppError on the server); ApiError carries them.

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export async function api<T>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set("content-type", "application/json");
  const res = await fetch(path, {
    ...rest,
    headers,
    credentials: "same-origin",
    ...(json !== undefined && { body: JSON.stringify(json) }),
  });
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
    message?: string;
  };
  if (!res.ok) {
    throw new ApiError(
      res.status,
      body.error ?? body.code ?? "error",
      body.message ?? "Something went wrong. Try again.",
    );
  }
  return body as T;
}

export interface TenantSummary {
  readonly id: string;
  readonly name: string;
  readonly plan: "free" | "pro";
  readonly role: string;
}

export interface Me {
  readonly user: { readonly id: string; readonly email: string; readonly name: string };
  readonly activeTenant: TenantSummary | null;
  readonly role: string | null;
  readonly tenants: readonly TenantSummary[];
}

/** The signed-in User, or null when signed out. */
export async function fetchMe(): Promise<Me | null> {
  try {
    return await api<Me>("/api/me");
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong. Try again.";
}
