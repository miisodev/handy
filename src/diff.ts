import type { FrameDiff, Point, RawFrame } from "./types.js";

export function parseHexRgb(hex: string): [number, number, number] {
  const clean = hex.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(clean)) {
    const r = Number.parseInt(clean[0]! + clean[0]!, 16);
    const g = Number.parseInt(clean[1]! + clean[1]!, 16);
    const b = Number.parseInt(clean[2]! + clean[2]!, 16);
    return [r, g, b];
  }
  if (/^[0-9a-fA-F]{6}$/.test(clean)) {
    const r = Number.parseInt(clean.slice(0, 2), 16);
    const g = Number.parseInt(clean.slice(2, 4), 16);
    const b = Number.parseInt(clean.slice(4, 6), 16);
    return [r, g, b];
  }
  throw new Error(`Invalid hex color "${hex}". Expected #rrggbb or #rgb.`);
}

export function hexColorDistance(hexA: string, hexB: string): number {
  const [r1, g1, b1] = parseHexRgb(hexA);
  const [r2, g2, b2] = parseHexRgb(hexB);
  return Math.hypot(r1 - r2, g1 - g2, b1 - b2);
}

/**
 * Samples the exact #rrggbb hex color at global logical coordinate (mouse.x, mouse.y)
 * from a raw frame BEFORE any rulers or reticles are drawn on top of it.
 */
export function samplePixelHex(frame: RawFrame, point: Point): string | null {
  const relX = point.x - frame.originX;
  const relY = point.y - frame.originY;
  if (relX < 0 || relY < 0 || relX >= frame.logicalWidth || relY >= frame.logicalHeight) {
    return null;
  }

  const px = Math.min(frame.width - 1, Math.max(0, Math.round((relX / Math.max(1, frame.logicalWidth)) * frame.width)));
  const py = Math.min(
    frame.height - 1,
    Math.max(0, Math.round((relY / Math.max(1, frame.logicalHeight)) * frame.height)),
  );
  const idx = (py * frame.width + px) * 4;
  const r = frame.data[idx] ?? 0;
  const g = frame.data[idx + 1] ?? 0;
  const b = frame.data[idx + 2] ?? 0;
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

/**
 * Computes fast (<2ms on 1080p) visual frame difference between two RawFrames covering the
 * same logical screen region, returning changed percentage and global logical bounding box.
 */
export function computeFrameDiff(prev: RawFrame, curr: RawFrame, channelDeltaThreshold = 14): FrameDiff | null {
  if (
    prev.width !== curr.width ||
    prev.height !== curr.height ||
    prev.originX !== curr.originX ||
    prev.originY !== curr.originY
  ) {
    return null;
  }

  const w = curr.width;
  const h = curr.height;
  const totalPixels = w * h;
  if (totalPixels === 0) {
    return { changedPercent: 0, changedPixels: 0, changedBounds: null };
  }

  const a = prev.data;
  const b = curr.data;
  let changedPixels = 0;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < h; y++) {
    const rowOff = y * w * 4;
    for (let x = 0; x < w; x++) {
      const i = rowOff + x * 4;
      const dr = Math.abs(a[i]! - b[i]!);
      const dg = Math.abs(a[i + 1]! - b[i + 1]!);
      const db = Math.abs(a[i + 2]! - b[i + 2]!);
      if (dr > channelDeltaThreshold || dg > channelDeltaThreshold || db > channelDeltaThreshold) {
        changedPixels++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (changedPixels === 0 || maxX < minX || maxY < minY) {
    return { changedPercent: 0, changedPixels: 0, changedBounds: null };
  }

  const changedPercent = Math.round((changedPixels / totalPixels) * 100000) / 1000;
  const scaleX = curr.logicalWidth / Math.max(1, w);
  const scaleY = curr.logicalHeight / Math.max(1, h);

  const bx = Math.round(curr.originX + minX * scaleX);
  const by = Math.round(curr.originY + minY * scaleY);
  const bw = Math.max(1, Math.round((maxX - minX + 1) * scaleX));
  const bh = Math.max(1, Math.round((maxY - minY + 1) * scaleY));

  return {
    changedPercent,
    changedPixels,
    changedBounds: { x: bx, y: by, width: bw, height: bh },
  };
}
