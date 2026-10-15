import { Page } from "../components/page.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";

export function DocumentsRoute() {
  return (
    <Page title="Documents" lede="Every PDF in this workspace, newest first.">
      <EmptyState title="No documents yet">
        <p>
          PDFs you upload appear here. From a document you can rotate, merge and split pages,
          compress it, send it for signature, or share it with a link.
        </p>
      </EmptyState>
    </Page>
  );
}
