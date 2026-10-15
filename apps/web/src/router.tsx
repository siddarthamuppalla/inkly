import { createBrowserRouter } from "react-router";

import { AppShell } from "./components/app-shell.tsx";
import { DesignRoute } from "./routes/design.tsx";
import { DocumentsRoute } from "./routes/documents.tsx";
import { EnvelopesRoute } from "./routes/envelopes.tsx";
import { LinksRoute } from "./routes/links.tsx";
import { NotFoundRoute } from "./routes/not-found.tsx";
import { TrashRoute } from "./routes/trash.tsx";

export const router = createBrowserRouter([
  {
    Component: AppShell,
    children: [
      { index: true, Component: DocumentsRoute },
      {
        path: "documents/:id",
        lazy: async () => ({ Component: (await import("./routes/document.tsx")).DocumentRoute }),
      },
      { path: "trash", Component: TrashRoute },
      { path: "envelopes", Component: EnvelopesRoute },
      { path: "links", Component: LinksRoute },
      { path: "design", Component: DesignRoute },
      { path: "*", Component: NotFoundRoute },
    ],
  },
]);
