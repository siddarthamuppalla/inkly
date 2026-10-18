import type { FieldKind, Rect } from "@inkly/domain";
import { useEffect, useRef, type DragEvent, type KeyboardEvent, type PointerEvent } from "react";

import { cn } from "../../lib/cn.ts";
import {
  fillVar,
  inkVar,
  KIND_LABEL,
  type DraftField,
  type DraftRecipient,
} from "../../lib/envelope-draft.ts";
import {
  fieldRectAt,
  moveRect,
  nudge,
  resizeRect,
  toPage,
  type Box,
} from "../../lib/field-geometry.ts";

/** The drag-and-drop type a palette button carries: the field kind. */
export const FIELD_DRAG_TYPE = "application/x-inkly-field";

export interface FieldLayerProps {
  readonly page: number;
  readonly fields: readonly DraftField[];
  readonly recipients: readonly DraftRecipient[];
  /** The palette kind waiting for a click on a page, if any. */
  readonly armed: FieldKind | null;
  readonly selected: string | null;
  /** A field just placed, which takes focus once it is on screen. */
  readonly focusId: string | null;
  readonly onPlace: (kind: FieldKind, page: number, rect: Rect) => void;
  readonly onChange: (id: string, rect: Rect) => void;
  readonly onSelect: (id: string | null) => void;
  readonly onRemove: (id: string) => void;
}

/**
 * One page's Envelope fields over its canvas, in page-relative units like the annotation
 * layer: click or drop to place, drag to move, the corner handle to resize, arrow keys to
 * nudge and Delete to remove.
 */
export function FieldLayer(props: FieldLayerProps) {
  const { page, fields, recipients, armed, onPlace, onSelect } = props;
  const surface = useRef<HTMLDivElement>(null);
  const box = (): Box =>
    surface.current?.getBoundingClientRect() ?? { left: 0, top: 0, width: 1, height: 1 };

  function placeAt(kind: FieldKind, clientX: number, clientY: number) {
    const b = box();
    onPlace(kind, page, fieldRectAt(kind, toPage(clientX, clientY, b), b));
  }

  function drop(e: DragEvent<HTMLDivElement>) {
    const kind = e.dataTransfer.getData(FIELD_DRAG_TYPE);
    if (!(kind in KIND_LABEL)) return;
    e.preventDefault();
    placeAt(kind as FieldKind, e.clientX, e.clientY);
  }

  return (
    <div
      ref={surface}
      tabIndex={-1}
      data-testid="field-layer"
      data-page={page}
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        if (armed) placeAt(armed, e.clientX, e.clientY);
        else onSelect(null);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(FIELD_DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={drop}
      className={cn("absolute inset-0 touch-none outline-none", armed && "cursor-crosshair")}
    >
      {armed && (
        <button
          type="button"
          onClick={() => {
            onPlace(armed, page, fieldRectAt(armed, { x: 0.5, y: 0.5 }, box()));
          }}
          className="sr-only rounded-md border bg-card px-3 py-2 text-sm font-medium text-card-foreground shadow-sheet focus:not-sr-only focus:absolute focus:left-2 focus:top-2"
        >
          Place {KIND_LABEL[armed].toLowerCase()} on page {page}
        </button>
      )}
      {fields.map((f) => {
        const index = recipients.findIndex((r) => r.id === f.recipientId);
        return (
          <FieldBox
            key={f.id}
            field={f}
            ink={inkVar(Math.max(0, index))}
            fill={fillVar(Math.max(0, index))}
            owner={recipients[index]?.name ?? "nobody"}
            selected={props.selected === f.id}
            focusOnMount={props.focusId === f.id}
            box={box}
            onSelect={() => {
              onSelect(f.id);
            }}
            onChange={(rect) => {
              props.onChange(f.id, rect);
            }}
            onRemove={() => {
              props.onRemove(f.id);
              surface.current?.focus();
            }}
          />
        );
      })}
    </div>
  );
}

type Gesture = {
  readonly mode: "move" | "resize";
  readonly pointerId: number;
  readonly from: { x: number; y: number };
  readonly rect: Rect;
};

function FieldBox({
  field,
  ink,
  fill,
  owner,
  selected,
  focusOnMount,
  box,
  onSelect,
  onChange,
  onRemove,
}: {
  readonly field: DraftField;
  readonly ink: string;
  readonly fill: string;
  readonly owner: string;
  readonly selected: boolean;
  readonly focusOnMount: boolean;
  readonly box: () => Box;
  readonly onSelect: () => void;
  readonly onChange: (rect: Rect) => void;
  readonly onRemove: () => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const gesture = useRef<Gesture | null>(null);

  useEffect(() => {
    if (focusOnMount) button.current?.focus();
    // Only on mount: a field takes focus once, when it is placed.
  }, []);

  function start(mode: Gesture["mode"], e: PointerEvent<HTMLElement>) {
    e.stopPropagation();
    onSelect();
    button.current?.setPointerCapture(e.pointerId);
    gesture.current = {
      mode,
      pointerId: e.pointerId,
      from: toPage(e.clientX, e.clientY, box()),
      rect: field.rect,
    };
  }

  function move(e: PointerEvent<HTMLButtonElement>) {
    const g = gesture.current;
    if (g?.pointerId !== e.pointerId) return;
    const at = toPage(e.clientX, e.clientY, box());
    onChange(
      g.mode === "move"
        ? moveRect(g.rect, at.x - g.from.x, at.y - g.from.y)
        : resizeRect(g.rect, {
            x: g.rect.x + g.rect.w + at.x - g.from.x,
            y: g.rect.y + g.rect.h + at.y - g.from.y,
          }),
    );
  }

  function key(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      onRemove();
      return;
    }
    const next = nudge(field.rect, e.key, { shift: e.shiftKey, alt: e.altKey });
    if (!next) return;
    e.preventDefault();
    onChange(next);
  }

  const { x, y, w, h } = field.rect;
  const percent = (v: number) => `${String(v * 100)}%`;
  const label = KIND_LABEL[field.kind];
  return (
    <button
      ref={button}
      type="button"
      data-testid="envelope-field"
      data-field-id={field.id}
      data-kind={field.kind}
      aria-label={`${label} for ${owner}, page ${String(field.page)}${field.required ? "" : ", optional"}`}
      aria-pressed={selected}
      onPointerDown={(e) => {
        start("move", e);
      }}
      onPointerMove={move}
      onPointerUp={() => {
        gesture.current = null;
      }}
      onPointerCancel={() => {
        gesture.current = null;
      }}
      onFocus={onSelect}
      onKeyDown={key}
      style={{
        left: percent(x),
        top: percent(y),
        width: percent(w),
        height: percent(h),
        color: ink,
        borderColor: ink,
        backgroundColor: fill,
      }}
      className={cn(
        "absolute flex cursor-move items-start overflow-hidden rounded-sm border-2 px-1 text-left text-xs font-semibold leading-tight",
        "focus-visible:outline-(--field-ink) focus-visible:outline-offset-2",
        selected && "outline-2 outline-offset-2 outline-dashed outline-(--field-ink)",
      )}
    >
      {field.kind !== "checkbox" && <span className="truncate">{label}</span>}
      {selected && (
        <span
          aria-hidden="true"
          data-testid="resize-handle"
          onPointerDown={(e) => {
            start("resize", e);
          }}
          style={{ backgroundColor: ink }}
          className="absolute bottom-0 right-0 size-3 cursor-nwse-resize"
        />
      )}
    </button>
  );
}
