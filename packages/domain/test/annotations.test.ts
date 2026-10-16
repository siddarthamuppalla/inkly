import { describe, expect, it } from "vitest";

import { AnnotationPatch, AnnotationShape, CommentCreate, LiveMessage } from "../src/index.ts";

describe("annotation shapes", () => {
  it("accepts a highlight, a note and an ink stroke in page-relative units", () => {
    const shapes = [
      { kind: "highlight", page: 1, color: "yellow", rects: [{ x: 0.1, y: 0.1, w: 0.5, h: 0.05 }] },
      { kind: "note", page: 2, color: "blue", at: { x: 0.9, y: 0.9 }, text: "  Check this  " },
      {
        kind: "ink",
        page: 3,
        color: "red",
        strokes: [
          [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
          ],
        ],
      },
    ];
    for (const shape of shapes) expect(AnnotationShape.safeParse(shape).success).toBe(true);
    expect(AnnotationShape.parse(shapes[1])).toMatchObject({ text: "Check this" });
  });

  it.each([
    { kind: "highlight", page: 1, color: "yellow", rects: [] },
    { kind: "highlight", page: 1, color: "yellow", rects: [{ x: 0.8, y: 0, w: 0.5, h: 0.1 }] },
    { kind: "highlight", page: 0, color: "yellow", rects: [{ x: 0, y: 0, w: 0.1, h: 0.1 }] },
    { kind: "highlight", page: 1, color: "#ff0000", rects: [{ x: 0, y: 0, w: 0.1, h: 0.1 }] },
    { kind: "note", page: 1, color: "yellow", at: { x: 1.5, y: 0 }, text: "x" },
    { kind: "note", page: 1, color: "yellow", at: { x: 0, y: 0 }, text: " " },
    { kind: "ink", page: 1, color: "blue", strokes: [[{ x: 0, y: 0 }]] },
    { kind: "stamp", page: 1, color: "blue" },
  ])("rejects %j", (shape) => {
    expect(AnnotationShape.safeParse(shape).success).toBe(false);
  });

  it("needs something to change in a patch and a non-empty comment", () => {
    expect(AnnotationPatch.safeParse({}).success).toBe(false);
    expect(AnnotationPatch.parse({ color: "green" })).toEqual({ color: "green" });
    expect(CommentCreate.safeParse({ text: "   " }).success).toBe(false);
    expect(CommentCreate.parse({ text: " ok " })).toEqual({ text: "ok" });
  });

  it("reads every live message the DocSession sends", () => {
    expect(
      LiveMessage.safeParse({ type: "presence", members: [{ id: "u", name: "A" }] }).success,
    ).toBe(true);
    expect(LiveMessage.safeParse({ type: "deleted", id: "a" }).success).toBe(true);
    expect(LiveMessage.safeParse({ type: "hello" }).success).toBe(false);
  });
});
