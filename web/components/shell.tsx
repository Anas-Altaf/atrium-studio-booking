"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  ChevronDown,
  LogOut,
  Menu,
  Moon,
  Sun,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import { initials } from "@/lib/format";
import { navFor, ROLE_LABEL, type NavItem } from "./nav";
import { VenueSwitcher } from "./venue-switcher";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/misc";

const SECTIONS = ["Book", "Venue", "Platform", "Account"] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const { profile, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    if (!loading && !profile) router.replace("/login");
  }, [loading, profile, router]);

  React.useEffect(() => setOpen(false), [pathname]);

  if (loading) return <BootScreen />;
  if (!profile) return null;

  const items = navFor(profile.role);

  return (
    <div className="flex min-h-screen">
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 w-64 shrink-0 border-r bg-card transition-transform lg:static lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-14 items-center justify-between border-b px-5">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="grid size-6 place-items-center rounded bg-primary text-xs font-bold text-primary-foreground">
              A
            </span>
            Atrium
          </Link>
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setOpen(false)}
            aria-label="Close menu"
          >
            <X />
          </Button>
        </div>

        <nav className="flex flex-col gap-5 overflow-y-auto p-3">
          {SECTIONS.map((section) => {
            const group = items.filter((i) => i.section === section);
            if (!group.length) return null;
            return (
              <div key={section}>
                <p className="px-2 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {section}
                </p>
                <div className="flex flex-col gap-0.5">
                  {group.map((item) => (
                    <NavLink key={item.href} item={item} pathname={pathname} />
                  ))}
                </div>
              </div>
            );
          })}
        </nav>
      </aside>

      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
          onClick={() => setOpen(false)}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onMenu={() => setOpen(true)} />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}

function NavLink({ item, pathname }: { item: NavItem; pathname: string }) {
  // `/console` must not light up on `/console/rooms`; everything else is a prefix.
  const active =
    item.href === "/console" || item.href === "/"
      ? pathname === item.href
      : pathname.startsWith(item.href);

  return (
    <Link
      href={item.href}
      className={cn(
        "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors",
        active
          ? "bg-primary/12 font-medium text-primary"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <item.icon className="size-4 shrink-0" />
      {item.label}
    </Link>
  );
}

function Topbar({ onMenu }: { onMenu: () => void }) {
  const { profile, signOut } = useAuth();
  const { theme, setTheme } = useTheme();
  const [menu, setMenu] = React.useState(false);

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur sm:px-6 lg:px-8">
      <Button variant="ghost" size="icon" className="lg:hidden" onClick={onMenu} aria-label="Menu">
        <Menu />
      </Button>

      <div className="flex min-w-0 flex-1 items-center gap-3">
        {profile?.venueName ? (
          <p className="truncate text-sm font-medium">{profile.venueName}</p>
        ) : (
          <p className="truncate text-sm text-muted-foreground">
            {profile ? ROLE_LABEL[profile.role] : ""}
          </p>
        )}
        <VenueSwitcher />
      </div>

      <Button
        variant="ghost"
        size="icon"
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        aria-label="Toggle theme"
      >
        <Sun className="hidden dark:block" />
        <Moon className="dark:hidden" />
      </Button>

      <div className="relative">
        <button
          onClick={() => setMenu((v) => !v)}
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
        >
          <span className="grid size-7 place-items-center rounded-full bg-primary/15 text-xs font-medium text-primary">
            {profile ? initials(profile.email) : "--"}
          </span>
          <ChevronDown className="size-3.5 opacity-60" />
        </button>

        {menu && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
            <div className="absolute right-0 z-20 mt-1 w-60 animate-in-soft rounded-md border bg-popover p-1 shadow-md">
              <div className="border-b px-3 py-2">
                <p className="truncate text-sm font-medium">{profile?.email}</p>
                <p className="text-xs text-muted-foreground">
                  {profile ? ROLE_LABEL[profile.role] : ""}
                </p>
              </div>
              <Link
                href="/settings"
                onClick={() => setMenu(false)}
                className="block rounded-sm px-3 py-2 text-sm hover:bg-accent"
              >
                Settings
              </Link>
              <button
                onClick={signOut}
                className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-left text-sm text-destructive hover:bg-accent"
              >
                <LogOut className="size-4" />
                Sign out
              </button>
            </div>
          </>
        )}
      </div>
    </header>
  );
}

/**
 * The free tier sleeps after fifteen minutes and takes up to a minute to wake,
 * so the first load says what is happening rather than showing an empty frame.
 */
function BootScreen() {
  const [slow, setSlow] = React.useState(false);
  React.useEffect(() => {
    const t = setTimeout(() => setSlow(true), 2500);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="flex min-h-screen">
      <div className="hidden w-64 border-r bg-card p-3 lg:block">
        <Skeleton className="mb-6 h-8 w-32" />
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="mb-2 h-8 w-full" />
        ))}
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8">
        <Skeleton className="h-8 w-56" />
        {slow && (
          <p className="text-sm text-muted-foreground">
            Waking the API. The free tier sleeps after fifteen minutes.
          </p>
        )}
      </div>
    </div>
  );
}
