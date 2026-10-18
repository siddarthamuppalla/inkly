import { useEffect, useId, useRef, useState, type PointerEvent } from "react";

import { cn } from "../lib/cn.ts";
import { Button } from "./ui/button.tsx";
import { Field } from "./ui/field.tsx";

// The adopt dialog of the /sign page (T3.3): the signer types their name, rendered in the
// script face, or draws with a pointer. Either way the result is a transparent PNG data URL
// in signature ink, so the server and the stamp have one path (ADR-0006).

const WIDTH = 600;
const HEIGHT = 200;

function ink(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--signature-ink").trim();
}

function scriptFont(px: number): string {
  const family = getComputedStyle(document.documentElement).getPropertyValue("--font-script");
  return `${String(px)}px ${family.trim() || "cursive"}`;
}

/** `text` in the script face, centred on a transparent canvas, as a PNG data URL. */
export function typedSignature(text: string): string {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  let size = 96;
  ctx.font = scriptFont(size);
  while (size > 24 && ctx.measureText(text).width > WIDTH - 40) {
    size -= 4;
    ctx.font = scriptFont(size);
  }
  ctx.fillStyle = ink();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, WIDTH / 2, HEIGHT / 2);
  return canvas.toDataURL("image/png");
}

export function AdoptSignature({
  open,
  kind,
  defaultText,
  onAdopt,
  onClose,
}: {
  readonly open: boolean;
  readonly kind: "signature" | "initials";
  readonly defaultText: string;
  readonly onAdopt: (png: string) => void;
  readonly onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [mode, setMode] = useState<"type" | "draw">("type");
  const [text, setText] = useState(defaultText);
  const pad = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [drawn, setDrawn] = useState(false);
  const what = kind === "signature" ? "signature" : "initials";

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) {
      setText(defaultText);
      setDrawn(false);
      el.showModal();
    }
    if (!open && el.open) el.close();
  }, [open, defaultText]);

  function point(e: PointerEvent<HTMLCanvasElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - box.left) / box.width) * WIDTH,
      y: ((e.clientY - box.top) / box.height) * HEIGHT,
    };
  }

  function start(e: PointerEvent<HTMLCanvasElement>) {
    const ctx = e.currentTarget.getContext("2d");
    if (!ctx) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const { x, y } = point(e);
    ctx.strokeStyle = ink();
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(x, y);
  }

  function move(e: PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = e.currentTarget.getContext("2d");
    if (!ctx) return;
    const { x, y } = point(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    setDrawn(true);
  }

  function clear() {
    pad.current?.getContext("2d")?.clearRect(0, 0, WIDTH, HEIGHT);
    setDrawn(false);
  }

  function adopt() {
    const png = mode === "type" ? typedSignature(text.trim()) : pad.current?.toDataURL("image/png");
    if (png) onAdopt(png);
  }

  const ready = mode === "type" ? text.trim() !== "" : drawn;

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto w-[min(36rem,calc(100vw-2rem))] rounded-md border bg-card p-0 text-card-foreground shadow-sheet backdrop:bg-foreground/40"
    >
      <div className="flex flex-col gap-4 p-5 sm:p-6">
        <h2 id={titleId} className="text-2xl">
          Adopt your {what}
        </h2>
        <div role="group" aria-label="How to make it" className="flex gap-2">
          {(["type", "draw"] as const).map((m) => (
            <Button
              key={m}
              size="sm"
              variant={mode === m ? "primary" : "secondary"}
              aria-pressed={mode === m}
              onClick={() => {
                setMode(m);
              }}
            >
              {m === "type" ? "Type" : "Draw"}
            </Button>
          ))}
        </div>
        {mode === "type" ? (
          <>
            <Field
              label={kind === "signature" ? "Your full name" : "Your initials"}
              value={text}
              autoComplete={kind === "signature" ? "name" : "off"}
              onChange={(e) => {
                setText(e.currentTarget.value);
              }}
            />
            <p
              aria-hidden="true"
              className="min-h-20 overflow-hidden rounded-md border border-dashed border-input bg-card px-4 py-2 text-center text-4xl text-link [font-family:var(--font-script)]"
            >
              {text}
            </p>
          </>
        ) : (
          <div className="flex flex-col gap-2">
            <canvas
              ref={pad}
              width={WIDTH}
              height={HEIGHT}
              role="img"
              aria-label={`Drawing pad for your ${what}`}
              data-testid="signature-pad"
              onPointerDown={start}
              onPointerMove={move}
              onPointerUp={() => {
                drawing.current = false;
              }}
              className={cn(
                "aspect-[3/1] w-full touch-none rounded-md border border-dashed border-input bg-card",
              )}
            />
            <p className="text-sm text-muted-foreground">
              Draw with your mouse, finger or pen. To sign with the keyboard, choose Type.
            </p>
            <Button variant="secondary" size="sm" className="self-start" onClick={clear}>
              Clear
            </Button>
          </div>
        )}
        <p className="text-sm text-muted-foreground">
          By adopting it, you agree this mark is your electronic {what}.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button disabled={!ready} onClick={adopt}>
            Adopt and sign
          </Button>
          <Button variant="secondary" onClick={() => dialog.current?.close()}>
            Cancel
          </Button>
        </div>
      </div>
    </dialog>
  );
}
