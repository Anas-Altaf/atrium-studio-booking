/**
 * Client for the Atrium API.
 *
 * Everything here runs in the browser. The API is on a different origin and
 * authenticates with a bearer token, so there is no server-side session to
 * keep and no reason to proxy through a route handler.
 */

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080";

export type Role =
  | "CUSTOMER"
  | "VENUE_STAFF"
  | "VENUE_ADMIN"
  | "PLATFORM_ADMIN";

export interface SessionUser {
  id: string;
  email: string;
  role: Role;
  venueId: string | null;
}

export interface Room {
  id: string;
  venue_id: string;
  name: string;
  city: string;
  capacity: number;
  hourly_rate_minor: number;
  amenities: string[];
}

export interface Booking {
  id: string;
  venue_id: string;
  room_id: string;
  status: string;
  start_at: string;
  end_at: string;
  expires_at: string | null;
  total_minor: number;
}

/** What the API returns when it refuses. `error` is the machine-readable code. */
export interface ApiErrorBody {
  error: string;
  message?: string;
  issues?: unknown[];
  correlationId?: string;
}

export interface ApiResult<T> {
  status: number;
  ok: boolean;
  data: T | null;
  error: ApiErrorBody | null;
  /** Echoed by the API on every response, so a failure can be traced in the logs. */
  correlationId: string | null;
  ms: number;
}

async function call<T>(
  path: string,
  init: RequestInit = {},
  token?: string | null,
): Promise<ApiResult<T>> {
  const started = performance.now();
  let res: Response;

  try {
    res = await fetch(API_BASE + path, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    // A CORS rejection or a sleeping free-tier instance both land here, and the
    // browser deliberately does not say which. Worth naming rather than showing
    // a bare "failed to fetch".
    return {
      status: 0,
      ok: false,
      data: null,
      error: {
        error: "NETWORK",
        message:
          "No response. The API may be asleep (free tier, 30-60s cold start) or this origin may not be in CORS_ORIGINS.",
      },
      correlationId: null,
      ms: Math.round(performance.now() - started),
    };
  }

  const ms = Math.round(performance.now() - started);
  const correlationId = res.headers.get("x-correlation-id");
  const body = await res.json().catch(() => null);

  return res.ok
    ? { status: res.status, ok: true, data: body as T, error: null, correlationId, ms }
    : {
        status: res.status,
        ok: false,
        data: null,
        error: (body as ApiErrorBody) ?? { error: "UNKNOWN" },
        correlationId: body?.correlationId ?? correlationId,
        ms,
      };
}

export const login = (email: string, password: string) =>
  call<{ token: string; user: SessionUser }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });

export interface RoomQuery {
  city?: string;
  minCapacity?: number;
  from?: string;
  to?: string;
}

export function searchRooms(token: string, q: RoomQuery) {
  const params = new URLSearchParams({ limit: "40" });
  if (q.city) params.set("city", q.city);
  if (q.minCapacity) params.set("minCapacity", String(q.minCapacity));
  if (q.from && q.to) {
    params.set("from", q.from);
    params.set("to", q.to);
  }
  return call<Room[]>(`/rooms?${params}`, {}, token);
}

export const createHold = (
  token: string,
  roomId: string,
  startAt: string,
  endAt: string,
) =>
  call<Booking>(
    "/bookings/hold",
    {
      method: "POST",
      body: JSON.stringify({ roomId, startAt, endAt, equipment: [] }),
    },
    token,
  );

export const getBooking = (token: string, id: string) =>
  call<Booking>(`/bookings/${id}`, {}, token);

export const health = () =>
  call<{
    status: string;
    instance: string;
    database: string;
    migrationsApplied: number;
  }>("/health");
