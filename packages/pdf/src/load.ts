import { AppError } from "@inkly/domain";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";

/** The largest input, in bytes, a page op runs on inside a Worker; above it use pdf-engine. */
export const MAX_WORKER_BYTES = 25 * 1024 * 1024;
/** The most pages a page op runs on inside a Worker; above it use pdf-engine. */
export const MAX_WORKER_PAGES = 200;

export interface PageSize {
  /** Points (1/72 inch), from the page's MediaBox. */
  readonly width: number;
  readonly height: number;
}

export interface PdfInspection {
  readonly pages: number;
  readonly encrypted: boolean;
  readonly sizes: readonly PageSize[];
}

export function assertBytesWithinCeiling(bytes: number): void {
  if (bytes > MAX_WORKER_BYTES) {
    throw new AppError(
      "too_large_for_worker",
      `input is ${String(bytes)} bytes; the Worker limit is ${String(MAX_WORKER_BYTES)}, use pdf-engine`,
    );
  }
}

export function assertPagesWithinCeiling(pages: number): void {
  if (pages > MAX_WORKER_PAGES) {
    throw new AppError(
      "too_large_for_worker",
      `input has ${String(pages)} pages; the Worker limit is ${String(MAX_WORKER_PAGES)}, use pdf-engine`,
    );
  }
}

const TAIL = 1024;

/** A PDF ends with `startxref <offset>` and `%%EOF`; qpdf calls the file damaged otherwise. */
function hasStartXref(input: Uint8Array): boolean {
  const tail = String.fromCharCode(...input.subarray(Math.max(0, input.length - TAIL)));
  const match = /startxref\s+(\d+)\s+%%EOF/.exec(tail);
  return match !== null && Number(match[1]) < input.length;
}

function streamsHaveLength(doc: PDFDocument): boolean {
  return doc.context
    .enumerateIndirectObjects()
    .every(
      ([, object]) => !(object instanceof PDFRawStream) || object.dict.has(PDFName.of("Length")),
    );
}

async function parse(input: Uint8Array): Promise<PDFDocument> {
  assertBytesWithinCeiling(input.length);
  if (!hasStartXref(input)) throw new AppError("pdf_malformed", "PDF has no startxref");
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(input, { ignoreEncryption: true, updateMetadata: false });
  } catch (e) {
    throw new AppError("pdf_malformed", e instanceof Error ? e.message : "PDF could not be parsed");
  }
  if (!streamsHaveLength(doc)) throw new AppError("pdf_malformed", "a stream has no /Length");
  if (doc.getPageCount() === 0) throw new AppError("pdf_malformed", "PDF has no pages");
  return doc;
}

/** Parses `input` for a page op: refuses malformed, encrypted and over-ceiling input. */
export async function load(input: Uint8Array): Promise<PDFDocument> {
  const doc = await parse(input);
  if (doc.isEncrypted) throw new AppError("pdf_encrypted", "PDF is encrypted");
  assertPagesWithinCeiling(doc.getPageCount());
  return doc;
}

/** Reads what upload validation needs. Encrypted input is reported, not refused. */
export async function inspect(input: Uint8Array): Promise<PdfInspection> {
  const doc = await parse(input);
  return {
    pages: doc.getPageCount(),
    encrypted: doc.isEncrypted,
    sizes: doc.getPages().map((page) => page.getSize()),
  };
}
