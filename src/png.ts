import { deflateSync, inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(typeAndData: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < typeAndData.length; i++) {
    c = (CRC_TABLE[(c ^ typeAndData[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type: string, data: Uint8Array): Buffer {
  const chunk = Buffer.allocUnsafe(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, "ascii");
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(chunk, 8);
  const crc = crc32(chunk.subarray(4, 8 + data.length));
  chunk.writeUInt32BE(crc, 8 + data.length);
  return chunk;
}

export function encodePng(
  width: number,
  height: number,
  rgba: Uint8Array,
  options: { compressionLevel?: number } = {},
): Buffer {
  if (width <= 0 || height <= 0) {
    throw new Error(`Invalid PNG dimensions: ${width}x${height}`);
  }
  const expectedLength = width * height * 4;
  if (rgba.length < expectedLength) {
    throw new Error(`RGBA buffer too small: got ${rgba.length}, expected ${expectedLength}`);
  }

  const stride = width * 4;
  const raw = Buffer.allocUnsafe((stride + 1) * height);
  // Use Sub filter (1) on rows for significantly better compression of UI flat regions & rulers
  for (let y = 0; y < height; y++) {
    const srcOffset = y * stride;
    const dstOffset = y * (stride + 1);
    raw[dstOffset] = 1; // Sub filter
    // First pixel (4 bytes) has left predictor = 0
    raw[dstOffset + 1] = rgba[srcOffset]!;
    raw[dstOffset + 2] = rgba[srcOffset + 1]!;
    raw[dstOffset + 3] = rgba[srcOffset + 2]!;
    raw[dstOffset + 4] = rgba[srcOffset + 3]!;
    for (let i = 4; i < stride; i++) {
      raw[dstOffset + 1 + i] = (rgba[srcOffset + i]! - rgba[srcOffset + i - 4]!) & 0xff;
    }
  }

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // non-interlaced

  const compressed = deflateSync(raw, { level: options.compressionLevel ?? 3 });
  const ihdrChunk = makeChunk("IHDR", ihdr);
  const idatChunk = makeChunk("IDAT", compressed);
  const iendChunk = makeChunk("IEND", new Uint8Array(0));

  return Buffer.concat([PNG_SIGNATURE, ihdrChunk, idatChunk, iendChunk]);
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePng(pngBytes: Uint8Array): { width: number; height: number; data: Uint8Array } {
  const buf = Buffer.from(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Invalid PNG signature.");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idatChunks: Buffer[] = [];

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) {
      throw new Error(`Truncated PNG chunk "${type}".`);
    }
    const chunkData = buf.subarray(dataStart, dataEnd);

    if (type === "IHDR") {
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      bitDepth = chunkData[8]!;
      colorType = chunkData[9]!;
      interlace = chunkData[12]!;
    } else if (type === "PLTE") {
      palette = chunkData;
    } else if (type === "tRNS") {
      trns = chunkData;
    } else if (type === "IDAT") {
      idatChunks.push(chunkData);
    } else if (type === "IEND") {
      break;
    }

    offset = dataEnd + 4;
  }

  if (width <= 0 || height <= 0) {
    throw new Error("PNG missing valid IHDR.");
  }
  if (interlace !== 0) {
    throw new Error("Interlaced PNG is not supported.");
  }
  if (bitDepth !== 8 && bitDepth !== 16) {
    throw new Error(`Unsupported PNG bit depth: ${bitDepth}`);
  }

  const channelsByColorType: Record<number, number> = {
    0: 1, // Grayscale
    2: 3, // RGB
    3: 1, // Indexed
    4: 2, // Grayscale + Alpha
    6: 4, // RGBA
  };
  const channels = channelsByColorType[colorType];
  if (!channels) {
    throw new Error(`Unsupported PNG color type: ${colorType}`);
  }

  const bytesPerSample = bitDepth / 8;
  const bpp = channels * bytesPerSample;
  const stride = width * bpp;

  const inflated = inflateSync(Buffer.concat(idatChunks));
  if (inflated.length < (stride + 1) * height) {
    throw new Error("Corrupt PNG IDAT stream: inflated data shorter than image dimensions.");
  }

  const unfiltered = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filterType = inflated[y * (stride + 1)]!;
    const srcRow = y * (stride + 1) + 1;
    const dstRow = y * stride;
    const prevRow = (y - 1) * stride;

    for (let x = 0; x < stride; x++) {
      const rawByte = inflated[srcRow + x]!;
      const a = x >= bpp ? unfiltered[dstRow + x - bpp]! : 0;
      const b = y > 0 ? unfiltered[prevRow + x]! : 0;
      const c = y > 0 && x >= bpp ? unfiltered[prevRow + x - bpp]! : 0;

      let val: number;
      switch (filterType) {
        case 0:
          val = rawByte;
          break;
        case 1:
          val = (rawByte + a) & 0xff;
          break;
        case 2:
          val = (rawByte + b) & 0xff;
          break;
        case 3:
          val = (rawByte + ((a + b) >>> 1)) & 0xff;
          break;
        case 4:
          val = (rawByte + paethPredictor(a, b, c)) & 0xff;
          break;
        default:
          throw new Error(`Unknown PNG filter type ${filterType} at row ${y}.`);
      }
      unfiltered[dstRow + x] = val;
    }
  }

  // Fast path: 8-bit RGBA
  if (colorType === 6 && bitDepth === 8) {
    return { width, height, data: unfiltered };
  }

  const rgba = new Uint8Array(width * height * 4);
  const pixelCount = width * height;

  if (colorType === 2 && bitDepth === 8) {
    // 8-bit RGB
    for (let i = 0; i < pixelCount; i++) {
      const s = i * 3;
      const d = i * 4;
      rgba[d] = unfiltered[s]!;
      rgba[d + 1] = unfiltered[s + 1]!;
      rgba[d + 2] = unfiltered[s + 2]!;
      rgba[d + 3] = 255;
    }
  } else if (colorType === 0 && bitDepth === 8) {
    for (let i = 0; i < pixelCount; i++) {
      const g = unfiltered[i]!;
      const d = i * 4;
      rgba[d] = g;
      rgba[d + 1] = g;
      rgba[d + 2] = g;
      rgba[d + 3] = 255;
    }
  } else if (colorType === 4 && bitDepth === 8) {
    for (let i = 0; i < pixelCount; i++) {
      const g = unfiltered[i * 2]!;
      const a = unfiltered[i * 2 + 1]!;
      const d = i * 4;
      rgba[d] = g;
      rgba[d + 1] = g;
      rgba[d + 2] = g;
      rgba[d + 3] = a;
    }
  } else if (colorType === 3 && bitDepth === 8) {
    if (!palette) throw new Error("Indexed PNG missing PLTE chunk.");
    for (let i = 0; i < pixelCount; i++) {
      const idx = unfiltered[i]!;
      const p = idx * 3;
      const d = i * 4;
      rgba[d] = palette[p] ?? 0;
      rgba[d + 1] = palette[p + 1] ?? 0;
      rgba[d + 2] = palette[p + 2] ?? 0;
      rgba[d + 3] = trns && idx < trns.length ? trns[idx]! : 255;
    }
  } else {
    // 16-bit sample conversion (take MSB)
    for (let i = 0; i < pixelCount; i++) {
      const s = i * bpp;
      const d = i * 4;
      if (colorType === 6) {
        rgba[d] = unfiltered[s]!;
        rgba[d + 1] = unfiltered[s + 2]!;
        rgba[d + 2] = unfiltered[s + 4]!;
        rgba[d + 3] = unfiltered[s + 6]!;
      } else if (colorType === 2) {
        rgba[d] = unfiltered[s]!;
        rgba[d + 1] = unfiltered[s + 2]!;
        rgba[d + 2] = unfiltered[s + 4]!;
        rgba[d + 3] = 255;
      } else if (colorType === 4) {
        const g = unfiltered[s]!;
        rgba[d] = g;
        rgba[d + 1] = g;
        rgba[d + 2] = g;
        rgba[d + 3] = unfiltered[s + 2]!;
      } else {
        const g = unfiltered[s]!;
        rgba[d] = g;
        rgba[d + 1] = g;
        rgba[d + 2] = g;
        rgba[d + 3] = 255;
      }
    }
  }

  return { width, height, data: rgba };
}

export function cropRgba(
  src: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  x: number,
  y: number,
  cropWidth: number,
  cropHeight: number,
): { width: number; height: number; data: Uint8Array; x: number; y: number } {
  const cx = Math.max(0, Math.min(srcWidth - 1, Math.round(x)));
  const cy = Math.max(0, Math.min(srcHeight - 1, Math.round(y)));
  const cw = Math.max(1, Math.min(srcWidth - cx, Math.round(cropWidth)));
  const ch = Math.max(1, Math.min(srcHeight - cy, Math.round(cropHeight)));

  if (cx === 0 && cy === 0 && cw === srcWidth && ch === srcHeight) {
    return { width: srcWidth, height: srcHeight, data: new Uint8Array(src), x: 0, y: 0 };
  }

  const out = new Uint8Array(cw * ch * 4);
  const srcStride = srcWidth * 4;
  const dstStride = cw * 4;
  for (let row = 0; row < ch; row++) {
    const srcStart = (cy + row) * srcStride + cx * 4;
    out.set(src.subarray(srcStart, srcStart + dstStride), row * dstStride);
  }
  return { width: cw, height: ch, data: out, x: cx, y: cy };
}

/**
 * Fast bilinear resizer for RGBA buffers so UI text remains legible when downscaling
 * high-DPI screens before applying crisp 1:1 coordinate rulers and mouse reticles.
 */
export function resizeRgba(
  src: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
): Uint8Array {
  if (srcWidth === dstWidth && srcHeight === dstHeight) {
    return new Uint8Array(src);
  }

  const dst = new Uint8Array(dstWidth * dstHeight * 4);
  const xRatio = srcWidth / dstWidth;
  const yRatio = srcHeight / dstHeight;

  for (let dy = 0; dy < dstHeight; dy++) {
    const sy = (dy + 0.5) * yRatio - 0.5;
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(srcHeight - 1, y0 + 1);
    const wy = Math.max(0, sy - y0);
    const wyInv = 1 - wy;

    const row0 = y0 * srcWidth * 4;
    const row1 = y1 * srcWidth * 4;
    const dstRow = dy * dstWidth * 4;

    for (let dx = 0; dx < dstWidth; dx++) {
      const sx = (dx + 0.5) * xRatio - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(srcWidth - 1, x0 + 1);
      const wx = Math.max(0, sx - x0);
      const wxInv = 1 - wx;

      const p00 = row0 + x0 * 4;
      const p10 = row0 + x1 * 4;
      const p01 = row1 + x0 * 4;
      const p11 = row1 + x1 * 4;
      const d = dstRow + dx * 4;

      const w00 = wxInv * wyInv;
      const w10 = wx * wyInv;
      const w01 = wxInv * wy;
      const w11 = wx * wy;

      dst[d] = Math.round(src[p00]! * w00 + src[p10]! * w10 + src[p01]! * w01 + src[p11]! * w11);
      dst[d + 1] = Math.round(
        src[p00 + 1]! * w00 + src[p10 + 1]! * w10 + src[p01 + 1]! * w01 + src[p11 + 1]! * w11,
      );
      dst[d + 2] = Math.round(
        src[p00 + 2]! * w00 + src[p10 + 2]! * w10 + src[p01 + 2]! * w01 + src[p11 + 2]! * w11,
      );
      dst[d + 3] = 255;
    }
  }

  return dst;
}
