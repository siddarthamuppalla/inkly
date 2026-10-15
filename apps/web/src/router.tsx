import { createBrowserRouter } from "react-router";

import { AppShell } from "./components/app-shell.tsx";
import { DesignRoute } from "./routes/design.tsx";
import { DocumentsRoute } from "./routes/documents.tsx";
import { EnvelopesRoute } from "./routes/envelopes.tsx";
import { LinksRoute } from "./routes/links.tsx";
import { NotFoundRoute } from "./routes/not-found.tsx";

export const router = createBrowserRouter([
  {
    Component: AppShell,
    children: [
      { index: true, Component: DocumentsRoute },
      { path: "envelopes", Component: EnvelopesRoute },
      { path: "links", Component: LinksRoute },
      { path: "design", Component: DesignRoute },
      { path: "*", Component: NotFoundRoute },
    ],
  },
]);
