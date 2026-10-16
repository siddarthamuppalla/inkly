import type { Annotation, Point, Rect } from "@inkly/domain";
import { useMutation } from "@tanstack/react-query";
import { useRef, useState, type PointerEvent } from "react";

import { cn } from "../../lib/cn.ts";
import { colorVar, KIND_LABEL, useAnnotationsState } from "./context.tsx";

const MIN_SIZE = 0.005;
const MIN_STEP = 0.003;

type Draft = { kind: "highlight"; from: Point; to: Point } | { kind: "ink"; points: Point[] };

const clamp = (v: number) => Math.min(1, Math.max(0, v));

function rectOf(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

const path = (points: readonly Point[]) =>
  points.map((p, i) => `${i === 0 ? "M" : "L"}${String(p.x)} ${String(p.y)}`).join(" ");

/**
 * The Annotations of one page of the current Version, drawn over its canvas in
 * page-relative units, plus the pointer handling of the Highlight, Note and Ink tools.
 */
export function AnnotationLayer({ page }: { readonly page: number }) {
  const state = useAnnotationsState();
  const { doc, tool, color, selected, select, api } = state;
  const surface = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const create = useMutation({
    mutationFn: api.create,
    onSuccess: (a) => {
      select(a.id);
    },
  });
  const drawing = state.canWrite && tool !== "select";
  const mine = state.annotations.filter(
    (a) => a.version === doc.currentVersion && a.shape.page === page,
  );

  function at(e: PointerEvent): Point {
    const box = surface.current?.getBoundingClientRect();
    if (!box) return { x: 0, y: 0 };
    return {
      x: clamp((e.clientX - box.left) / box.width),
      y: clamp((e.clientY - box.top) / box.height),
    };
  }

  function down(e: PointerEvent<HTMLDivElement>) {
    if (!drawing) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = at(e);
    if (tool === "note") state.setPendingNote({ page, at: p });
    if (tool === "highlight") setDraft({ kind: "highlight", from: p, to: p });
    if (tool === "ink") setDraft({ kind: "ink", points: [p] });
  }

  function move(e: PointerEvent<HTMLDivElement>) {
    if (!draft) return;
    const p = at(e);
    if (draft.kind === "highlight") setDraft({ ...draft, to: p });
    else {
      const last = draft.points[draft.points.length - 1];
      if (last && Math.hypot(p.x - last.x, p.y - last.y) >= MIN_STEP) {
        setDraft({ kind: "ink", points: [...draft.points, p] });
      }
    }
  }

  function up() {
    if (!draft) return;
    setDraft(null);
    if (draft.kind === "highlight") {
      const rect = rectOf(draft.from, draft.to);
      if (rect.w >= MIN_SIZE && rect.h >= MIN_SIZE) {
        create.mutate({ kind: "highlight", page, color, rects: [rect] });
      }
    } else if (draft.points.length >= 2) {
      create.mutate({ kind: "ink", page, color, strokes: [draft.points] });
    }
  }

  return (
    <div
      ref={surface}
      data-testid="annotation-layer"
      data-page={page}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => {
        setDraft(null);
      }}
      className={cn(
        "absolute inset-0 touch-none",
        drawing ? "cursor-crosshair" : "pointer-events-none",
      )}
    >
      <svg
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        className="absolute inset-0 size-full overflow-visible"
        aria-hidden="true"
      >
        {mine.map((a) => (
          <Shape
            key={a.id}
            annotation={a}
            selected={a.id === selected}
            interactive={!drawing}
            onSelect={() => {
              select(a.id);
            }}
          />
        ))}
        {draft?.kind === "highlight" && (
          <rect
            {...(({ x, y, w, h }) => ({ x, y, width: w, height: h }))(rectOf(draft.from, draft.to))}
            style={{ fill: colorVar(color) }}
            className="opacity-50 mix-blend-multiply"
          />
        )}
        {draft?.kind === "ink" && (
          <path
            d={path(draft.points)}
            style={{ stroke: colorVar(color) }}
            className="fill-none"
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {mine.map(
        (a) =>
          a.shape.kind === "note" && (
            <button
              key={a.id}
              type="button"
              data-testid="note-marker"
              aria-label={`Note by ${a.author.name}: ${a.shape.text}`}
              aria-pressed={a.id === selected}
              onClick={() => {
                select(a.id);
              }}
              style={{
                left: `${String(a.shape.at.x * 100)}%`,
                top: `${String(a.shape.at.y * 100)}%`,
                backgroundColor: colorVar(a.shape.color),
              }}
              className={cn(
                "absolute size-6 rounded-sm rounded-bl-none border border-foreground shadow-sheet",
                drawing ? "pointer-events-none" : "pointer-events-auto",
                a.id === selected && "outline-2 outline-offset-2 outline-ring",
              )}
            />
          ),
      )}
    </div>
  );
}

function Shape({
  annotation: a,
  selected,
  interactive,
  onSelect,
}: {
  readonly annotation: Annotation;
  readonly selected: boolean;
  readonly interactive: boolean;
  readonly onSelect: () => void;
}) {
  const common = {
    "data-testid": `annotation-${a.shape.kind}`,
    "data-annotation-id": a.id,
    onClick: onSelect,
    className: cn(interactive ? "pointer-events-auto cursor-pointer" : "pointer-events-none"),
  };
  const outline = selected ? { stroke: "var(--ring)", strokeWidth: 2 } : {};
  switch (a.shape.kind) {
    case "highlight":
      return (
        <g {...common}>
          <title>{`${KIND_LABEL.highlight} by ${a.author.name}`}</title>
          {a.shape.rects.map((r, i) => (
            <rect
              key={i}
              x={r.x}
              y={r.y}
              width={r.w}
              height={r.h}
              style={{ fill: colorVar(a.shape.color) }}
              className="opacity-50 mix-blend-multiply"
              vectorEffect="non-scaling-stroke"
              {...outline}
            />
          ))}
        </g>
      );
    case "ink":
      return (
        <g {...common}>
          {a.shape.strokes.map((s, i) => (
            <path
              key={i}
              d={path(s)}
              style={{ stroke: selected ? "var(--ring)" : colorVar(a.shape.color) }}
              className="fill-none"
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </g>
      );
    case "note":
      return null;
  }
}
