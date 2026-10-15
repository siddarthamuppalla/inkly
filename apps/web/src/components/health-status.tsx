import { useEffect, useState } from "react";

import { cn } from "../lib/cn.ts";

type Health = "checking" | "ok" | "degraded";

const DOT: Record<Health, string> = {
  checking: "bg-muted-foreground",
  ok: "bg-success",
  degraded: "bg-destructive",
};

export function HealthStatus() {
  const [health, setHealth] = useState<Health>("checking");

  useEffect(() => {
    let cancelled = false;
    fetch("/health")
      .then((r) => {
        if (!cancelled) setHealth(r.ok ? "ok" : "degraded");
      })
      .catch(() => {
        if (!cancelled) setHealth("degraded");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <p
      data-testid="api-health"
      role="status"
      className="flex items-center gap-2 text-muted-foreground"
    >
      <span aria-hidden="true" className={cn("size-2 rounded-full", DOT[health])} />
      API: {health}
    </p>
  );
}
