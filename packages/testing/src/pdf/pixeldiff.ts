import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export interface PixelDiff {
  readonly diffPixels: number;
  readonly totalPixels: number;
  /** Share of differing pixels, as a percentage (0–100). */
  readonly percent: number;
}

/** Compares two PNGs. Images of different sizes count as 100% different. */
export function diffPngs(expected: Uint8Array, actual: Uint8Array): PixelDiff {
  const a = PNG.sync.read(Buffer.from(expected));
  const b = PNG.sync.read(Buffer.from(actual));
  if (a.width !== b.width || a.height !== b.height) {
    const totalPixels = Math.max(a.width * a.height, b.width * b.height);
    return { diffPixels: totalPixels, totalPixels, percent: 100 };
  }
  const totalPixels = a.width * a.height;
  const diffPixels = pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.1 });
  return { diffPixels, totalPixels, percent: (diffPixels / totalPixels) * 100 };
}
