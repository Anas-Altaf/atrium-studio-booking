import Console from "@/components/Console";

/**
 * A demo surface over the API, not a product. It exists to make three things
 * visible in a browser: that authorisation is enforced server-side, that a
 * venue admin cannot reach another venue's data even with a real id, and that
 * a second hold on the same slot is refused by the database rather than by a
 * check in application code.
 *
 * The page itself is static; everything interactive lives in one client
 * component, because the session is a bearer token held in the browser.
 */
export default function Home() {
  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-10">
      <header className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight">Atrium</h1>
        <p className="mt-1 text-sm opacity-70">
          Studio booking. Rooms never overlap and equipment never oversells —
          both enforced inside PostgreSQL, so the guarantees hold across
          replicas rather than within one process.
        </p>
      </header>

      <Console />

      <footer className="mt-10 border-t border-black/10 pt-4 text-xs opacity-50 dark:border-white/15">
        The concurrency proof — 200 concurrent requests against three replicas —
        runs against the local <code className="font-mono">docker compose</code>{" "}
        stack, not here. This instance is a single process; correctness does not
        depend on replica count.
      </footer>
    </main>
  );
}
