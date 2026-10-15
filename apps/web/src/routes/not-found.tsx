import { Link } from "react-router";

import { Page } from "../components/page.tsx";

export function NotFoundRoute() {
  return (
    <Page title="Page not found" lede="This page was torn out, or never written.">
      <Link to="/">Back to documents</Link>
    </Page>
  );
}
