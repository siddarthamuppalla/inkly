import { AppError, type Annotation, type AnnotationColor, type Point } from "@inkly/domain";
import { PDFHexString, PDFString, type PDFDict, type PDFPage } from "pdf-lib";

import { load } from "./load.ts";

/** RGB for each color; apps/web/src/styles/tokens.css holds the same values as --annot-*. */
const RGB: Record<AnnotationColor, readonly [number, number, number]> = {
  yellow: [1, 0.847, 0.302],
  green: [0.494, 0.839, 0.494],
  blue: [0.498, 0.69, 1],
  red: [1, 0.541, 0.502],
};

const NOTE_ICON = 24;
/** Print; for notes also NoZoom and NoRotate, so the icon stays upright at its anchor. */
const PRINT = 4;
const PRINT_FIXED_ICON = 4 | 8 | 16;

const ROTATIONS = [0, 90, 180, 270] as const;

/** Maps a page-relative point on the displayed (rotated) page to PDF user space. */
function toUserSpace(page: PDFPage, p: Point): [number, number] {
  const box = page.getCropBox();
  const angle = ((page.getRotation().angle % 360) + 360) % 360;
  const rotation = ROTATIONS.find((r) => r === angle) ?? 0;
  const [s, t] = (
    {
      0: [p.x, p.y],
      90: [p.y, 1 - p.x],
      180: [1 - p.x, 1 - p.y],
      270: [1 - p.y, p.x],
    } as const satisfies Record<typeof rotation, readonly [number, number]>
  )[rotation];
  return [box.x + s * box.width, box.y + (1 - t) * box.height];
}

function bounds(points: readonly (readonly [number, number])[]): number[] {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** The note's text, then each Comment as "Name: text". */
function contents(a: Annotation): string {
  const head = a.shape.kind === "note" ? [a.shape.text] : [];
  return [...head, ...a.comments.map((c) => `${c.author.name}: ${c.text}`)].join("\n\n");
}

function annotDict(page: PDFPage, a: Annotation): PDFDict {
  const ctx = page.doc.context;
  const common = {
    Type: "Annot",
    C: [...RGB[a.shape.color]],
    T: PDFHexString.fromText(a.author.name),
    Contents: PDFHexString.fromText(contents(a)),
    NM: PDFString.of(a.id),
    M: PDFString.fromDate(new Date(a.updatedAt)),
  };
  const shape = a.shape;
  switch (shape.kind) {
    case "highlight": {
      const quads = shape.rects.map((r) =>
        [
          { x: r.x, y: r.y },
          { x: r.x + r.w, y: r.y },
          { x: r.x, y: r.y + r.h },
          { x: r.x + r.w, y: r.y + r.h },
        ].map((p) => toUserSpace(page, p)),
      );
      return ctx.obj({
        ...common,
        Subtype: "Highlight",
        F: PRINT,
        Rect: bounds(quads.flat()),
        QuadPoints: quads.flat(2),
      });
    }
    case "note": {
      const [x, y] = toUserSpace(page, shape.at);
      return ctx.obj({
        ...common,
        Subtype: "Text",
        Name: "Comment",
        F: PRINT_FIXED_ICON,
        Rect: [x, y - NOTE_ICON, x + NOTE_ICON, y],
      });
    }
    case "ink": {
      const strokes = shape.strokes.map((stroke) => stroke.map((p) => toUserSpace(page, p)));
      return ctx.obj({
        ...common,
        Subtype: "Ink",
        F: PRINT,
        Rect: bounds(strokes.flat()),
        InkList: strokes.map((stroke) => stroke.flat()),
        BS: { W: 2, S: "S" },
      });
    }
  }
}

/**
 * The PDF with `annotations` added as real PDF annotations (Highlight, Text, Ink), for
 * "Download with annotations". The caller passes the Annotations of this Version only.
 */
export async function withAnnotations(
  input: Uint8Array,
  annotations: readonly Annotation[],
): Promise<Uint8Array> {
  const doc = await load(input);
  const pages = doc.getPages();
  for (const a of annotations) {
    const page = pages[a.shape.page - 1];
    if (!page) {
      throw new AppError(
        "invalid_input",
        `annotation ${a.id} is on page ${String(a.shape.page)}; the PDF has ${String(pages.length)}`,
      );
    }
    page.node.addAnnot(doc.context.register(annotDict(page, a)));
  }
  return doc.save();
}
