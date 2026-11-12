import { describe, expect, it } from "vitest";
import { chooseGridStep, renderScreenOverlay } from "../src/overlay.js";
import { cropRgba, decodePng, encodePng, resizeRgba } from "../src/png.js";

describe("PNG Codec, Resizer & Coordinate/Mouse Overlay", () => {
  it("losslessly encodes and decodes RGBA images", () => {
    const w = 64;
    const h = 48;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        rgba[i] = (x * 4) & 0xff;
        rgba[i + 1] = (y * 5) & 0xff;
        rgba[i + 2] = ((x + y) * 3) & 0xff;
        rgba[i + 3] = 255;
      }
    }

    const encoded = encodePng(w, h, rgba);
    const decoded = decodePng(encoded);
    expect(decoded.width).toBe(w);
    expect(decoded.height).toBe(h);
    expect(Buffer.from(decoded.data).equals(Buffer.from(rgba))).toBe(true);
  });

  it("crops and resizes RGBA frames accurately", () => {
    const w = 200;
    const h = 100;
    const src = new Uint8Array(w * h * 4).fill(180);
    const cropped = cropRgba(src, w, h, 50, 25, 80, 40);
    expect(cropped.width).toBe(80);
    expect(cropped.height).toBe(40);
    expect(cropped.x).toBe(50);
    expect(cropped.y).toBe(25);

    const resized = resizeRgba(src, w, h, 100, 50);
    expect(resized.length).toBe(100 * 50 * 4);
    expect(resized[0]).toBe(180);
  });

  it("renders mapped coordinate grid and red mouse reticle without edge clipping", () => {
    const w = 640;
    const h = 400;

    // Test mouse near all 4 corners + center + outside region
    const positions = [
      { x: 320, y: 200 },
      { x: 2, y: 2 },
      { x: 638, y: 2 },
      { x: 2, y: 398 },
      { x: 638, y: 398 },
      { x: 900, y: 900 },
    ];

    for (const mouse of positions) {
      const buf = new Uint8Array(w * h * 4).fill(240);
      const res = renderScreenOverlay(buf, w, h, {
        originX: 0,
        originY: 0,
        logicalWidth: w,
        logicalHeight: h,
        mouse,
        grid: true,
        showMouse: true,
      });
      expect(res.gridStep).toBe(chooseGridStep(w, h));
    }

    // Verify red reticle pixels appear around mouse=(320, 200)
    const buf = new Uint8Array(w * h * 4).fill(255);
    renderScreenOverlay(buf, w, h, {
      originX: 0,
      originY: 0,
      logicalWidth: w,
      logicalHeight: h,
      mouse: { x: 320, y: 200 },
      grid: false,
      showMouse: true,
    });

    // At 12px right of center (332, 200), red ring (R > 220, G < 100) must be drawn
    const ringIdx = (200 * w + 332) * 4;
    expect(buf[ringIdx]!).toBeGreaterThan(220);
    expect(buf[ringIdx + 1]!).toBeLessThan(100);

    // Exact center pixel (320, 200) stays untouched (255, 255, 255) so pixel under cursor stays visible
    const centerIdx = (200 * w + 320) * 4;
    expect(buf[centerIdx]).toBe(255);
    expect(buf[centerIdx + 1]).toBe(255);
    expect(buf[centerIdx + 2]).toBe(255);
  });
});
