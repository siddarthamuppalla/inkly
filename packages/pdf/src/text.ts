import { AppError } from "@inkly/domain";
import type { PDFFont } from "pdf-lib";

const supported = new WeakMap<PDFFont, ReadonlySet<number>>();

/**
 * `text` on one line, reduced to what the standard font can encode: accents are dropped
 * ("é" becomes "e") and anything else becomes "?", so drawing never throws.
 */
export function encodable(font: PDFFont, text: string): string {
  let set = supported.get(font);
  if (!set) {
    set = new Set(font.getCharacterSet());
    supported.set(font, set);
  }
  const chars = set;
  return Array.from(text.replace(/\s+/g, " ").trim())
    .map((c) => {
      if (chars.has(c.codePointAt(0) ?? 0)) return c;
      const bare = c.normalize("NFKD").replace(/\p{M}/gu, "");
      return Array.from(bare).every((b) => chars.has(b.codePointAt(0) ?? 0)) && bare !== ""
        ? bare
        : "?";
    })
    .join("");
}

/** Splits `text` into lines no wider than `width`, breaking inside words that do not fit. */
export function wrap(font: PDFFont, size: number, text: string, width: number): string[] {
  const fits = (s: string) => font.widthOfTextAtSize(s, size) <= width;
  const lines: string[] = [];
  let line = "";
  for (const word of encodable(font, text).split(" ")) {
    const joined = line === "" ? word : `${line} ${word}`;
    if (fits(joined)) {
      line = joined;
      continue;
    }
    if (line !== "") lines.push(line);
    line = "";
    for (const c of word) {
      if (line !== "" && !fits(line + c)) {
        lines.push(line);
        line = "";
      }
      line += c;
    }
  }
  if (line !== "" || lines.length === 0) lines.push(line);
  return lines;
}

/** The largest PNG accepted as a signature or initials image (ADR-0006). */
export const MAX_SIGNATURE_BYTES = 200 * 1024;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The bytes of a `data:image/png;base64,…` URL; refuses anything else or anything too big. */
export function pngFromDataUrl(url: string): Uint8Array {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
  if (!match?.[1]) throw new AppError("invalid_input", "signature must be a PNG data URL");
  const binary = atob(match[1]);
  if (binary.length > MAX_SIGNATURE_BYTES) {
    throw new AppError(
      "invalid_input",
      `signature image is ${String(binary.length)} bytes; the limit is ${String(MAX_SIGNATURE_BYTES)}`,
    );
  }
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  if (!PNG_MAGIC.every((b, i) => bytes[i] === b)) {
    throw new AppError("invalid_input", "signature image is not a PNG");
  }
  return bytes;
}
