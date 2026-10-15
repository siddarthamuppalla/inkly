import { EmptyState } from "./ui/empty-state.tsx";

/** What a page shows to a visitor without a session instead of workspace data. */
export function SignedOut() {
  return (
    <EmptyState title="Sign in to see your documents">
      <p>Your workspace's documents, folders and Trash appear here once you are signed in.</p>
    </EmptyState>
  );
}
