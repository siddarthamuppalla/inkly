import { describe, expect, it } from "vitest";

import { AppError, assertShareLinkAllowed, ShareLinkCreate } from "../src/index.ts";

const NOW = Date.UTC(2026, 9, 16);
const DAY = 24 * 60 * 60 * 1000;

function refusal(fn: () => void): { code: string; status: number } | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (err instanceof AppError) return { code: err.code, status: err.status };
    throw err;
  }
}

const link = (over: Partial<ShareLinkCreate> = {}): ShareLinkCreate => ({
  documentId: "doc_1",
  expiresAt: NOW + 7 * DAY,
  password: null,
  allowDownload: true,
  ...over,
});

const LIMIT = { code: "limit_exceeded", status: 402 };

describe("share link rules (Q8)", () => {
  it("lets Free share for up to 7 days with download on and no password", () => {
    expect(
      refusal(() => {
        assertShareLinkAllowed("free", link(), NOW);
      }),
    ).toBeNull();
    expect(
      refusal(() => {
        assertShareLinkAllowed("free", link({ expiresAt: NOW + DAY }), NOW);
      }),
    ).toBeNull();
  });

  it("refuses Free links that never expire or outlive 7 days", () => {
    expect(
      refusal(() => {
        assertShareLinkAllowed("free", link({ expiresAt: null }), NOW);
      }),
    ).toEqual(LIMIT);
    expect(
      refusal(() => {
        assertShareLinkAllowed("free", link({ expiresAt: NOW + 7 * DAY + 1 }), NOW);
      }),
    ).toEqual(LIMIT);
  });

  it("refuses a password or download off on Free", () => {
    expect(
      refusal(() => {
        assertShareLinkAllowed("free", link({ password: "hunter22" }), NOW);
      }),
    ).toEqual(LIMIT);
    expect(
      refusal(() => {
        assertShareLinkAllowed("free", link({ allowDownload: false }), NOW);
      }),
    ).toEqual(LIMIT);
  });

  it("lets Pro pick any expiry or none, a password and download off", () => {
    for (const over of [
      { expiresAt: null },
      { expiresAt: NOW + 365 * DAY },
      { password: "hunter22", allowDownload: false },
    ]) {
      expect(
        refusal(() => {
          assertShareLinkAllowed("pro", link(over), NOW);
        }),
      ).toBeNull();
    }
  });

  it("refuses an expiry in the past on any plan with invalid_input", () => {
    for (const plan of ["free", "pro"] as const) {
      expect(
        refusal(() => {
          assertShareLinkAllowed(plan, link({ expiresAt: NOW - 1 }), NOW);
        }),
      ).toEqual({
        code: "invalid_input",
        status: 422,
      });
    }
  });

  it("parses a request, defaulting to download on and no password", () => {
    expect(ShareLinkCreate.parse({ documentId: "doc_1", expiresAt: null })).toEqual({
      documentId: "doc_1",
      expiresAt: null,
      password: null,
      allowDownload: true,
    });
    expect(
      ShareLinkCreate.safeParse({ documentId: "doc_1", expiresAt: null, password: "short" })
        .success,
    ).toBe(false);
  });
});
