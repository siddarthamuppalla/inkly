import { useEffect, useState } from "react";

type Health = "checking" | "ok" | "degraded";

export function App() {
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
    <main data-testid="app-shell">
      <h1>Inkly</h1>
      <p data-testid="api-health">API: {health}</p>
    </main>
  );
}
