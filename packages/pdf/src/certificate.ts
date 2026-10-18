import { AppError } from "@inkly/domain";
import {
  PageSizes,
  rgb,
  StandardFonts,
  type PDFDocument,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from "pdf-lib";

import { displaySize } from "./geometry.ts";
import { load } from "./load.ts";
import { encodable, pngFromDataUrl, wrap } from "./text.ts";

export interface CertificateParty {
  readonly name: string;
  readonly email: string;
}

export interface CertificateRecipient extends CertificateParty {
  readonly role: "signer" | "cc";
  readonly ip: string | null;
  readonly userAgent: string | null;
  /** Epoch milliseconds, or null when it did not happen. */
  readonly viewedAt: number | null;
  readonly signedAt: number | null;
  /** The adopted signature as a PNG data URL, or null (CC recipients). */
  readonly signature: string | null;
}

export interface CertificateEvent {
  readonly seq: number;
  /** Epoch milliseconds. */
  readonly at: number;
  readonly actor: string;
  readonly action: string;
  readonly hash: string;
}

/** What the Certificate of completion pages list (ADR-0006). */
export interface CompletionCertificate {
  readonly envelopeId: string;
  readonly title: string;
  /** sha256 hex of the pinned Version before any Field was stamped. */
  readonly documentSha256: string;
  readonly sentAt: number;
  readonly completedAt: number;
  readonly sender: CertificateParty;
  readonly recipients: readonly CertificateRecipient[];
  readonly events: readonly CertificateEvent[];
}

/** Paper & Ink: --foreground, --muted-foreground, --border and --seal from tokens.css. */
const INK = rgb(0.106, 0.137, 0.2);
const MUTED = rgb(0.337, 0.365, 0.42);
const BORDER = rgb(0.867, 0.835, 0.769);
const SEAL = rgb(0.706, 0.137, 0.094);

const MARGIN = 56;
const FOOTER = 36;
const BODY = 9;
const LEADING = 1.35;
const LABEL_WIDTH = 118;
const SIGNATURE_BOX = { w: 150, h: 52 } as const;

interface Fonts {
  readonly regular: PDFFont;
  readonly bold: PDFFont;
  readonly mono: PDFFont;
}

interface Run {
  readonly text: string;
  readonly font: PDFFont;
  readonly size: number;
  readonly color: typeof INK;
}

const utc = (ms: number | null): string =>
  ms === null ? "—" : `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`;

class Layout {
  readonly pages: PDFPage[] = [];
  page!: PDFPage;
  y = 0;
  readonly width: number;
  private readonly doc: PDFDocument;
  private readonly size: readonly [number, number];
  readonly fonts: Fonts;

  constructor(doc: PDFDocument, size: readonly [number, number], fonts: Fonts) {
    this.doc = doc;
    this.size = size;
    this.fonts = fonts;
    this.width = size[0] - 2 * MARGIN;
    this.newPage();
  }

  get left(): number {
    return MARGIN;
  }

  newPage(): void {
    this.page = this.doc.addPage([...this.size]);
    this.pages.push(this.page);
    this.y = this.size[1] - MARGIN;
    if (this.pages.length > 1) {
      this.text(this.left, "Certificate of completion (continued)", this.run("bold", 9, MUTED));
      this.y -= 22;
    }
  }

  /** Starts a new page unless `height` points still fit above the footer. */
  ensure(height: number): void {
    if (this.y - height < MARGIN + FOOTER) this.newPage();
  }

  run(font: keyof Fonts, size: number, color = INK): Omit<Run, "text"> {
    return { font: this.fonts[font], size, color };
  }

  text(x: number, text: string, run: Omit<Run, "text">, y = this.y): void {
    this.page.drawText(encodable(run.font, text), { x, y, ...run });
  }

  lines(text: string, run: Omit<Run, "text">, width: number): string[] {
    return wrap(run.font, run.size, text, width);
  }

  rule(color = BORDER, thickness = 0.5, width = this.width): void {
    this.page.drawLine({
      start: { x: this.left, y: this.y },
      end: { x: this.left + width, y: this.y },
      thickness,
      color,
    });
  }

  heading(title: string): void {
    this.ensure(48);
    this.y -= 18;
    this.text(this.left, title, this.run("bold", 11));
    this.y -= 7;
    this.rule();
    this.y -= 14;
  }
}

interface Row {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}

function rowsHeight(l: Layout, rows: readonly Row[], width: number): number {
  return rows.reduce((sum, r) => sum + rowLines(l, r, width).length * BODY * LEADING + 3, 0);
}

function rowLines(l: Layout, r: Row, width: number): string[] {
  return l.lines(r.value, l.run(r.mono ? "mono" : "regular", r.mono ? 8 : BODY), width);
}

/** Label/value rows at the cursor, wrapping each value within `width`. */
function drawRows(l: Layout, rows: readonly Row[], width: number): void {
  for (const r of rows) {
    const lines = rowLines(l, r, width - LABEL_WIDTH);
    l.ensure(lines.length * BODY * LEADING);
    l.text(l.left, r.label, l.run("regular", BODY, MUTED));
    const run = l.run(r.mono ? "mono" : "regular", r.mono ? 8 : BODY);
    lines.forEach((line, i) => {
      l.text(l.left + LABEL_WIDTH, line, run, l.y - i * BODY * LEADING);
    });
    l.y -= lines.length * BODY * LEADING + 3;
  }
}

function header(l: Layout, cert: CompletionCertificate): void {
  l.page.drawRectangle({ x: l.left, y: l.y, width: 28, height: 3, color: SEAL });
  l.y -= 26;
  l.text(l.left, "Certificate of completion", l.run("bold", 20));
  l.y -= 18;
  for (const line of l.lines(cert.title, l.run("regular", 11, MUTED), l.width)) {
    l.text(l.left, line, l.run("regular", 11, MUTED));
    l.y -= 11 * LEADING;
  }
  l.y -= 4;
}

function recipient(l: Layout, r: CertificateRecipient, image: PDFImage | null): void {
  const rows: Row[] = [
    { label: "Email", value: r.email },
    { label: "Role", value: r.role === "signer" ? "Signer" : "CC" },
    ...(r.role === "signer" ? [{ label: "Verification", value: "Email code" }] : []),
    { label: "IP address", value: r.ip ?? "—" },
    { label: "User agent", value: r.userAgent ?? "—" },
    { label: "Viewed", value: utc(r.viewedAt) },
    ...(r.role === "signer" ? [{ label: "Signed", value: utc(r.signedAt) }] : []),
  ];
  const width = image ? l.width - SIGNATURE_BOX.w - 16 : l.width;
  const height = 20 + Math.max(rowsHeight(l, rows, width - LABEL_WIDTH), image ? 70 : 0);
  l.ensure(Math.min(height, 400));
  const page = l.page;
  let bottom = l.y;
  if (image) {
    const box = { x: l.left + l.width - SIGNATURE_BOX.w, y: l.y - SIGNATURE_BOX.h + 8 };
    l.page.drawRectangle({
      ...box,
      width: SIGNATURE_BOX.w,
      height: SIGNATURE_BOX.h,
      borderColor: BORDER,
      borderWidth: 0.75,
      color: rgb(1, 1, 1),
    });
    const scale = Math.min(
      (SIGNATURE_BOX.w - 12) / image.width,
      (SIGNATURE_BOX.h - 12) / image.height,
    );
    const [w, h] = [image.width * scale, image.height * scale];
    l.page.drawImage(image, {
      x: box.x + (SIGNATURE_BOX.w - w) / 2,
      y: box.y + (SIGNATURE_BOX.h - h) / 2,
      width: w,
      height: h,
    });
    l.text(box.x, "Signature", l.run("regular", 7.5, MUTED), box.y - 10);
    bottom = box.y - 18;
  }
  l.text(l.left, r.name, l.run("bold", 10.5));
  l.y -= 16;
  drawRows(l, rows, width);
  if (l.page === page) l.y = Math.min(l.y, bottom);
  l.y -= 10;
}

const COLUMNS = [
  { title: "#", width: 26 },
  { title: "Time (UTC)", width: 108 },
  { title: "Actor", width: 150 },
  { title: "Action", width: 0 },
] as const;

function eventsHeader(l: Layout): void {
  let x = l.left;
  for (const c of COLUMNS) {
    l.text(x, c.title, l.run("bold", 8, MUTED));
    x += c.width;
  }
  l.y -= 6;
  l.rule();
  l.y -= 12;
}

function event(l: Layout, e: CertificateEvent): void {
  const actionWidth = l.width - COLUMNS.slice(0, 3).reduce((s, c) => s + c.width, 0);
  const actor = l.lines(e.actor, l.run("regular", 8.5), COLUMNS[2].width - 8);
  const action = l.lines(e.action, l.run("regular", 8.5), actionWidth);
  const lineCount = Math.max(actor.length, action.length);
  const height = lineCount * 8.5 * LEADING + 16;
  if (l.y - height < MARGIN + FOOTER) {
    l.newPage();
    eventsHeader(l);
  }
  const cells = [[String(e.seq)], [utc(e.at).replace(" UTC", "")], actor, action];
  let x = l.left;
  cells.forEach((lines, i) => {
    lines.forEach((line, j) => {
      l.text(x, line, l.run(i === 3 ? "bold" : "regular", 8.5), l.y - j * 8.5 * LEADING);
    });
    x += COLUMNS[i]?.width ?? 0;
  });
  l.y -= lineCount * 8.5 * LEADING;
  l.text(l.left + COLUMNS[0].width, `sha256 ${e.hash}`, l.run("mono", 7, MUTED));
  l.y -= 16;
}

function footers(l: Layout, envelopeId: string): void {
  l.pages.forEach((page, i) => {
    const y = MARGIN - 8;
    page.drawLine({
      start: { x: MARGIN, y: y + 12 },
      end: { x: MARGIN + l.width, y: y + 12 },
      thickness: 0.5,
      color: BORDER,
    });
    const run = l.run("regular", 7.5, MUTED);
    page.drawText(encodable(run.font, `Inkly · Envelope ${envelopeId}`), { x: MARGIN, y, ...run });
    const label = `Page ${String(i + 1)} of ${String(l.pages.length)}`;
    const w = run.font.widthOfTextAtSize(label, run.size);
    page.drawText(label, { x: MARGIN + l.width - w, y, ...run });
  });
}

/** Letter when the document's first page is Letter-width, otherwise A4. */
function pageSize(doc: PDFDocument): readonly [number, number] {
  const width = displaySize(doc.getPage(0)).width;
  return Math.abs(width - PageSizes.Letter[0]) < Math.abs(width - PageSizes.A4[0])
    ? PageSizes.Letter
    : PageSizes.A4;
}

/**
 * The PDF with Certificate of completion pages appended: the Envelope, the original
 * Document's sha256, each Recipient with their verification, IP, user agent, times and
 * signature, and every audit event with its hash. Long trails continue on more pages.
 */
export async function appendCertificate(
  input: Uint8Array,
  cert: CompletionCertificate,
): Promise<Uint8Array> {
  const doc = await load(input);
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    mono: await doc.embedFont(StandardFonts.Courier),
  };
  const images = await Promise.all(
    cert.recipients.map(async (r) => {
      if (r.signature === null) return null;
      const png = pngFromDataUrl(r.signature);
      return doc.embedPng(png).catch((e: unknown) => {
        throw new AppError(
          "invalid_input",
          `${r.email}: signature is not a readable PNG (${e instanceof Error ? e.message : "unknown"})`,
        );
      });
    }),
  );
  const l = new Layout(doc, pageSize(doc), fonts);

  header(l, cert);
  l.heading("Envelope");
  drawRows(
    l,
    [
      { label: "Envelope ID", value: cert.envelopeId, mono: true },
      { label: "Document SHA-256", value: cert.documentSha256, mono: true },
      { label: "Sender", value: `${cert.sender.name} <${cert.sender.email}>` },
      { label: "Sent", value: utc(cert.sentAt) },
      { label: "Completed", value: utc(cert.completedAt) },
    ],
    l.width,
  );

  l.heading("Recipients");
  cert.recipients.forEach((r, i) => {
    recipient(l, r, images[i] ?? null);
  });

  l.heading("Audit trail");
  eventsHeader(l);
  for (const e of cert.events) event(l, e);

  footers(l, cert.envelopeId);
  return doc.save();
}
