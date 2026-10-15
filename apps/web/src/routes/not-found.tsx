import { Link } from "react-router";

import { Page } from "../components/page.tsx";

export function NotFoundRoute() {
  return (
    <Page
      title="Page not found"
      lede="This address doesn’t match any page in Inkly. Check it for typos, or go back to your documents."
    >
      <Link to="/">Go to documents</Link>
    </Page>
  );
}
