import { Page } from "../components/page.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";

export function EnvelopesRoute() {
  return (
    <Page title="Envelopes" lede="Signing requests you have sent or been asked to sign.">
      <EmptyState title="No envelopes in flight">
        <p>
          An envelope is one document, its recipients and the fields they fill in. Its audit trail
          and certificate of completion stay with it once everyone has signed.
        </p>
      </EmptyState>
    </Page>
  );
}
