"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useProfile } from "@/lib/auth-context";
import { homeFor } from "@/components/nav";

/** The shell has already guaranteed a profile; this only routes on it. */
export default function Home() {
  const profile = useProfile();
  const router = useRouter();

  React.useEffect(() => {
    router.replace(homeFor(profile.role));
  }, [profile.role, router]);

  return null;
}
