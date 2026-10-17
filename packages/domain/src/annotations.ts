import { z } from "zod";

// Annotations and Comments (T2.2). Geometry is page-relative: 0..1 of the page as it is
// displayed (rotation applied), origin top-left, so it is independent of render scale.

export const ANNOTATION_COLORS = ["yellow", "green", "blue", "red"] as const;
export const AnnotationColor = z.enum(ANNOTATION_COLORS);
export type AnnotationColor = z.infer<typeof AnnotationColor>;

const Unit = z.number().min(0).max(1);
const EPSILON = 1e-6;

export const Point = z.object({ x: Unit, y: Unit });
export type Point = z.infer<typeof Point>;

export const Rect = z
  .object({ x: Unit, y: Unit, w: Unit, h: Unit })
  .refine((r) => r.x + r.w <= 1 + EPSILON && r.y + r.h <= 1 + EPSILON, "rect leaves the page");
export type Rect = z.infer<typeof Rect>;

const PageNo = z.number().int().min(1).max(10_000);
const NoteText = z.string().trim().min(1).max(2000);
const CommentText = z.string().trim().min(1).max(4000);

export const AnnotationShape = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("highlight"),
    page: PageNo,
    color: AnnotationColor,
    rects: z.array(Rect).min(1).max(50),
  }),
  z.object({
    kind: z.literal("note"),
    page: PageNo,
    color: AnnotationColor,
    at: Point,
    text: NoteText,
  }),
  z.object({
    kind: z.literal("ink"),
    page: PageNo,
    color: AnnotationColor,
    strokes: z.array(z.array(Point).min(2).max(2000)).min(1).max(50),
  }),
]);
export type AnnotationShape = z.infer<typeof AnnotationShape>;
export type AnnotationKind = AnnotationShape["kind"];

/** An edit by the author: a new color, or a note's new text. */
export const AnnotationPatch = z
  .object({ color: AnnotationColor.optional(), text: NoteText.optional() })
  .refine((p) => p.color !== undefined || p.text !== undefined, "nothing to change");
export type AnnotationPatch = z.infer<typeof AnnotationPatch>;

export const CommentCreate = z.object({ text: CommentText });
export type CommentCreate = z.infer<typeof CommentCreate>;

export const Author = z.object({ id: z.string(), name: z.string() });
export type Author = z.infer<typeof Author>;

export const Comment = z.object({
  id: z.string(),
  author: Author,
  text: z.string(),
  createdAt: z.number(),
});
export type Comment = z.infer<typeof Comment>;

export const Annotation = z.object({
  id: z.string(),
  shape: AnnotationShape,
  /** The Version the Annotation was drawn on. */
  version: z.number().int(),
  author: Author,
  createdAt: z.number(),
  updatedAt: z.number(),
  /** When its Comment thread was resolved; null while open. */
  resolvedAt: z.number().nullable(),
  comments: z.array(Comment),
});
export type Annotation = z.infer<typeof Annotation>;

export const AnnotationResponse = z.object({ annotation: Annotation });
export const AnnotationListResponse = z.object({ annotations: z.array(Annotation) });

/** What a DocSession sends to every open viewer. */
export const LiveMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("presence"), members: z.array(Author) }),
  z.object({ type: z.literal("annotation"), annotation: Annotation }),
  z.object({ type: z.literal("deleted"), id: z.string() }),
]);
export type LiveMessage = z.infer<typeof LiveMessage>;
