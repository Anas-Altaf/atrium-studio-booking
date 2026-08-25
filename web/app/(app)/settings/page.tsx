"use client";

import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTheme } from "next-themes";
import { auth, explain } from "@/lib/api";
import { useProfile, useAuth } from "@/lib/auth-context";
import { ROLE_LABEL } from "@/components/nav";
import { Field, PageHeader } from "@/components/atoms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/misc";

export default function SettingsPage() {
  const profile = useProfile();
  const { signOut } = useAuth();
  const { theme, setTheme } = useTheme();

  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");

  const change = useMutation({
    mutationFn: () => auth.changePassword(current, next),
    onSuccess: () => {
      toast.success("Password changed.");
      setCurrent("");
      setNext("");
      setConfirm("");
    },
    onError: (err) => toast.error(explain(err)),
  });

  const mismatch = confirm.length > 0 && next !== confirm;

  return (
    <>
      <PageHeader
        title="Settings"
        description="Your account, and how this app looks."
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Account</CardTitle>
            <CardDescription>
              Your role and venue come from the token, not from this page.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-4 sm:grid-cols-2">
              <Field label="Email">{profile.email}</Field>
              <Field label="Role">{ROLE_LABEL[profile.role]}</Field>
              <Field label="Venue">{profile.venueName ?? "—"}</Field>
              <Field label="User id">
                <span className="font-mono text-xs">{profile.userId}</span>
              </Field>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Appearance</CardTitle>
            <CardDescription>Stored in this browser only.</CardDescription>
          </CardHeader>
          <CardContent className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Dark theme</p>
              <p className="text-sm text-muted-foreground">
                Both palettes are the same tokens.
              </p>
            </div>
            <Switch
              checked={theme === "dark"}
              onCheckedChange={(on) => setTheme(on ? "dark" : "light")}
              aria-label="Dark theme"
            />
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Change password</CardTitle>
            <CardDescription>
              The current password is required — a stolen session cannot lock you
              out of your own account.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="grid max-w-xl gap-4 sm:grid-cols-3"
              onSubmit={(e) => {
                e.preventDefault();
                change.mutate();
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor="current">Current</Label>
                <Input
                  id="current"
                  type="password"
                  autoComplete="current-password"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="next">New</Label>
                <Input
                  id="next"
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  value={next}
                  onChange={(e) => setNext(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="confirm">Repeat</Label>
                <Input
                  id="confirm"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                />
              </div>

              <div className="sm:col-span-3">
                {mismatch && (
                  <p className="mb-3 text-sm text-destructive">
                    The two new passwords do not match.
                  </p>
                )}
                <Button
                  type="submit"
                  loading={change.isPending}
                  disabled={mismatch || next.length < 8}
                >
                  Change password
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Session</CardTitle>
            <CardDescription>
              Signing out clears the token and every cached response.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={signOut}>
              Sign out
            </Button>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
