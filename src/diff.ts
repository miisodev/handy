import type { FrameDiff, FrameDiffOptions, Point, RawFrame } from "./types.js";

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
 * Returns a Uint32Array view over `pixelCount` RGBA pixels of `data`, or null when the buffer is
 * not 4-byte aligned (Uint32Array views require alignment). Reading whole pixels as one 32-bit
 * word lets the diff skip unchanged pixels with a single integer comparison.
 */
function asUint32View(data: Uint8Array, pixelCount: number): Uint32Array | null {
  if (pixelCount <= 0) return null;
  if (data.byteLength < pixelCount * 4) return null;
  if ((data.byteOffset & 3) !== 0) return null;
  try {
    return new Uint32Array(data.buffer, data.byteOffset, pixelCount);
  } catch {
    return null;
  }
}

/**
 * Computes a fast visual difference between two RawFrames covering the same logical screen region,
 * returning changed percentage, changed pixel count, and the global logical bounding box.
 *
 * Unchanged pixels are skipped with a single 32-bit integer comparison, which keeps a 1440p diff
 * around ~2ms (and near-instant for the mostly-static frames produced by `wait_for_*` polling).
 *
 * The third argument accepts either a legacy channel-delta number or a {@link FrameDiffOptions}
 * object. Passing `earlyExitPercent` lets `wait_for_change` stop scanning as soon as the answer is
 * known; the returned diff is then flagged `partial: true` and its values are lower bounds.
 */
export function computeFrameDiff(
  prev: RawFrame,
  curr: RawFrame,
  channelDeltaThresholdOrOptions: number | FrameDiffOptions = 14,
  maybeOptions?: FrameDiffOptions,
): FrameDiff | null {
  if (
    prev.width !== curr.width ||
    prev.height !== curr.height ||
    prev.originX !== curr.originX ||
    prev.originY !== curr.originY
  ) {
    return null;
  }

  const options: FrameDiffOptions =
    typeof channelDeltaThresholdOrOptions === "number"
      ? { channelDeltaThreshold: channelDeltaThresholdOrOptions, ...(maybeOptions ?? {}) }
      : channelDeltaThresholdOrOptions;
  const threshold = options.channelDeltaThreshold ?? 14;
  const computeBounds = options.computeBounds ?? true;

  const w = curr.width;
  const h = curr.height;
  const totalPixels = w * h;
  if (totalPixels === 0) {
    return { changedPercent: 0, changedPixels: 0, changedBounds: null };
  }

  const earlyExitPixels =
    options.earlyExitPercent !== undefined && options.earlyExitPercent > 0
      ? Math.max(1, Math.ceil((options.earlyExitPercent / 100) * totalPixels))
      : -1;

  const a = prev.data;
  const b = curr.data;
  let changedPixels = 0;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  let partial = false;

  const a32 = asUint32View(a, totalPixels);
  const b32 = asUint32View(b, totalPixels);

  if (a32 && b32) {
    // Fast path: one integer compare rejects the (usually overwhelming majority of) unchanged pixels.
    // Little-endian RGBA packs as 0xAABBGGRR, so R/G/B live in bits 0-7 / 8-15 / 16-23.
    outer: for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        const av = a32[i]!;
        const bv = b32[i]!;
        if (av === bv) continue;

        const dr = (av & 0xff) - (bv & 0xff);
        const dg = ((av >>> 8) & 0xff) - ((bv >>> 8) & 0xff);
        const db = ((av >>> 16) & 0xff) - ((bv >>> 16) & 0xff);

        if (
          dr > threshold ||
          dr < -threshold ||
          dg > threshold ||
          dg < -threshold ||
          db > threshold ||
          db < -threshold
        ) {
          changedPixels++;
          if (computeBounds) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (earlyExitPixels > 0 && changedPixels >= earlyExitPixels) {
        partial = true;
        break outer;
      }
    }
  } else {
    // Fallback for unaligned buffers.
    outer: for (let y = 0; y < h; y++) {
      const rowOff = y * w * 4;
      for (let x = 0; x < w; x++) {
        const i = rowOff + x * 4;
        const dr = Math.abs(a[i]! - b[i]!);
        const dg = Math.abs(a[i + 1]! - b[i + 1]!);
        const db = Math.abs(a[i + 2]! - b[i + 2]!);
        if (dr > threshold || dg > threshold || db > threshold) {
          changedPixels++;
          if (computeBounds) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (earlyExitPixels > 0 && changedPixels >= earlyExitPixels) {
        partial = true;
        break outer;
      }
    }
  }

  if (changedPixels === 0) {
    return { changedPercent: 0, changedPixels: 0, changedBounds: null };
  }

  const changedPercent = Math.round((changedPixels / totalPixels) * 100000) / 1000;

  let changedBounds: FrameDiff["changedBounds"] = null;
  if (computeBounds && maxX >= minX && maxY >= minY) {
    const scaleX = curr.logicalWidth / Math.max(1, w);
    const scaleY = curr.logicalHeight / Math.max(1, h);
    changedBounds = {
      x: Math.round(curr.originX + minX * scaleX),
      y: Math.round(curr.originY + minY * scaleY),
      width: Math.max(1, Math.round((maxX - minX + 1) * scaleX)),
      height: Math.max(1, Math.round((maxY - minY + 1) * scaleY)),
    };
  }

  return partial
    ? { changedPercent, changedPixels, changedBounds, partial: true }
    : { changedPercent, changedPixels, changedBounds };
}
