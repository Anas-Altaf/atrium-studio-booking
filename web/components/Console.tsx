"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  API_BASE,
  createHold,
  getBooking,
  health,
  login,
  searchRooms,
  type ApiResult,
  type Room,
  type SessionUser,
} from "@/lib/api";
import RoomTable from "./RoomTable";
import ResponseLog, { type LogLine } from "./ResponseLog";

const ACCOUNTS = [
  { email: "customer@atrium.test", label: "Customer", note: "all venues" },
  { email: "admin.a@atrium.test", label: "Admin A", note: "venue A" },
  { email: "admin.b@atrium.test", label: "Admin B", note: "venue B" },
  { email: "staff@atrium.test", label: "Staff A", note: "venue A" },
  { email: "platform@atrium.test", label: "Platform", note: "unrestricted" },
];

const DEFAULT_PASSWORD = "atrium123";
const SESSION_KEY = "atrium.session";

/** 30-minute granularity, at least an hour ahead — the API enforces both. */
function defaultSlot(): string {
  const t = new Date(Date.now() + 26 * 3_600_000);
  t.setUTCHours(9, 0, 0, 0);
  return new Date(t.getTime() - t.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

export default function Console() {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [email, setEmail] = useState(ACCOUNTS[0].email);
  const [password, setPassword] = useState(DEFAULT_PASSWORD);
  const [busy, setBusy] = useState<string | null>(null);

  const [slot, setSlot] = useState("");
  const [city, setCity] = useState("");
  const [minCapacity, setMinCapacity] = useState("");

  const [rooms, setRooms] = useState<Room[]>([]);
  const [selected, setSelected] = useState<Room | null>(null);
  const [lastBookingId, setLastBookingId] = useState<string | null>(null);

  const [lines, setLines] = useState<LogLine[]>([]);
  const [instance, setInstance] = useState<string | null>(null);

  // Both of these read browser-only state, so they cannot run during the
  // server render without hydrating to a different value.
  useEffect(() => {
    setSlot(defaultSlot());
    const saved = sessionStorage.getItem(SESSION_KEY);
    if (!saved) return;
    try {
      const s = JSON.parse(saved) as { token: string; user: SessionUser };
      setToken(s.token);
      setUser(s.user);
      setEmail(s.user.email);
    } catch {
      sessionStorage.removeItem(SESSION_KEY);
    }
  }, []);

  const record = useCallback(<T,>(label: string, r: ApiResult<T>): ApiResult<T> => {
    setLines((prev) =>
      [
        {
          id: prev.length ? prev[0].id + 1 : 1,
          label,
          status: r.status,
          code: r.error?.error ?? null,
          message: r.error?.message ?? null,
          correlationId: r.correlationId,
          ms: r.ms,
        },
        ...prev,
      ].slice(0, 12),
    );
    return r;
  }, []);

  useEffect(() => {
    health().then((r) => {
      record("GET /health", r);
      if (r.data) {
        setInstance(`${r.data.instance} · ${r.data.migrationsApplied} migrations`);
      }
    });
  }, [record]);

  const slotRange = () => {
    const start = new Date(slot);
    return {
      startAt: start.toISOString(),
      endAt: new Date(start.getTime() + 3_600_000).toISOString(),
    };
  };

  async function signIn(as?: string) {
    const addr = as ?? email;
    setBusy("login");
    if (as) setEmail(as);

    const r = record(`POST /auth/login  ${addr}`, await login(addr, password));
    if (r.ok && r.data) {
      setToken(r.data.token);
      setUser(r.data.user);
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(r.data));
      // The session decides what the next search is allowed to return, so the
      // previous results are stale the moment it changes.
      setRooms([]);
      setSelected(null);
    }
    setBusy(null);
  }

  function signOut() {
    sessionStorage.removeItem(SESSION_KEY);
    setToken(null);
    setUser(null);
    setRooms([]);
    setSelected(null);
  }

  async function doSearch() {
    if (!token) return;
    setBusy("search");
    const { startAt, endAt } = slotRange();
    const r = record(
      "GET /rooms",
      await searchRooms(token, {
        city: city.trim() || undefined,
        minCapacity: minCapacity ? Number(minCapacity) : undefined,
        from: startAt,
        to: endAt,
      }),
    );
    if (r.ok && r.data) {
      setRooms(r.data);
      setSelected(null);
    }
    if (r.status === 401) signOut();
    setBusy(null);
  }

  async function doHold() {
    if (!token || !selected) return;
    setBusy("hold");
    const { startAt, endAt } = slotRange();
    const r = record(
      `POST /bookings/hold  ${selected.name}`,
      await createHold(token, selected.id, startAt, endAt),
    );
    if (r.ok && r.data) setLastBookingId(r.data.id);
    setBusy(null);
  }

  async function doReadLast() {
    if (!token || !lastBookingId) return;
    setBusy("read");
    record(
      `GET /bookings/${lastBookingId.slice(0, 8)}…`,
      await getBooking(token, lastBookingId),
    );
    setBusy(null);
  }

  const venuesVisible = new Set(rooms.map((r) => r.venue_id)).size;
  const input =
    "rounded-md border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/20";
  const primary =
    "rounded-md bg-foreground px-4 py-1.5 text-sm text-background disabled:opacity-40";

  return (
    <div className="flex flex-col gap-5">
      <Card step="1" title="Sign in" hint="The seed creates five accounts, all with the password atrium123.">
        {user ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm">
              <strong>{user.email}</strong>{" "}
              <span className="opacity-60">· {user.role} ·</span>{" "}
              {user.venueId ? (
                <span className="opacity-70">
                  confined to venue{" "}
                  <code className="font-mono text-xs">{user.venueId.slice(0, 8)}</code>
                </span>
              ) : (
                <span className="opacity-70">no venue restriction</span>
              )}
            </p>
            <button
              onClick={signOut}
              className="ml-auto rounded-md border border-black/15 px-3 py-1.5 text-sm dark:border-white/20"
            >
              Sign out
            </button>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Email">
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="username"
                  className={`w-60 ${input}`}
                />
              </Field>
              <Field label="Password">
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  className={`w-40 ${input}`}
                />
              </Field>
              <button onClick={() => signIn()} disabled={busy !== null} className={primary}>
                {busy === "login" ? "Signing in…" : "Sign in"}
              </button>
            </div>
            <p className="mt-3 mb-1.5 text-xs opacity-60">Or sign in directly as:</p>
            <div className="flex flex-wrap gap-2">
              {ACCOUNTS.map((a) => (
                <button
                  key={a.email}
                  onClick={() => signIn(a.email)}
                  disabled={busy !== null}
                  className="rounded-md border border-black/15 px-3 py-1.5 text-sm transition hover:bg-black/[0.04] disabled:opacity-40 dark:border-white/20 dark:hover:bg-white/[0.06]"
                >
                  {a.label}
                  <span className="ml-1.5 opacity-50">{a.note}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </Card>

      <Card step="2" title="Find a room" hint="Availability is filtered for the one-hour slot below.">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Start">
            <input
              type="datetime-local"
              step={1800}
              value={slot}
              onChange={(e) => setSlot(e.target.value)}
              className={`w-56 ${input}`}
            />
          </Field>
          <Field label="City">
            <input
              value={city}
              onChange={(e) => setCity(e.target.value)}
              placeholder="any"
              className={`w-32 ${input}`}
            />
          </Field>
          <Field label="Min capacity">
            <input
              type="number"
              min={1}
              value={minCapacity}
              onChange={(e) => setMinCapacity(e.target.value)}
              placeholder="any"
              className={`w-24 ${input}`}
            />
          </Field>
          <button onClick={doSearch} disabled={!token || busy !== null} className={primary}>
            {busy === "search" ? "Searching…" : "Search"}
          </button>
        </div>

        {rooms.length > 0 && (
          <p className="mt-3 text-sm opacity-70">
            {rooms.length} room{rooms.length === 1 ? "" : "s"} across{" "}
            <strong>
              {venuesVisible} venue{venuesVisible === 1 ? "" : "s"}
            </strong>
            {user?.venueId
              ? " — a venue admin never sees more than one."
              : " — a customer searches the whole platform."}
          </p>
        )}

        <div className="mt-3">
          <RoomTable rooms={rooms} selectedId={selected?.id ?? null} onSelect={setSelected} />
        </div>
      </Card>

      <Card
        step="3"
        title="Hold it, then hold it again"
        hint="The second attempt on the same room and slot is the room exclusion constraint refusing to double book."
      >
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={doHold} disabled={!selected || busy !== null} className={primary}>
            {busy === "hold" ? "Holding…" : selected ? `Hold ${selected.name}` : "Select a room first"}
          </button>
          <button
            onClick={doReadLast}
            disabled={!lastBookingId || busy !== null}
            className="rounded-md border border-black/15 px-4 py-1.5 text-sm disabled:opacity-40 dark:border-white/20"
          >
            Read the last booking by id
          </button>
        </div>

        {lastBookingId && (
          <p className="mt-3 text-sm opacity-70">
            Last booking <code className="font-mono text-xs">{lastBookingId.slice(0, 8)}…</code> —
            now sign in as a different venue admin and press{" "}
            <em>Read the last booking by id</em>. The id is real and the booking exists; the answer
            is still <strong>404</strong>, because a 403 would confirm that it does.
          </p>
        )}
      </Card>

      <Card step="4" title="What the API said" hint={`${API_BASE}${instance ? ` · ${instance}` : ""}`}>
        <ResponseLog lines={lines} />
      </Card>
    </div>
  );
}

function Card({
  step,
  title,
  hint,
  children,
}: {
  step: string;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-black/10 p-4 dark:border-white/15">
      <div className="mb-3">
        <h2 className="text-sm font-semibold">
          <span className="mr-2 opacity-40">{step}</span>
          {title}
        </h2>
        {hint && <p className="mt-0.5 text-xs opacity-60">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs opacity-60">{label}</span>
      {children}
    </label>
  );
}
