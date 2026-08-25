"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { explain } from "@/lib/api";
import { homeFor } from "@/components/nav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const DEMO = [
  ["customer@atrium.test", "Customer"],
  ["staff@atrium.test", "Venue staff"],
  ["admin.a@atrium.test", "Venue admin A"],
  ["admin.b@atrium.test", "Venue admin B"],
  ["platform@atrium.test", "Platform admin"],
] as const;

export default function LoginPage() {
  const { signIn, profile } = useAuth();
  const router = useRouter();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (profile) router.replace(homeFor(profile.role));
  }, [profile, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signIn(email, password);
    } catch (err) {
      setError(explain(err));
      setBusy(false);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Four roles, one API. What you see is decided server-side.
      </p>

      <form onSubmit={submit} className="mt-8 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>

        {error && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <Button type="submit" className="w-full" loading={busy}>
          Sign in
        </Button>
      </form>

      <div className="mt-6">
        <p className="mb-2 text-xs uppercase tracking-wider text-muted-foreground">
          Or use a test login
        </p>
        <div className="flex flex-wrap gap-1.5">
          {DEMO.map(([addr, label]) => (
            <button
              key={addr}
              type="button"
              onClick={() => {
                setEmail(addr);
                setPassword("atrium123");
              }}
              className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <p className="mt-8 text-sm text-muted-foreground">
        No account?{" "}
        <Link href="/register" className="text-primary hover:underline">
          Create one
        </Link>
      </p>
    </div>
  );
}
