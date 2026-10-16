/** One API route as the Worker reports it at `GET /__test/routes` (Hono path syntax). */
export interface ApiRoute {
  readonly method: string;
  readonly path: string;
}

/** One response a journey's browser context saw from the target. */
export interface SeenRequest {
  readonly method: string;
  readonly path: string;
  readonly status: number;
}

export interface RouteCoverage {
  readonly route: ApiRoute;
  /** Successful (2xx or 3xx) requests that matched the route. */
  readonly hits: number;
  /** Journeys that made at least one of those requests. */
  readonly journeys: readonly string[];
}

/** `/api/documents/:id/versions/:n` → a regex for one path segment per param; `*` matches the rest. */
function pattern(path: string): RegExp {
  const body = path
    .split("/")
    .map((seg) =>
      seg === "*"
        ? ".*"
        : seg.startsWith(":")
          ? "[^/]+"
          : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("/");
  return new RegExp(`^${body}/?$`);
}

/**
 * For each route, the successful requests that reached it. A route with no hits is a feature
 * no journey proved works end to end.
 */
export function routeCoverage(
  routes: readonly ApiRoute[],
  seen: ReadonlyMap<string, readonly SeenRequest[]>,
): RouteCoverage[] {
  const compiled = routes.map((route) => ({ route, re: pattern(route.path) }));
  const hits = new Map(routes.map((r) => [r, { hits: 0, journeys: new Set<string>() }]));
  for (const [journey, requests] of seen) {
    for (const req of requests) {
      if (req.status < 200 || req.status >= 400) continue;
      const match = compiled.find(
        ({ route, re }) => route.method === req.method && re.test(req.path),
      );
      const entry = match && hits.get(match.route);
      if (!entry) continue;
      entry.hits += 1;
      entry.journeys.add(journey);
    }
  }
  return routes.map((route) => {
    const { hits: n, journeys } = hits.get(route) ?? { hits: 0, journeys: new Set<string>() };
    return { route, hits: n, journeys: [...journeys].sort() };
  });
}
