"use client";

import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";
import { AuthProvider } from "@/lib/auth-context";
import { VenueProvider } from "@/lib/venue-context";
import { ApiError } from "@/lib/api";

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            refetchOnWindowFocus: false,
            retry: (count, error) => {
              // A 4xx is an answer, not a failure to reach the server. Only a
              // network error or a 5xx is worth asking again.
              if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
                return false;
              }
              return count < 2;
            },
          },
          mutations: { retry: false },
        },
      }),
  );

  return (
    <QueryClientProvider client={client}>
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
        <AuthProvider>
          <VenueProvider>
            {children}
            <Toaster position="top-right" richColors closeButton />
          </VenueProvider>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
