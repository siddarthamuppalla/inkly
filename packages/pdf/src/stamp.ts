import { AppError } from "@inkly/domain";
import {
  degrees,
  LineCapStyle,
  rgb,
  StandardFonts,
  type PDFDocument,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";

import { displaySize, rotationOf, toUserSpace } from "./geometry.ts";
import { load } from "./load.ts";
import { encodable, pngFromDataUrl } from "./text.ts";

export type StampFieldKind = "signature" | "initials" | "date" | "text" | "checkbox";

/**
 * A filled-in Field to draw into the page. `x`, `y`, `w`, `h` are fractions (0..1) of the
 * displayed page, origin top-left, like Annotation geometry. `value` is a PNG data URL for
 * signature and initials, the text for date and text, and "true" or "false" for checkbox.
 */
export interface StampField {
  readonly kind: StampFieldKind;
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly value: string;
}

const INK = rgb(0.106, 0.137, 0.2);
const PAD = 2;
const MAX_TEXT_SIZE = 14;
const MIN_TEXT_SIZE = 4;
/** Helvetica's CapHeight (718/1000), to centre capitals in the rect. */
const HELVETICA_CAP_HEIGHT = 0.718;

/** A Field's rect on its page: `at(u, v)` maps points right of and below its top-left corner. */
interface Frame {
  readonly page: PDFPage;
  readonly w: number;
  readonly h: number;
  readonly rotate: ReturnType<typeof degrees>;
  at(u: number, v: number): { x: number; y: number };
}

function frameOf(page: PDFPage, f: StampField): Frame {
  const size = displaySize(page);
  return {
    page,
    w: f.w * size.width,
    h: f.h * size.height,
    rotate: degrees(rotationOf(page)),
    at(u, v) {
      const [x, y] = toUserSpace(page, { x: f.x + u / size.width, y: f.y + v / size.height });
      return { x, y };
    },
  };
}

function drawText(frame: Frame, font: PDFFont, value: string): void {
  const text = encodable(font, value);
  if (text === "") return;
  const room = Math.max(frame.w - 2 * PAD, 1);
  const byWidth = (MAX_TEXT_SIZE * room) / Math.max(font.widthOfTextAtSize(text, MAX_TEXT_SIZE), 1);
  const size = Math.max(MIN_TEXT_SIZE, Math.min(MAX_TEXT_SIZE, frame.h * 0.7, byWidth));
  frame.page.drawText(text, {
    ...frame.at(PAD, (frame.h + HELVETICA_CAP_HEIGHT * size) / 2),
    size,
    font,
    color: INK,
    rotate: frame.rotate,
  });
}

async function drawImage(doc: PDFDocument, frame: Frame, value: string): Promise<void> {
  const image = await doc.embedPng(pngFromDataUrl(value)).catch((e: unknown) => {
    throw new AppError(
      "invalid_input",
      `signature image is not a readable PNG (${e instanceof Error ? e.message : "unknown"})`,
    );
  });
  const scale = Math.min(frame.w / image.width, frame.h / image.height);
  const [w, h] = [image.width * scale, image.height * scale];
  frame.page.drawImage(image, {
    ...frame.at((frame.w - w) / 2, (frame.h + h) / 2),
    width: w,
    height: h,
    rotate: frame.rotate,
  });
}

function drawCheck(frame: Frame): void {
  const side = Math.min(frame.w, frame.h);
  const [u0, v0] = [(frame.w - side) / 2, (frame.h - side) / 2];
  const points = [
    [0.2, 0.55],
    [0.42, 0.78],
    [0.82, 0.24],
  ].map(([u = 0, v = 0]) => frame.at(u0 + u * side, v0 + v * side));
  for (let i = 1; i < points.length; i++) {
    const [start, end] = [points[i - 1], points[i]];
    if (!start || !end) continue;
    frame.page.drawLine({
      start,
      end,
      thickness: Math.max(side * 0.12, 0.75),
      color: INK,
      lineCap: LineCapStyle.Round,
    });
  }
}

function assertGeometry(f: StampField, index: number, pages: number): void {
  const where = `field ${String(index + 1)} (${f.kind})`;
  if (!Number.isInteger(f.page) || f.page < 1 || f.page > pages) {
    throw new AppError(
      "invalid_input",
      `${where} is on page ${String(f.page)}; the PDF has ${String(pages)}`,
    );
  }
  const inside = [f.x, f.y, f.w, f.h].every((n) => Number.isFinite(n) && n >= 0 && n <= 1);
  if (!inside || f.w === 0 || f.h === 0 || f.x + f.w > 1 || f.y + f.h > 1) {
    throw new AppError("invalid_input", `${where} must lie within its page`);
  }
}

/**
 * The PDF with each Field's value drawn into its rect as page content, upright on the
 * displayed page whatever its rotation. Nothing else on the page changes.
 */
export async function stampFields(
  input: Uint8Array,
  fields: readonly StampField[],
): Promise<Uint8Array> {
  const doc = await load(input);
  const pages = doc.getPages();
  fields.forEach((f, i) => {
    assertGeometry(f, i, pages.length);
  });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const f of fields) {
    const page = pages[f.page - 1];
    if (!page) continue;
    const frame = frameOf(page, f);
    switch (f.kind) {
      case "signature":
      case "initials":
        await drawImage(doc, frame, f.value);
        break;
      case "date":
      case "text":
        drawText(frame, font, f.value);
        break;
      case "checkbox":
        if (f.value === "true") drawCheck(frame);
        break;
    }
  }
  return doc.save();
}
