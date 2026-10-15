import {
  getDocument,
  GlobalWorkerOptions,
  RenderingCancelledException,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import workerSrc from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState } from "react";

GlobalWorkerOptions.workerSrc = workerSrc;

/** Loads PDF bytes with PDF.js. PDF.js takes ownership of the buffer it is given, so it gets a copy. */
export function usePdf(data: ArrayBuffer | undefined): {
  pdf: PDFDocumentProxy | null;
  error: boolean;
} {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!data) return;
    let cancelled = false;
    const task = getDocument({ data: new Uint8Array(data.slice(0)) });
    task.promise.then(
      (doc) => {
        if (!cancelled) setPdf(doc);
      },
      () => {
        if (!cancelled) setError(true);
      },
    );
    return () => {
      cancelled = true;
      setPdf(null);
      void task.destroy();
    };
  }, [data]);
  return { pdf, error };
}

/** One page drawn onto a canvas `width` CSS pixels wide. */
export function PageCanvas({
  pdf,
  pageNumber,
  width,
  label,
  className,
  testId,
}: {
  readonly pdf: PDFDocumentProxy;
  readonly pageNumber: number;
  readonly width: number;
  readonly label?: string;
  readonly className?: string;
  readonly testId: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [rendered, setRendered] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const run = { cancelled: false };
    const stopped = () => run.cancelled;
    let task: RenderTask | undefined;
    pdf
      .getPage(pageNumber)
      .then(async (page) => {
        const target = canvas.current;
        if (stopped() || !target) return;
        const scale = (width / page.getViewport({ scale: 1 }).width) * window.devicePixelRatio;
        const viewport = page.getViewport({ scale });
        target.width = Math.floor(viewport.width);
        target.height = Math.floor(viewport.height);
        task = page.render({ canvas: target, viewport });
        await task.promise;
        if (!stopped()) setRendered(true);
      })
      .catch((err: unknown) => {
        if (!stopped() && !(err instanceof RenderingCancelledException)) setFailed(true);
      });
    return () => {
      run.cancelled = true;
      task?.cancel();
    };
  }, [pdf, pageNumber, width]);

  return (
    <canvas
      ref={canvas}
      data-testid={testId}
      data-rendered={rendered}
      data-failed={failed || undefined}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      className={className}
    />
  );
}
