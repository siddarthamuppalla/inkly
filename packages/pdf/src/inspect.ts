import { AppError } from "@inkly/domain";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";

export interface PdfInfo {
  readonly pages: number;
}

/** Up to 1 KiB of bytes as a Latin-1 string, for matching PDF syntax. */
function text(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(Math.max(0, start), Math.min(end, start + 1024)));
}

/** The trailer must end in `startxref <offset> %%EOF`, and the offset must land on an xref. */
function hasCrossReference(bytes: Uint8Array): boolean {
  const tail = text(bytes, bytes.byteLength - 1024, bytes.byteLength);
  const offset = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail)?.[1];
  if (offset === undefined) return false;
  const at = Number(offset);
  if (at >= bytes.byteLength) return false;
  const head = text(bytes, at, at + 32);
  return /^\s*(xref|\d+\s+\d+\s+obj)/.test(head);
}

/**
 * Checks that `bytes` are an unencrypted, structurally sound PDF and counts its pages.
 * Throws `invalid_input` for non-PDFs, `pdf_encrypted` and `pdf_malformed` otherwise.
 */
export async function inspectPdf(bytes: Uint8Array): Promise<PdfInfo> {
  if (!text(bytes, 0, 1024).includes("%PDF-")) {
    throw new AppError("invalid_input", "The file is not a PDF");
  }
  if (!hasCrossReference(bytes)) {
    throw new AppError("pdf_malformed", "The PDF is damaged: its cross-reference is missing");
  }
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      throwOnInvalidObject: true,
      updateMetadata: false,
    });
  } catch {
    throw new AppError("pdf_malformed", "The PDF is damaged and cannot be read");
  }
  if (doc.isEncrypted) {
    throw new AppError("pdf_encrypted", "The PDF is password-protected or encrypted");
  }
  const streamWithoutLength = doc.context
    .enumerateIndirectObjects()
    .some(([, obj]) => obj instanceof PDFRawStream && !obj.dict.has(PDFName.of("Length")));
  if (streamWithoutLength) {
    throw new AppError("pdf_malformed", "The PDF is damaged: a stream has no length");
  }
  const pages = doc.getPageCount();
  if (pages < 1) throw new AppError("pdf_malformed", "The PDF has no pages");
  return { pages };
}
