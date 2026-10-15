import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import { diffPngs } from "../src/index.ts";

function png(width: number, height: number, paint?: (x: number, y: number) => number): Buffer {
  const img = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const v = paint ? paint(x, y) : 255;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(img);
}

describe("diffPngs", () => {
  it("reports 0% for identical images", () => {
    expect(diffPngs(png(20, 10), png(20, 10))).toEqual({
      diffPixels: 0,
      totalPixels: 200,
      percent: 0,
    });
  });

  it("counts changed pixels", () => {
    const d = diffPngs(
      png(20, 10),
      png(20, 10, (x) => (x < 2 ? 0 : 255)),
    );
    expect(d.diffPixels).toBe(20);
    expect(d.percent).toBe(10);
  });

  it("treats a size mismatch as 100% different", () => {
    expect(diffPngs(png(20, 10), png(10, 20)).percent).toBe(100);
  });
});
