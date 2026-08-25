import * as React from "react";
import { cn } from "@/lib/utils";

type Div = React.HTMLAttributes<HTMLDivElement>;

export const Card = ({ className, ...p }: Div) => (
  <div
    className={cn("rounded-lg border bg-card text-card-foreground", className)}
    {...p}
  />
);

export const CardHeader = ({ className, ...p }: Div) => (
  <div className={cn("flex flex-col gap-1 p-5", className)} {...p} />
);

export const CardTitle = ({ className, ...p }: Div) => (
  <h3 className={cn("font-semibold leading-none tracking-tight", className)} {...p} />
);

export const CardDescription = ({ className, ...p }: Div) => (
  <p className={cn("text-sm text-muted-foreground", className)} {...p} />
);

export const CardContent = ({ className, ...p }: Div) => (
  <div className={cn("p-5 pt-0", className)} {...p} />
);

export const CardFooter = ({ className, ...p }: Div) => (
  <div className={cn("flex items-center p-5 pt-0", className)} {...p} />
);
