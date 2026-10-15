import { useEffect, useRef } from "react";
import { NavLink, Outlet, useLocation } from "react-router";

import { cn } from "../lib/cn.ts";
import { useMe } from "../lib/session.ts";
import { Wordmark } from "./brand/wordmark.tsx";
import { HealthStatus } from "./health-status.tsx";
import { UserMenu } from "./user-menu.tsx";

const NAV = [
  { to: "/", label: "Documents" },
  { to: "/envelopes", label: "Envelopes" },
  { to: "/links", label: "Share links" },
  { to: "/members", label: "Members" },
] as const;

export function AppShell() {
  const main = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  const firstRender = useRef(true);
  const me = useMe();

  // After client-side navigation, move focus to the new page so screen readers announce it.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    main.current?.querySelector<HTMLElement>("h1")?.focus();
  }, [pathname]);

  return (
    <div data-testid="app-shell" className="min-h-dvh md:grid md:grid-cols-[15rem_1fr]">
      <a
        href="#main"
        className="sr-only z-10 rounded-md bg-primary px-4 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to content
      </a>
      <header className="flex flex-col gap-6 border-b px-5 py-5 md:sticky md:top-0 md:h-dvh md:border-b-0 md:border-r">
        <NavLink to="/" className="text-foreground no-underline" aria-label="Inkly home">
          <Wordmark />
        </NavLink>
        <nav aria-label="Primary">
          <ul className="flex flex-wrap gap-1 md:flex-col">
            {NAV.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end
                  className={({ isActive }) =>
                    cn(
                      "block rounded-md px-3 py-2 text-foreground no-underline hover:bg-muted",
                      isActive && "bg-muted font-semibold shadow-margin",
                    )
                  }
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        {me && <UserMenu me={me} />}
        <div className="mt-auto hidden flex-col gap-3 text-sm md:flex">
          <NavLink to="/design" className="-mx-1 block px-1 py-1 text-muted-foreground">
            Design system
          </NavLink>
          <HealthStatus />
        </div>
      </header>
      <main
        id="main"
        ref={main}
        tabIndex={-1}
        className="margin-rule mx-4 my-8 pl-6 outline-none md:mx-12 md:my-12 md:pl-10"
      >
        <Outlet />
      </main>
    </div>
  );
}
