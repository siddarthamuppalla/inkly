import { Page } from "../components/page.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";

export function LinksRoute() {
  return (
    <Page title="Share links" lede="Who can open what, and until when.">
      <EmptyState title="Nothing shared yet">
        <p>
          Share links can expire, ask for a password, and be revoked at any time. Every open is
          logged against the document.
        </p>
      </EmptyState>
    </Page>
  );
}
