"use client";

import * as React from "react";
import { useRouter, usePathname } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { auth, onUnauthorized, tokenStore, type Profile } from "./api";

interface AuthState {
  profile: Profile | null;
  /** True until the first `GET /auth/me` settles, so the shell does not flash. */
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => void;
  refresh: () => Promise<void>;
}

const Ctx = React.createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [profile, setProfile] = React.useState<Profile | null>(null);
  const [loading, setLoading] = React.useState(true);
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();

  const clear = React.useCallback(() => {
    tokenStore.clear();
    setProfile(null);
    queryClient.clear();
  }, [queryClient]);

  const load = React.useCallback(async () => {
    if (!tokenStore.get()) {
      setProfile(null);
      setLoading(false);
      return;
    }
    try {
      setProfile(await auth.me());
    } catch {
      // A token that no longer verifies is the same as no token.
      clear();
    } finally {
      setLoading(false);
    }
  }, [clear]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Any 401 from anywhere tears the session down once, rather than each caller
  // deciding what a 401 means.
  React.useEffect(() => {
    onUnauthorized.handler = () => {
      clear();
      if (!pathname.startsWith("/login")) router.replace("/login");
    };
    return () => {
      onUnauthorized.handler = null;
    };
  }, [clear, pathname, router]);

  const enter = React.useCallback(
    async (token: string) => {
      tokenStore.set(token);
      setProfile(await auth.me());
      setLoading(false);
    },
    [],
  );

  const value: AuthState = {
    profile,
    loading,
    signIn: async (email, password) => enter((await auth.login(email, password)).token),
    signUp: async (email, password) => enter((await auth.register(email, password)).token),
    signOut: () => {
      clear();
      router.replace("/login");
    },
    refresh: load,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}

/** The profile, once the shell has guaranteed there is one. */
export function useProfile(): Profile {
  const { profile } = useAuth();
  if (!profile) throw new Error("useProfile outside an authenticated route");
  return profile;
}
