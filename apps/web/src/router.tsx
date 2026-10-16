import { createBrowserRouter } from "react-router";

import { AppShell } from "./components/app-shell.tsx";
import { requireMe, SIGNED_IN_ROUTE } from "./lib/session.ts";
import { DesignRoute } from "./routes/design.tsx";
import { DocumentsRoute } from "./routes/documents.tsx";
import { EnvelopesRoute } from "./routes/envelopes.tsx";
import { InvitationRoute } from "./routes/invitation.tsx";
import { LinksRoute } from "./routes/links.tsx";
import { MembersRoute } from "./routes/members.tsx";
import { NotFoundRoute } from "./routes/not-found.tsx";
import { SignInRoute } from "./routes/sign-in.tsx";
import { TrashRoute } from "./routes/trash.tsx";

export const router = createBrowserRouter([
  { path: "sign-in", Component: SignInRoute },
  {
    Component: AppShell,
    children: [
      { path: "design", Component: DesignRoute },
      {
        id: SIGNED_IN_ROUTE,
        loader: requireMe,
        children: [
          { index: true, Component: DocumentsRoute },
          {
            path: "documents/:id",
            HydrateFallback: () => null,
            lazy: async () => ({
              Component: (await import("./routes/document.tsx")).DocumentRoute,
            }),
          },
          { path: "trash", Component: TrashRoute },
          { path: "envelopes", Component: EnvelopesRoute },
          { path: "links", Component: LinksRoute },
          { path: "members", Component: MembersRoute },
          { path: "invitations/:id", Component: InvitationRoute },
        ],
      },
      { path: "*", Component: NotFoundRoute },
    ],
  },
]);
