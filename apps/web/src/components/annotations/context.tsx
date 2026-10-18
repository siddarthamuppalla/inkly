import type { Annotation, AnnotationColor, Author, DocumentInfo, Point } from "@inkly/domain";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

import { annotationsApi, useAnnotations, useDocSession } from "../../lib/annotations-api.ts";
import { useMe } from "../../lib/session.ts";

export type Tool = "select" | "highlight" | "note" | "ink";

export interface AnnotationsState {
  readonly doc: DocumentInfo;
  readonly meId: string;
  readonly role: string;
  readonly canWrite: boolean;
  /** False while the Document is in Trash: the API serves no Annotations for it. */
  readonly available: boolean;
  /** Every Annotation of the Document, oldest first, across Versions. */
  readonly annotations: readonly Annotation[];
  readonly api: ReturnType<typeof annotationsApi>;
  readonly members: readonly Author[];
  readonly tool: Tool;
  readonly setTool: (tool: Tool) => void;
  readonly color: AnnotationColor;
  readonly setColor: (color: AnnotationColor) => void;
  readonly selected: string | null;
  readonly select: (id: string | null) => void;
  /** Where the Note tool was clicked, waiting for its text in the panel. */
  readonly pendingNote: { readonly page: number; readonly at: Point } | null;
  readonly setPendingNote: (note: { page: number; at: Point } | null) => void;
}

const Context = createContext<AnnotationsState | null>(null);

export function useAnnotationsState(): AnnotationsState {
  const state = useContext(Context);
  if (!state) throw new Error("useAnnotationsState needs an <AnnotationsProvider>");
  return state;
}

/** Shared state of the annotation layer and the comments panel for one Document. */
export function AnnotationsProvider({
  doc,
  children,
}: {
  readonly doc: DocumentInfo;
  readonly children: ReactNode;
}) {
  const me = useMe();
  const available = doc.deletedAt === null;
  const query = useAnnotations(doc.id);
  const { members } = useDocSession(doc.id, available);
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState<AnnotationColor>("yellow");
  const [selected, select] = useState<string | null>(null);
  const [pendingNote, setPendingNote] = useState<AnnotationsState["pendingNote"]>(null);
  const role = me?.role ?? "viewer";

  const state = useMemo<AnnotationsState>(
    () => ({
      doc,
      meId: me?.user.id ?? "",
      role,
      canWrite: available && role !== "viewer",
      available,
      annotations: available ? (query.data ?? []) : [],
      api: annotationsApi(doc.id),
      members,
      tool,
      setTool,
      color,
      setColor,
      selected,
      select,
      pendingNote,
      setPendingNote,
    }),
    [doc, me, role, available, query.data, members, tool, color, selected, pendingNote],
  );
  return <Context.Provider value={state}>{children}</Context.Provider>;
}

export const KIND_LABEL: Record<Annotation["shape"]["kind"], string> = {
  highlight: "Highlight",
  note: "Note",
  ink: "Ink",
};

export const COLOR_LABEL: Record<AnnotationColor, string> = {
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  red: "Red",
};

/** The token that paints `color`; values live in styles/tokens.css. */
export const colorVar = (color: AnnotationColor) => `var(--annot-${color})`;
