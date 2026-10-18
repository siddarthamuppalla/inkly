import { AppError } from "@inkly/domain";
import * as asn1js from "asn1js";
import { PDFHexString, PDFName, PDFNumber, PDFString } from "pdf-lib";
import * as pkijs from "pkijs";

import { load } from "./load.ts";

/** WebCrypto's key type, whichever runtime's typings (Node or Workers) check this file. */
type CryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

/** The Inkly seal key: what `sealPdf` signs with. */
export interface SealKey {
  readonly privateKey: CryptoKey;
  /** The DER of the key's X.509 certificate, embedded in every seal. */
  readonly certificateDer: Uint8Array;
}

export interface GeneratedSealKey extends SealKey {
  /** PKCS#8 PEM, for the `SEAL_PRIVATE_KEY` secret. */
  readonly privateKeyPem: string;
  /** PEM, for the `SEAL_CERTIFICATE` secret. */
  readonly certificatePem: string;
}

const EC = { name: "ECDSA", namedCurve: "P-256" } as const;
const VALID_YEARS = 10;

const OID = {
  commonName: "2.5.4.3",
  keyUsage: "2.5.29.15",
  basicConstraints: "2.5.29.19",
  subjectKeyIdentifier: "2.5.29.14",
  data: "1.2.840.113549.1.7.1",
  signedData: "1.2.840.113549.1.7.2",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingTime: "1.2.840.113549.1.9.5",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
} as const;

function toPem(label: string, der: ArrayBuffer | Uint8Array): string {
  const bytes = der instanceof Uint8Array ? der : new Uint8Array(der);
  const b64 = btoa(String.fromCharCode(...bytes));
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

function fromPem(label: string, pem: string): Uint8Array {
  const match = new RegExp(`-----BEGIN ${label}-----([^-]+)-----END ${label}-----`).exec(pem);
  if (!match?.[1]) throw new AppError("invalid_input", `expected a PEM ${label}`);
  return Uint8Array.from(atob(match[1].replace(/\s+/g, "")), (c) => c.charCodeAt(0));
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function name(subject: string): pkijs.RelativeDistinguishedNames {
  return new pkijs.RelativeDistinguishedNames({
    typesAndValues: [
      new pkijs.AttributeTypeAndValue({
        type: OID.commonName,
        value: new asn1js.Utf8String({ value: subject }),
      }),
    ],
  });
}

/** Now, to the second: DER times carry no fractional seconds. */
function nowToTheSecond(): Date {
  return new Date(Math.floor(Date.now() / 1000) * 1000);
}

async function exportBytes(format: "raw" | "pkcs8", key: CryptoKey): Promise<ArrayBuffer> {
  const exported = await crypto.subtle.exportKey(format, key);
  if (!(exported instanceof ArrayBuffer))
    throw new AppError("internal", "key export was not bytes");
  return exported;
}

/**
 * A new ECDSA P-256 seal key and a self-signed certificate for it (digitalSignature and
 * nonRepudiation, valid for 10 years). Tests, local dev and previews use one of these.
 */
export async function generateSealKey(subject = "Inkly Document Seal"): Promise<GeneratedSealKey> {
  const keys = await crypto.subtle.generateKey(EC, true, ["sign", "verify"]);
  if (!("publicKey" in keys)) throw new AppError("internal", "ECDSA did not make a key pair");
  const serial = crypto.getRandomValues(new Uint8Array(16));
  serial[0] = (serial[0] ?? 0) & 0x7f;
  const notBefore = nowToTheSecond();
  const notAfter = new Date(notBefore);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + VALID_YEARS);

  const cert = new pkijs.Certificate({
    version: 2,
    serialNumber: new asn1js.Integer({ valueHex: buffer(serial) }),
    issuer: name(subject),
    subject: name(subject),
    notBefore: new pkijs.Time({ type: pkijs.TimeType.UTCTime, value: notBefore }),
    notAfter: new pkijs.Time({ type: pkijs.TimeType.UTCTime, value: notAfter }),
  });
  await cert.subjectPublicKeyInfo.importKey(keys.publicKey);
  const keyId = new Uint8Array(
    await crypto.subtle.digest("SHA-1", await exportBytes("raw", keys.publicKey)),
  );
  cert.extensions = [
    new pkijs.Extension({
      extnID: OID.keyUsage,
      critical: true,
      // digitalSignature (bit 0) and nonRepudiation (bit 1).
      extnValue: new asn1js.BitString({
        valueHex: buffer(new Uint8Array([0xc0])),
        unusedBits: 6,
      }).toBER(false),
    }),
    new pkijs.Extension({
      extnID: OID.basicConstraints,
      critical: true,
      extnValue: new pkijs.BasicConstraints({ cA: false }).toSchema().toBER(false),
    }),
    new pkijs.Extension({
      extnID: OID.subjectKeyIdentifier,
      extnValue: new asn1js.OctetString({ valueHex: buffer(keyId) }).toBER(false),
    }),
  ];
  await cert.sign(keys.privateKey, "SHA-256");

  const certificateDer = new Uint8Array(cert.toSchema(true).toBER(false));
  const pkcs8 = await exportBytes("pkcs8", keys.privateKey);
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, EC, false, ["sign"]);
  return {
    privateKey,
    certificateDer,
    privateKeyPem: toPem("PRIVATE KEY", pkcs8),
    certificatePem: toPem("CERTIFICATE", certificateDer),
  };
}

/** The seal key from its two secrets; refuses a key that does not match the certificate. */
export async function importSealKey(
  privateKeyPem: string,
  certificatePem: string,
): Promise<SealKey> {
  const certificateDer = fromPem("CERTIFICATE", certificatePem);
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;
  try {
    privateKey = await crypto.subtle.importKey(
      "pkcs8",
      buffer(fromPem("PRIVATE KEY", privateKeyPem)),
      EC,
      false,
      ["sign"],
    );
    const cert = pkijs.Certificate.fromBER(buffer(certificateDer));
    publicKey = await crypto.subtle.importKey(
      "spki",
      cert.subjectPublicKeyInfo.toSchema().toBER(false),
      EC,
      false,
      ["verify"],
    );
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError("invalid_input", "seal key or certificate is not an ECDSA P-256 pair");
  }
  const probe = new TextEncoder().encode("inkly seal key check");
  const algorithm = { name: "ECDSA", hash: "SHA-256" };
  const signature = await crypto.subtle.sign(algorithm, privateKey, probe);
  if (!(await crypto.subtle.verify(algorithm, publicKey, signature, probe))) {
    throw new AppError("invalid_input", "seal key does not match the seal certificate");
  }
  return { privateKey, certificateDer };
}

/** Bytes reserved for the CMS signature, written as hex in /Contents. */
const CONTENTS_BYTES = 16 * 1024;
const CONTENTS_PLACEHOLDER = `<${"0".repeat(CONTENTS_BYTES * 2)}>`;
const BYTE_RANGE_PLACEHOLDER = "**********";
const BYTE_RANGE_PATTERN = /\[\s*0(?:\s+\/\*{10}){3}\s*\]/g;

const latin1 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return s;
};

function onlyIndex(haystack: string, needle: string): number {
  const at = haystack.indexOf(needle);
  if (at < 0 || haystack.indexOf(needle, at + 1) >= 0) {
    throw new AppError("internal", "seal placeholder is missing or not unique");
  }
  return at;
}

async function signedData(digest: ArrayBuffer, key: SealKey, at: Date): Promise<Uint8Array> {
  const cert = pkijs.Certificate.fromBER(buffer(key.certificateDer));
  const certHash = await crypto.subtle.digest("SHA-256", buffer(key.certificateDer));
  const attribute = (type: string, value: asn1js.AsnType) =>
    new pkijs.Attribute({ type, values: [value] });
  const signingCertificateV2 = new asn1js.Sequence({
    value: [
      new asn1js.Sequence({
        value: [new asn1js.Sequence({ value: [new asn1js.OctetString({ valueHex: certHash })] })],
      }),
    ],
  });
  const data = new pkijs.SignedData({
    version: 1,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: OID.data }),
    signerInfos: [
      new pkijs.SignerInfo({
        version: 1,
        sid: new pkijs.IssuerAndSerialNumber({
          issuer: cert.issuer,
          serialNumber: cert.serialNumber,
        }),
        signedAttrs: new pkijs.SignedAndUnsignedAttributes({
          type: 0,
          attributes: [
            attribute(OID.contentType, new asn1js.ObjectIdentifier({ value: OID.data })),
            attribute(OID.signingTime, new asn1js.UTCTime({ valueDate: at })),
            attribute(OID.messageDigest, new asn1js.OctetString({ valueHex: digest })),
            attribute(OID.signingCertificateV2, signingCertificateV2),
          ],
        }),
      }),
    ],
    certificates: [cert],
  });
  await data.sign(key.privateKey, 0, "SHA-256");
  const info = new pkijs.ContentInfo({ contentType: OID.signedData, content: data.toSchema(true) });
  return new Uint8Array(info.toSchema().toBER(false));
}

/**
 * The PDF with one PAdES B-B Document seal (ETSI.CAdES.detached, ECDSA P-256, SHA-256)
 * over every byte but the signature itself, in an invisible signature field on page 1.
 */
export async function sealPdf(input: Uint8Array, key: SealKey): Promise<Uint8Array> {
  const doc = await load(input);
  const ctx = doc.context;
  const at = nowToTheSecond();
  const sig = ctx.register(
    ctx.obj({
      Type: "Sig",
      Filter: "Adobe.PPKLite",
      SubFilter: "ETSI.CAdES.detached",
      ByteRange: [0, ...Array.from({ length: 3 }, () => PDFName.of(BYTE_RANGE_PLACEHOLDER))],
      Contents: PDFHexString.of("0".repeat(CONTENTS_BYTES * 2)),
      Name: PDFHexString.fromText("Inkly Document Seal"),
      Reason: PDFHexString.fromText("Sealed by Inkly on completion"),
      M: PDFString.fromDate(at),
    }),
  );
  const page = doc.getPage(0);
  const widget = ctx.register(
    ctx.obj({
      Type: "Annot",
      Subtype: "Widget",
      FT: "Sig",
      // Print and Locked, with no area: the seal has no appearance on the page.
      F: 4 | 128,
      Rect: [0, 0, 0, 0],
      T: PDFHexString.fromText(`Inkly seal ${at.toISOString()}`),
      V: sig,
      P: page.ref,
    }),
  );
  page.node.addAnnot(widget);
  const form = doc.catalog.getOrCreateAcroForm();
  form.addField(widget);
  form.dict.set(PDFName.of("SigFlags"), PDFNumber.of(3));

  const bytes = await doc.save({ useObjectStreams: false });
  const text = latin1(bytes);
  const contentsAt = onlyIndex(text, CONTENTS_PLACEHOLDER);
  const contentsEnd = contentsAt + CONTENTS_PLACEHOLDER.length;
  const placeholder = [...text.matchAll(BYTE_RANGE_PATTERN)];
  const [match] = placeholder;
  if (placeholder.length !== 1 || !match) {
    throw new AppError("internal", "seal ByteRange placeholder is missing or not unique");
  }
  const range = `[0 ${String(contentsAt)} ${String(contentsEnd)} ${String(bytes.length - contentsEnd)}]`;
  bytes.set(new TextEncoder().encode(range.padEnd(match[0].length, " ")), match.index);

  const signed = new Uint8Array(contentsAt + bytes.length - contentsEnd);
  signed.set(bytes.subarray(0, contentsAt));
  signed.set(bytes.subarray(contentsEnd), contentsAt);
  const cms = await signedData(await crypto.subtle.digest("SHA-256", signed), key, at);
  if (cms.length > CONTENTS_BYTES) throw new AppError("internal", "seal signature is too large");
  const hex = Array.from(cms, (b) => b.toString(16).padStart(2, "0")).join("");
  bytes.set(new TextEncoder().encode(hex), contentsAt + 1);
  return bytes;
}
