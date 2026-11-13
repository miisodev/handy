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
function crc32(typeAndData) {
    let c = 0xffffffff;
    for (let i = 0; i < typeAndData.length; i++) {
        c = (CRC_TABLE[(c ^ typeAndData[i]) & 0xff] ^ (c >>> 8)) >>> 0;
    }
    return (c ^ 0xffffffff) >>> 0;
}
function makeChunk(type, data) {
    const chunk = Buffer.allocUnsafe(12 + data.length);
    chunk.writeUInt32BE(data.length, 0);
    chunk.write(type, 4, 4, "ascii");
    Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(chunk, 8);
    const crc = crc32(chunk.subarray(4, 8 + data.length));
    chunk.writeUInt32BE(crc, 8 + data.length);
    return chunk;
}
/** Returns a Uint32Array view over whole RGBA pixels, or null when `data` is not 4-byte aligned. */
function asUint32View(data, pixelCount) {
    if (pixelCount <= 0 || data.byteLength < pixelCount * 4)
        return null;
    if ((data.byteOffset & 3) !== 0)
        return null;
    try {
        return new Uint32Array(data.buffer, data.byteOffset, pixelCount);
    }
    catch {
        return null;
    }
}
export function encodePng(width, height, rgba, options = {}) {
    if (width <= 0 || height <= 0) {
        throw new Error(`Invalid PNG dimensions: ${width}x${height}`);
    }
    const expectedLength = width * height * 4;
    if (rgba.length < expectedLength) {
        throw new Error(`RGBA buffer too small: got ${rgba.length}, expected ${expectedLength}`);
    }
    const stride = width * 4;
    const raw = Buffer.allocUnsafe((stride + 1) * height);
    const strategy = options.filter ?? "auto";
    const rgba32 = strategy === "auto" ? asUint32View(rgba, width * height) : null;
    for (let y = 0; y < height; y++) {
        const srcOffset = y * stride;
        const prevOffset = srcOffset - stride;
        const dstOffset = y * (stride + 1);
        raw[dstOffset] = 0;
        if (strategy === "none") {
            raw.set(rgba.subarray(srcOffset, srcOffset + stride), dstOffset + 1);
            continue;
        }
        if (strategy === "sub") {
            raw[dstOffset] = 1; // Sub filter
            // First pixel (4 bytes) has left predictor = 0
            raw[dstOffset + 1] = rgba[srcOffset];
            raw[dstOffset + 2] = rgba[srcOffset + 1];
            raw[dstOffset + 3] = rgba[srcOffset + 2];
            raw[dstOffset + 4] = rgba[srcOffset + 3];
            for (let i = 4; i < stride; i++) {
                raw[dstOffset + 1 + i] = (rgba[srcOffset + i] - rgba[srcOffset + i - 4]) & 0xff;
            }
            continue;
        }
        if (y === 0 && strategy === "up") {
            // No previous row: Up degenerates to None.
            raw.set(rgba.subarray(srcOffset, srcOffset + stride), dstOffset + 1);
            continue;
        }
        if (strategy === "up") {
            raw[dstOffset] = 2;
            for (let i = 0; i < stride; i++) {
                raw[dstOffset + 1 + i] = (rgba[srcOffset + i] - rgba[prevOffset + i]) & 0xff;
            }
            continue;
        }
        // strategy === "auto" | "paeth"
        if (y > 0 && strategy === "auto") {
            // Identical-row shortcut: emit an all-zero Up row (extremely common in flat UI backgrounds).
            let identical = true;
            if (rgba32) {
                const row = y * width;
                const prevRow = row - width;
                for (let x = 0; x < width; x++) {
                    if (rgba32[row + x] !== rgba32[prevRow + x]) {
                        identical = false;
                        break;
                    }
                }
            }
            else {
                for (let i = 0; i < stride; i++) {
                    if (rgba[srcOffset + i] !== rgba[prevOffset + i]) {
                        identical = false;
                        break;
                    }
                }
            }
            if (identical) {
                raw[dstOffset] = 2;
                raw.fill(0, dstOffset + 1, dstOffset + 1 + stride);
                continue;
            }
        }
        raw[dstOffset] = 4; // Paeth filter
        if (y === 0) {
            // No previous row: Paeth degenerates to Sub (predictor is the left pixel).
            raw[dstOffset + 1] = rgba[srcOffset];
            raw[dstOffset + 2] = rgba[srcOffset + 1];
            raw[dstOffset + 3] = rgba[srcOffset + 2];
            raw[dstOffset + 4] = rgba[srcOffset + 3];
            for (let i = 4; i < stride; i++) {
                raw[dstOffset + 1 + i] = (rgba[srcOffset + i] - rgba[srcOffset + i - 4]) & 0xff;
            }
            continue;
        }
        // First pixel of the row: a = c = 0, so Paeth picks b (the Up predictor).
        raw[dstOffset + 1] = (rgba[srcOffset] - rgba[prevOffset]) & 0xff;
        raw[dstOffset + 2] = (rgba[srcOffset + 1] - rgba[prevOffset + 1]) & 0xff;
        raw[dstOffset + 3] = (rgba[srcOffset + 2] - rgba[prevOffset + 2]) & 0xff;
        raw[dstOffset + 4] = (rgba[srcOffset + 3] - rgba[prevOffset + 3]) & 0xff;
        for (let i = 4; i < stride; i++) {
            const x = rgba[srcOffset + i];
            const a = rgba[srcOffset + i - 4];
            const b = rgba[prevOffset + i];
            const c = rgba[prevOffset + i - 4];
            // Paeth distances simplified: pa = |b - c|, pb = |a - c|, pc = |a + b - 2c|
            const pa = b > c ? b - c : c - b;
            const pb = a > c ? a - c : c - a;
            const ab = a + b - c;
            const pc = ab > c ? ab - c : c - ab;
            const predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            raw[dstOffset + 1 + i] = (x - predictor) & 0xff;
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
function paethPredictor(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc)
        return a;
    if (pb <= pc)
        return b;
    return c;
}
export function decodePng(pngBytes) {
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
    let palette = null;
    let trns = null;
    const idatChunks = [];
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
            bitDepth = chunkData[8];
            colorType = chunkData[9];
            interlace = chunkData[12];
        }
        else if (type === "PLTE") {
            palette = chunkData;
        }
        else if (type === "tRNS") {
            trns = chunkData;
        }
        else if (type === "IDAT") {
            idatChunks.push(chunkData);
        }
        else if (type === "IEND") {
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
    const channelsByColorType = {
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
        const filterType = inflated[y * (stride + 1)];
        const srcRow = y * (stride + 1) + 1;
        const dstRow = y * stride;
        const prevRow = (y - 1) * stride;
        for (let x = 0; x < stride; x++) {
            const rawByte = inflated[srcRow + x];
            const a = x >= bpp ? unfiltered[dstRow + x - bpp] : 0;
            const b = y > 0 ? unfiltered[prevRow + x] : 0;
            const c = y > 0 && x >= bpp ? unfiltered[prevRow + x - bpp] : 0;
            let val;
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
            rgba[d] = unfiltered[s];
            rgba[d + 1] = unfiltered[s + 1];
            rgba[d + 2] = unfiltered[s + 2];
            rgba[d + 3] = 255;
        }
    }
    else if (colorType === 0 && bitDepth === 8) {
        for (let i = 0; i < pixelCount; i++) {
            const g = unfiltered[i];
            const d = i * 4;
            rgba[d] = g;
            rgba[d + 1] = g;
            rgba[d + 2] = g;
            rgba[d + 3] = 255;
        }
    }
    else if (colorType === 4 && bitDepth === 8) {
        for (let i = 0; i < pixelCount; i++) {
            const g = unfiltered[i * 2];
            const a = unfiltered[i * 2 + 1];
            const d = i * 4;
            rgba[d] = g;
            rgba[d + 1] = g;
            rgba[d + 2] = g;
            rgba[d + 3] = a;
        }
    }
    else if (colorType === 3 && bitDepth === 8) {
        if (!palette)
            throw new Error("Indexed PNG missing PLTE chunk.");
        for (let i = 0; i < pixelCount; i++) {
            const idx = unfiltered[i];
            const p = idx * 3;
            const d = i * 4;
            rgba[d] = palette[p] ?? 0;
            rgba[d + 1] = palette[p + 1] ?? 0;
            rgba[d + 2] = palette[p + 2] ?? 0;
            rgba[d + 3] = trns && idx < trns.length ? trns[idx] : 255;
        }
    }
    else {
        // 16-bit sample conversion (take MSB)
        for (let i = 0; i < pixelCount; i++) {
            const s = i * bpp;
            const d = i * 4;
            if (colorType === 6) {
                rgba[d] = unfiltered[s];
                rgba[d + 1] = unfiltered[s + 2];
                rgba[d + 2] = unfiltered[s + 4];
                rgba[d + 3] = unfiltered[s + 6];
            }
            else if (colorType === 2) {
                rgba[d] = unfiltered[s];
                rgba[d + 1] = unfiltered[s + 2];
                rgba[d + 2] = unfiltered[s + 4];
                rgba[d + 3] = 255;
            }
            else if (colorType === 4) {
                const g = unfiltered[s];
                rgba[d] = g;
                rgba[d + 1] = g;
                rgba[d + 2] = g;
                rgba[d + 3] = unfiltered[s + 2];
            }
            else {
                const g = unfiltered[s];
                rgba[d] = g;
                rgba[d + 1] = g;
                rgba[d + 2] = g;
                rgba[d + 3] = 255;
            }
        }
    }
    return { width, height, data: rgba };
}
export function cropRgba(src, srcWidth, srcHeight, x, y, cropWidth, cropHeight) {
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
 * Precomputes, for every destination sample, the source samples that overlap it and their
 * fractional coverage weights. Total span length is bounded by `srcSize + dstSize`.
 */
function buildSpanTable(srcSize, dstSize) {
    const ratio = srcSize / dstSize;
    const starts = new Int32Array(dstSize);
    const ends = new Int32Array(dstSize);
    const sums = new Float64Array(dstSize);
    const indices = new Int32Array(srcSize + dstSize + 1);
    const weights = new Float64Array(srcSize + dstSize + 1);
    let p = 0;
    for (let d = 0; d < dstSize; d++) {
        const s0 = d * ratio;
        const s1 = (d + 1) * ratio;
        const i0 = Math.max(0, Math.min(srcSize - 1, Math.floor(s0)));
        let i1 = Math.max(i0 + 1, Math.min(srcSize, Math.ceil(s1)));
        starts[d] = p;
        let wsum = 0;
        for (let s = i0; s < i1; s++) {
            const w = Math.min(s1, s + 1) - Math.max(s0, s);
            indices[p] = s;
            weights[p] = w > 0 ? w : 0;
            wsum += weights[p];
            p++;
        }
        ends[d] = p;
        sums[d] = wsum > 0 ? wsum : 1;
    }
    return { starts, ends, indices, weights, sums };
}
/**
 * Area-average (box) downscale specialised for integer ratios (2x, 3x, ...), which covers the
 * dominant real-world cases: halving a HiDPI capture to `maxWidth`, or a 4K screen to 1080p.
 * Avoids all span-table indirection so it runs at raw memory speed.
 */
function resizeRgbaBoxInteger(src, srcWidth, srcHeight, dstWidth, dstHeight, kx, ky) {
    const dst = new Uint8Array(dstWidth * dstHeight * 4);
    const inv = 1 / (kx * ky);
    const srcStride = srcWidth * 4;
    // Fully unrolled 2x2 box: the single most common downscale (HiDPI -> maxWidth).
    if (kx === 2 && ky === 2) {
        for (let dy = 0; dy < dstHeight; dy++) {
            const r0 = dy * 2 * srcStride;
            const r1 = r0 + srcStride;
            const out = dy * dstWidth * 4;
            for (let dx = 0; dx < dstWidth; dx++) {
                const a = r0 + dx * 8;
                const b = r1 + dx * 8;
                const o = out + dx * 4;
                dst[o] = (src[a] + src[a + 4] + src[b] + src[b + 4]) >> 2;
                dst[o + 1] = (src[a + 1] + src[a + 5] + src[b + 1] + src[b + 5]) >> 2;
                dst[o + 2] = (src[a + 2] + src[a + 6] + src[b + 2] + src[b + 6]) >> 2;
                dst[o + 3] = 255;
            }
        }
        return dst;
    }
    for (let dy = 0; dy < dstHeight; dy++) {
        const sy0 = dy * ky;
        const out = dy * dstWidth * 4;
        for (let dx = 0; dx < dstWidth; dx++) {
            const sx0 = dx * kx * 4;
            let r = 0;
            let g = 0;
            let b = 0;
            for (let j = 0; j < ky; j++) {
                const base = (sy0 + j) * srcStride + sx0;
                for (let i = 0; i < kx; i++) {
                    const p = base + i * 4;
                    r += src[p];
                    g += src[p + 1];
                    b += src[p + 2];
                }
            }
            const o = out + dx * 4;
            dst[o] = (r * inv + 0.5) | 0;
            dst[o + 1] = (g * inv + 0.5) | 0;
            dst[o + 2] = (b * inv + 0.5) | 0;
            dst[o + 3] = 255;
        }
    }
    return dst;
}
/**
 * Area-average (box) downscale. Every source pixel contributes to the destination pixels it
 * actually overlaps, weighted by coverage, so thin UI text stays legible instead of aliasing.
 */
function resizeRgbaBox(src, srcWidth, srcHeight, dstWidth, dstHeight) {
    const xRatio = srcWidth / dstWidth;
    const yRatio = srcHeight / dstHeight;
    if (Number.isInteger(xRatio) && Number.isInteger(yRatio) && xRatio >= 1 && yRatio >= 1) {
        return resizeRgbaBoxInteger(src, srcWidth, srcHeight, dstWidth, dstHeight, xRatio, yRatio);
    }
    const cols = buildSpanTable(srcWidth, dstWidth);
    const rows = buildSpanTable(srcHeight, dstHeight);
    const srcStride = srcWidth * 4;
    const dst = new Uint8Array(dstWidth * dstHeight * 4);
    // Pre-scale column byte offsets and normalisation factors so the inner loop is pure arithmetic.
    const colStart = cols.starts;
    const colEnd = cols.ends;
    const colOffset = new Int32Array(cols.indices.length);
    for (let cp = 0; cp < cols.indices.length; cp++) {
        colOffset[cp] = cols.indices[cp] * 4;
    }
    const colNorm = new Float64Array(dstWidth);
    for (let dx = 0; dx < dstWidth; dx++) {
        colNorm[dx] = 1 / cols.sums[dx];
    }
    for (let dy = 0; dy < dstHeight; dy++) {
        const rowStart = rows.starts[dy];
        const rowEnd = rows.ends[dy];
        const rowNorm = 1 / rows.sums[dy];
        const out = dy * dstWidth * 4;
        for (let dx = 0; dx < dstWidth; dx++) {
            const cs = colStart[dx];
            const ce = colEnd[dx];
            const n = colNorm[dx] * rowNorm;
            let r = 0;
            let g = 0;
            let b = 0;
            for (let rp = rowStart; rp < rowEnd; rp++) {
                const wy = rows.weights[rp];
                if (wy === 0)
                    continue;
                const srcRow = rows.indices[rp] * srcStride;
                for (let cp = cs; cp < ce; cp++) {
                    const w = cols.weights[cp] * wy;
                    const i = srcRow + colOffset[cp];
                    r += src[i] * w;
                    g += src[i + 1] * w;
                    b += src[i + 2] * w;
                }
            }
            // A coverage-weighted average of 0..255 samples cannot leave that range, so no clamping is
            // needed and rounding is a plain truncate-after-bias (much cheaper than Math.round).
            const o = out + dx * 4;
            dst[o] = (r * n + 0.5) | 0;
            dst[o + 1] = (g * n + 0.5) | 0;
            dst[o + 2] = (b * n + 0.5) | 0;
            dst[o + 3] = 255;
        }
    }
    return dst;
}
/**
 * Bilinear resizer, used for upscaling (where box filtering would just replicate pixels) and as an
 * explicit opt-in via `{ filter: "bilinear" }`.
 */
function resizeRgbaBilinear(src, srcWidth, srcHeight, dstWidth, dstHeight) {
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
            dst[d] = Math.round(src[p00] * w00 + src[p10] * w10 + src[p01] * w01 + src[p11] * w11);
            dst[d + 1] = Math.round(src[p00 + 1] * w00 + src[p10 + 1] * w10 + src[p01 + 1] * w01 + src[p11 + 1] * w11);
            dst[d + 2] = Math.round(src[p00 + 2] * w00 + src[p10 + 2] * w10 + src[p01 + 2] * w01 + src[p11 + 2] * w11);
            dst[d + 3] = 255;
        }
    }
    return dst;
}
/**
 * Resizes an RGBA buffer.
 *
 * `auto` (default) picks an area-average box filter when downscaling — the right choice for screen
 * captures, because it averages every covered source pixel instead of sampling only four of them.
 * That keeps small UI text legible (and coordinate rulers crisp) where bilinear produces moiré and
 * dropped strokes. Bilinear is used when upscaling.
 */
export function resizeRgba(src, srcWidth, srcHeight, dstWidth, dstHeight, options = {}) {
    if (srcWidth === dstWidth && srcHeight === dstHeight) {
        return new Uint8Array(src);
    }
    if (dstWidth <= 0 || dstHeight <= 0 || srcWidth <= 0 || srcHeight <= 0) {
        throw new Error(`Invalid resize dimensions: ${srcWidth}x${srcHeight} -> ${dstWidth}x${dstHeight}`);
    }
    const filter = options.filter ?? "auto";
    const downscaling = dstWidth <= srcWidth && dstHeight <= srcHeight;
    if (filter === "box" || (filter === "auto" && downscaling)) {
        return resizeRgbaBox(src, srcWidth, srcHeight, dstWidth, dstHeight);
    }
    return resizeRgbaBilinear(src, srcWidth, srcHeight, dstWidth, dstHeight);
}
