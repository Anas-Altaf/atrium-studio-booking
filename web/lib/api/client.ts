/**
 * The only place `fetch` appears.
 *
 * The API authenticates with a bearer token and runs CORS with credentials off,
 * so there is no cookie to set and no reason to proxy through a route handler.
 * The token lives in localStorage; the trade-off is written down in the README.
 */

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080";

const TOKEN_KEY = "atrium.token";

export const tokenStore = {
  get: () => (typeof window === "undefined" ? null : localStorage.getItem(TOKEN_KEY)),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

/**
 * The API's error shape, kept whole.
 *
 * `correlationId` is on every response, and the same id is on the server log
 * line that produced it — so it belongs in the message the user is shown, not
 * swallowed.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly correlationId?: string,
    readonly issues?: unknown[],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Fired when a request comes back 401, so the session can be torn down once. */
export const onUnauthorized = { handler: null as null | (() => void) };

interface Options {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  /** Login and register run before there is a token. */
  anonymous?: boolean;
  signal?: AbortSignal;
}

export interface Envelope<T> {
  status: number;
  body: T;
}

export async function request<T>(path: string, opts: Options = {}): Promise<T> {
  return (await requestRaw<T>(path, opts)).body;
}

/**
 * The status as well as the body. `POST /bookings/:id/pay` answers 202 when it
 * created the charge and 200 when one already existed, and both are success —
 * so that call is the one place the status carries meaning.
 */
export async function requestRaw<T>(
  path: string,
  opts: Options = {},
): Promise<Envelope<T>> {
  const headers: Record<string, string> = {
    "x-correlation-id": correlationId(),
  };
  if (opts.body !== undefined) headers["content-type"] = "application/json";

  if (!opts.anonymous) {
    const token = tokenStore.get();
    if (token) headers.authorization = `Bearer ${token}`;
  }

  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch {
    // Render's free tier sleeps after 15 minutes and takes 30 to 60 seconds to
    // wake, which reaches here as a network failure rather than a status.
    throw new ApiError(0, "NETWORK", "The API did not answer. It may be waking up.");
  }

  if (res.status === 401 && !opts.anonymous) {
    tokenStore.clear();
    onUnauthorized.handler?.();
  }

  const payload = await res.json().catch(() => null);

  if (!res.ok) {
    const body = (payload ?? {}) as {
      error?: string;
      message?: string;
      issues?: unknown[];
      correlationId?: string;
    };
    throw new ApiError(
      res.status,
      body.error ?? "UNKNOWN",
      body.message ?? messageFor(res.status, body.error),
      body.correlationId,
      body.issues,
    );
  }

  return { status: res.status, body: payload as T };
}

const correlationId = () =>
  `web-${(globalThis.crypto?.randomUUID?.() ?? String(Date.now())).slice(0, 24)}`;

function messageFor(status: number, code?: string) {
  if (status === 401) return "Sign in again.";
  if (status === 403) return "Your role does not allow that.";
  if (status === 404) return "Not found.";
  if (status === 503) return "The service is not ready.";
  return code ? `Request failed (${code}).` : "Request failed.";
}

/** What a 409 means, per code. Every one of these is a normal outcome, not a fault. */
export const CONFLICT_COPY: Record<string, string> = {
  ROOM_UNAVAILABLE: "Someone took that slot first. Pick another time.",
  EQUIPMENT_UNAVAILABLE: "Not enough units free for that interval.",
  NOT_HELD: "This booking has moved on. Reload it.",
  NOT_PAYABLE: "This booking is no longer awaiting payment.",
  NOT_CANCELLABLE: "This booking can no longer be cancelled.",
  HOLD_EXPIRED: "That hold ran out. Take the slot again.",
  ALREADY_CHARGED: "A payment is already in flight for this booking.",
  ALREADY_REFUNDED: "A refund already exists for this booking.",
  ILLEGAL_TRANSITION: "That action no longer applies to this booking.",
  CONTENTION: "That slot is busy right now. Try again.",
  UNITS_COMMITTED: "Future bookings already hold more units than that.",
  OUTSIDE_OPERATING_HOURS: "The venue is closed at that time.",
  UNKNOWN_EQUIPMENT: "That equipment does not belong to this venue.",
};

export const explain = (err: unknown): string => {
  if (!(err instanceof ApiError)) return "Something went wrong.";
  return CONFLICT_COPY[err.code] ?? err.message;
};
