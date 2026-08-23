# web

The frontend for Atrium. Next.js App Router, TypeScript, Tailwind. No other
dependencies — everything talks to the API with `fetch`.

It is a demo surface, not a product. It exists to make three things visible in a
browser:

- authorisation is enforced by the API, not by hiding buttons
- a venue admin cannot read another venue's booking even holding its real UUID
- a second hold on the same room and slot is refused by the database

## Running it

```bash
npm install
npm run dev
```

Point it at an API:

```bash
cp .env.example .env.local
```

| Variable | What it is |
|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | Origin of the Atrium API. `http://localhost:8080` for the local `docker compose` stack |

`NEXT_PUBLIC_` is required: the value is read in the browser, so it is baked
into the client bundle at build time. It is an origin, not a secret — the JWT
never leaves the browser's `sessionStorage` and no key is shipped here.

## The API has to allow this origin

The API refuses cross-origin requests from anywhere not named in its own
`CORS_ORIGINS`. Whatever origin this app is served from must appear there, or
every call fails in the browser while `curl` keeps working.

## Layout

```
app/page.tsx        static shell
components/Console  the whole interactive surface (one client component)
lib/api.ts          typed API client; returns status, error code and correlation id
```

The session is a bearer token held in `sessionStorage`, so there is no server
session to keep and nothing to proxy through a route handler.
