import { cropRgba, resizeRgba } from "./png.js";
/**
 * Set-of-Mark style UI element detection.
 *
 * Rather than asking a vision model to guess pixel coordinates from a downscaled screenshot, Handy
 * segments the frame into candidate interactive elements (buttons, fields, icons, links, panels),
 * numbers them on the overlay, and returns their exact screen bounds. The agent can then act on a
 * verified box — or click it directly by `mark` index — which is far more reliable than
 * coordinate eyeballing.
 *
 * The pipeline is pure TypeScript and dependency-free:
 *
 *   grayscale -> gradient -> threshold -> dilate -> connected components
 *             -> per-box signals -> score -> merge words into lines -> rank
 *
 * Detection runs on a bounded working copy of the frame, so cost stays flat regardless of DPI, and
 * every returned coordinate is mapped back into the frame's global logical screen space.
 */
/** Frames up to this many pixels are analysed at 1:1; larger ones are area-averaged down to it. */
const MAX_WORK_PIXELS = 2_400_000;
/**
 * Above this fraction of edge pixels the content is photographic/noise rather than UI, so detection
 * returns nothing instead of spending unbounded time on meaningless components.
 */
const MAX_EDGE_DENSITY = 0.35;
class DisjointSet {
    parent;
    constructor(size) {
        this.parent = new Int32Array(size);
        for (let i = 0; i < size; i++)
            this.parent[i] = i;
    }
    find(x) {
        let root = x;
        while (this.parent[root] !== root)
            root = this.parent[root];
        let cur = x;
        while (this.parent[cur] !== root) {
            const next = this.parent[cur];
            this.parent[cur] = root;
            cur = next;
        }
        return root;
    }
    union(a, b) {
        const ra = this.find(a);
        const rb = this.find(b);
        if (ra !== rb)
            this.parent[rb] = ra;
    }
}
/** Luminance (integer Rec. 601 approximation) of an RGBA buffer. */
function toGrayscale(rgba, count) {
    const gray = new Uint8Array(count);
    for (let i = 0, p = 0; i < count; i++, p += 4) {
        gray[i] = (rgba[p] * 77 + rgba[p + 1] * 151 + rgba[p + 2] * 28) >> 8;
    }
    return gray;
}
/**
 * Binary edge map from a cheap 2-tap |dx| + |dy| gradient — sufficient for crisp UI borders and
 * considerably faster than a full Sobel. Also returns the edge-pixel count so callers can size
 * downstream buffers exactly.
 */
function buildEdgeMap(gray, width, height, threshold) {
    const edge = new Uint8Array(width * height);
    let count = 0;
    for (let y = 0; y < height - 1; y++) {
        const row = y * width;
        for (let x = 0; x < width - 1; x++) {
            const i = row + x;
            const c = gray[i];
            if (Math.abs(c - gray[i + 1]) + Math.abs(c - gray[i + width]) >= threshold) {
                edge[i] = 1;
                count++;
            }
        }
    }
    return { edge, count };
}
/**
 * Separable box dilation of a binary map (radius r => (2r+1)x(2r+1) structuring element).
 *
 * The vertical pass ORs whole rows together rather than walking columns, which keeps every access
 * sequential; when the row length is a multiple of four it ORs 32 bits at a time (byte lanes hold
 * independent 0/1 flags, so they cannot interfere). Set-pixel positions are collected during the
 * same pass so labelling never has to rescan the image.
 */
function dilate(edge, edgeCount, width, height, radius) {
    if (radius <= 0) {
        const positions = new Int32Array(edgeCount);
        let n = 0;
        for (let i = 0; i < edge.length; i++)
            if (edge[i] === 1)
                positions[n++] = i;
        return { map: edge, positions, count: n };
    }
    const total = width * height;
    const tmp = new Uint8Array(total);
    // Horizontal pass: grow each set pixel by `radius` along its row.
    for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 0; x < width; x++) {
            if (edge[row + x] !== 1)
                continue;
            const from = x - radius < 0 ? 0 : x - radius;
            const to = x + radius > width - 1 ? width : x + radius + 1;
            tmp.fill(1, row + from, row + to);
        }
    }
    const map = new Uint8Array(total);
    const useWords = width % 4 === 0 && (tmp.byteOffset & 3) === 0;
    if (useWords) {
        const tmp32 = new Uint32Array(tmp.buffer);
        const map32 = new Uint32Array(map.buffer);
        const w32 = width >> 2;
        for (let y = 0; y < height; y++) {
            const dst = y * w32;
            map32.set(tmp32.subarray(dst, dst + w32), dst);
            for (let k = 1; k <= radius; k++) {
                if (y - k >= 0) {
                    const src = (y - k) * w32;
                    for (let x = 0; x < w32; x++)
                        map32[dst + x] = map32[dst + x] | tmp32[src + x];
                }
                if (y + k < height) {
                    const src = (y + k) * w32;
                    for (let x = 0; x < w32; x++)
                        map32[dst + x] = map32[dst + x] | tmp32[src + x];
                }
            }
        }
    }
    else {
        for (let y = 0; y < height; y++) {
            const dst = y * width;
            map.set(tmp.subarray(dst, dst + width), dst);
            for (let k = 1; k <= radius; k++) {
                if (y - k >= 0) {
                    const src = (y - k) * width;
                    for (let x = 0; x < width; x++)
                        if (tmp[src + x] === 1)
                            map[dst + x] = 1;
                }
                if (y + k < height) {
                    const src = (y + k) * width;
                    for (let x = 0; x < width; x++)
                        if (tmp[src + x] === 1)
                            map[dst + x] = 1;
                }
            }
        }
    }
    // Collect set positions while the map is still hot in cache.
    let count = 0;
    for (let i = 0; i < total; i++)
        if (map[i] === 1)
            count++;
    const positions = new Int32Array(count);
    let n = 0;
    for (let i = 0; i < total; i++)
        if (map[i] === 1)
            positions[n++] = i;
    return { map, positions, count };
}
/**
 * Two-pass connected-component labelling (8-connectivity).
 *
 * Pass 2 walks only the recorded edge-pixel positions instead of the whole image, and accumulates
 * into flat per-root arrays rather than a Map — this keeps labelling linear in the number of edge
 * pixels, which is typically a few percent of the frame.
 */
function labelComponents(map, positions, positionCount, width, height) {
    if (positionCount === 0)
        return [];
    const labels = new Int32Array(width * height).fill(-1);
    const equivalences = [];
    let nextLabel = 0;
    for (let p = 0; p < positionCount; p++) {
        const i = positions[p];
        const x = i % width;
        const y = (i / width) | 0;
        let best = -1;
        if (x > 0) {
            const l = labels[i - 1];
            if (l >= 0)
                best = l;
        }
        if (y > 0) {
            const up = labels[i - width];
            if (up >= 0) {
                if (best < 0)
                    best = up;
                else if (up !== best)
                    equivalences.push([best, up]);
            }
            if (x > 0) {
                const ul = labels[i - width - 1];
                if (ul >= 0) {
                    if (best < 0)
                        best = ul;
                    else if (ul !== best)
                        equivalences.push([best, ul]);
                }
            }
            if (x < width - 1) {
                const ur = labels[i - width + 1];
                if (ur >= 0) {
                    if (best < 0)
                        best = ur;
                    else if (ur !== best)
                        equivalences.push([best, ur]);
                }
            }
        }
        labels[i] = best < 0 ? nextLabel++ : best;
    }
    if (nextLabel === 0)
        return [];
    const dsu = new DisjointSet(nextLabel);
    for (const [a, b] of equivalences)
        dsu.union(a, b);
    const minX = new Int32Array(nextLabel).fill(width);
    const minY = new Int32Array(nextLabel).fill(height);
    const maxX = new Int32Array(nextLabel).fill(-1);
    const maxY = new Int32Array(nextLabel).fill(-1);
    const count = new Int32Array(nextLabel);
    for (let p = 0; p < positionCount; p++) {
        const i = positions[p];
        const r = dsu.find(labels[i]);
        const x = i % width;
        const y = (i / width) | 0;
        count[r] = count[r] + 1;
        if (x < minX[r])
            minX[r] = x;
        if (x > maxX[r])
            maxX[r] = x;
        if (y < minY[r])
            minY[r] = y;
        if (y > maxY[r])
            maxY[r] = y;
    }
    const out = [];
    for (let r = 0; r < nextLabel; r++) {
        if (count[r] === 0 || maxX[r] < 0)
            continue;
        out.push({ minX: minX[r], minY: minY[r], maxX: maxX[r], maxY: maxY[r], pixels: count[r] });
    }
    return out;
}
/** Fraction of a bounding box's perimeter that is edge pixels (rectangularity signal). */
function perimeterEdgeDensity(edge, width, s) {
    let hits = 0;
    let total = 0;
    for (let x = s.minX; x <= s.maxX; x++) {
        total += 2;
        if (edge[s.minY * width + x] === 1)
            hits++;
        if (edge[s.maxY * width + x] === 1)
            hits++;
    }
    for (let y = s.minY + 1; y < s.maxY; y++) {
        total += 2;
        if (edge[y * width + s.minX] === 1)
            hits++;
        if (edge[y * width + s.maxX] === 1)
            hits++;
    }
    return total === 0 ? 0 : hits / total;
}
/** Mean/stddev of luminance inside a box, optionally inset by `pad` pixels. */
function boxLuminance(gray, width, height, x0, y0, x1, y1) {
    const xa = Math.max(0, x0);
    const ya = Math.max(0, y0);
    const xb = Math.min(width - 1, x1);
    const yb = Math.min(height - 1, y1);
    if (xb < xa || yb < ya)
        return { mean: 0, stddev: 0 };
    let sum = 0;
    let sumSq = 0;
    let n = 0;
    for (let y = ya; y <= yb; y++) {
        const row = y * width;
        for (let x = xa; x <= xb; x++) {
            const v = gray[row + x];
            sum += v;
            sumSq += v * v;
            n++;
        }
    }
    if (n === 0)
        return { mean: 0, stddev: 0 };
    const mean = sum / n;
    return { mean, stddev: Math.sqrt(Math.max(0, sumSq / n - mean * mean)) };
}
/**
 * Mean luminance of a 1-2px ring immediately outside the box. Comparing this with the interior mean
 * is the strongest single signal that a box is a *filled* element (button, chip, field) sitting on a
 * different background, rather than an arbitrary patch of content.
 */
function surroundLuminance(gray, width, height, s) {
    const pad = 3;
    const x0 = Math.max(0, s.minX - pad);
    const x1 = Math.min(width - 1, s.maxX + pad);
    const y0 = Math.max(0, s.minY - pad);
    const y1 = Math.min(height - 1, s.maxY + pad);
    const ix0 = Math.max(0, s.minX);
    const ix1 = Math.min(width - 1, s.maxX);
    const iy0 = Math.max(0, s.minY);
    const iy1 = Math.min(height - 1, s.maxY);
    if (x1 <= x0 || y1 <= y0)
        return null;
    let sum = 0;
    let n = 0;
    const accumulateSpan = (y, from, to) => {
        if (y < 0 || y >= height || to < from)
            return;
        const row = y * width;
        for (let x = from; x <= to; x++) {
            sum += gray[row + x];
            n++;
        }
    };
    // Top and bottom bands spanning the full padded width.
    for (let y = y0; y < iy0; y++)
        accumulateSpan(y, x0, x1);
    for (let y = iy1 + 1; y <= y1; y++)
        accumulateSpan(y, x0, x1);
    // Left and right bands for the interior rows only (corners already covered above).
    for (let y = iy0; y <= iy1; y++) {
        accumulateSpan(y, x0, ix0 - 1);
        accumulateSpan(y, ix1 + 1, x1);
    }
    return n === 0 ? null : sum / n;
}
function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}
/**
 * Classifies a detected component by shape.
 *
 * Height is the primary control/region discriminator, not interior variance. Buttons, fields,
 * chips, and menu items are short; panels, cards, and windows are tall containers. An interior
 * stddev gate gets this wrong on the most common button style in modern UIs — a gradient-filled
 * CTA carrying a white label has a bimodal, high-variance interior, exactly like a panel full of
 * text, so `stddev < 70 ? "control" : "region"` misfiled those as regions and cost the agent the
 * signal that the thing was clickable.
 */
function classifyKind(widthLogical, heightLogical, solidity, stddev) {
    const aspect = widthLogical / Math.max(1, heightLogical);
    const area = widthLogical * heightLogical;
    if (heightLogical <= 28 && aspect >= 2.0)
        return "text";
    if (widthLogical <= 60 && heightLogical <= 60 && aspect >= 0.5 && aspect <= 2)
        return "icon";
    if (heightLogical <= 120 && area <= 90_000)
        return "control";
    // Ambiguous band: a calm, densely filled interior still reads as an oversized control (a tile
    // or hero button), whereas a sparse or busy one is a container holding other elements.
    if (heightLogical <= 200 && solidity >= 0.75 && stddev < 45)
        return "control";
    return "region";
}
function intersectionOverUnion(a, b) {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.width, b.x + b.width);
    const y2 = Math.min(a.y + a.height, b.y + b.height);
    if (x2 <= x1 || y2 <= y1)
        return 0;
    const inter = (x2 - x1) * (y2 - y1);
    const union = a.width * a.height + b.width * b.height - inter;
    return union <= 0 ? 0 : inter / union;
}
/** Fraction (0..1) of `inner`'s area that lies inside `outer`. Unlike IoU this stays high when a
 * small box sits wholly inside a much larger one, which is exactly the label-in-a-button case. */
function containmentRatio(inner, outer) {
    const x1 = Math.max(inner.x, outer.x);
    const y1 = Math.max(inner.y, outer.y);
    const x2 = Math.min(inner.x + inner.width, outer.x + outer.width);
    const y2 = Math.min(inner.y + inner.height, outer.y + outer.height);
    if (x2 <= x1 || y2 <= y1)
        return 0;
    const area = inner.width * inner.height;
    return area <= 0 ? 0 : ((x2 - x1) * (y2 - y1)) / area;
}
/** True when the two boxes are essentially the same element detected at two tightness levels. */
function sameElement(a, b) {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.width, b.x + b.width);
    const y2 = Math.min(a.y + a.height, b.y + b.height);
    if (x2 <= x1 || y2 <= y1)
        return false;
    const inter = (x2 - x1) * (y2 - y1);
    return inter / Math.max(1, a.width * a.height) > 0.8 && inter / Math.max(1, b.width * b.height) > 0.8;
}
/**
 * Merges short components that share a baseline into single text lines. Individual words are noise
 * for an agent (and would exhaust the mark budget); a line is a meaningful, clickable target.
 *
 * Items are pre-sorted by `minY` so the inner scan can break as soon as a candidate starts below
 * the current box, keeping this near-linear instead of quadratic on text-heavy screens.
 */
function mergeTextLines(items, width) {
    const maxHeight = Math.max(6, Math.round(width * 0.03));
    const textIndices = [];
    for (let i = 0; i < items.length; i++) {
        const s = items[i];
        const h = s.maxY - s.minY + 1;
        const w = s.maxX - s.minX + 1;
        if (h <= maxHeight && w / h >= 0.3)
            textIndices.push(i);
    }
    if (textIndices.length < 2)
        return items;
    const textLike = textIndices.map((i) => items[i]);
    const order = textLike
        .map((s, i) => i)
        .sort((a, b) => textLike[a].minY - textLike[b].minY || textLike[a].minX - textLike[b].minX);
    const sorted = order.map((i) => textLike[i]);
    const isText = new Set(textIndices);
    const used = new Uint8Array(sorted.length);
    const merged = [];
    for (let si = 0; si < sorted.length; si++) {
        if (used[si] === 1)
            continue;
        used[si] = 1;
        const seed = sorted[si];
        let box = { ...seed };
        let grew = true;
        while (grew) {
            grew = false;
            const boxH = box.maxY - box.minY + 1;
            const gapLimit = Math.max(3, Math.round(boxH * 0.9));
            const yTolerance = Math.max(2, Math.round(boxH * 0.6));
            for (let oi = si + 1; oi < sorted.length; oi++) {
                if (used[oi] === 1)
                    continue;
                const other = sorted[oi];
                if (other.minY > box.maxY + yTolerance)
                    break;
                const otherH = other.maxY - other.minY + 1;
                const vertOverlap = Math.min(box.maxY, other.maxY) - Math.max(box.minY, other.minY) + 1;
                if (vertOverlap < Math.min(boxH, otherH) * 0.55)
                    continue;
                const gap = other.minX > box.maxX ? other.minX - box.maxX : box.minX > other.maxX ? box.minX - other.maxX : 0;
                if (gap > gapLimit)
                    continue;
                box = {
                    minX: Math.min(box.minX, other.minX),
                    minY: Math.min(box.minY, other.minY),
                    maxX: Math.max(box.maxX, other.maxX),
                    maxY: Math.max(box.maxY, other.maxY),
                    pixels: box.pixels + other.pixels,
                };
                used[oi] = 1;
                grew = true;
            }
        }
        merged.push(box);
    }
    const rest = [];
    for (let i = 0; i < items.length; i++) {
        if (!isText.has(i))
            rest.push(items[i]);
    }
    return [...rest, ...merged];
}
/**
 * Picks the working resolution for detection. An exact integer divisor is preferred whenever one
 * fits the pixel budget, because that routes the downscale through the resizer's unrolled fast path.
 */
function chooseWorkSize(cropW, cropH) {
    if (cropW * cropH <= MAX_WORK_PIXELS)
        return { width: cropW, height: cropH };
    for (let k = 2; k <= 8; k++) {
        if (cropW % k === 0 && cropH % k === 0 && (cropW / k) * (cropH / k) <= MAX_WORK_PIXELS) {
            return { width: cropW / k, height: cropH / k };
        }
    }
    const s = Math.sqrt(MAX_WORK_PIXELS / (cropW * cropH));
    return { width: Math.max(8, Math.round(cropW * s)), height: Math.max(8, Math.round(cropH * s)) };
}
/**
 * Detects candidate interactive UI elements in a captured frame.
 *
 * Bounds and centres are expressed in the frame's **global logical screen coordinate space**, so
 * they can be handed straight to `handy_act` even when the frame came from a window/region zoom or
 * a HiDPI display.
 */
export function detectUiElements(frame, options = {}) {
    const maxMarks = Math.max(1, Math.min(200, options.maxMarks ?? 40));
    const minArea = Math.max(1, options.minArea ?? 144);
    const maxAreaFraction = Math.min(1, Math.max(0.02, options.maxAreaFraction ?? 0.55));
    const minScore = Math.min(1, Math.max(0, options.minScore ?? 0.3));
    const edgeThreshold = Math.max(2, Math.min(255, options.edgeThreshold ?? 30));
    const dilateRadius = Math.max(0, Math.min(6, options.dilateRadius ?? 2));
    const mergeText = options.mergeTextLines ?? true;
    const kindFilter = options.kinds && options.kinds.length > 0 ? new Set(options.kinds) : null;
    if (frame.width <= 0 || frame.height <= 0 || frame.data.length < frame.width * frame.height * 4) {
        return [];
    }
    // --- Bounded working copy of the frame -------------------------------------------------------
    const sr = options.searchRegion;
    let cropX = 0;
    let cropY = 0;
    let cropW = frame.width;
    let cropH = frame.height;
    if (sr) {
        cropX = Math.max(0, Math.min(frame.width - 1, Math.round(sr.x)));
        cropY = Math.max(0, Math.min(frame.height - 1, Math.round(sr.y)));
        cropW = Math.max(1, Math.min(frame.width - cropX, Math.round(sr.width)));
        cropH = Math.max(1, Math.min(frame.height - cropY, Math.round(sr.height)));
    }
    const cropped = cropW === frame.width && cropH === frame.height
        ? null
        : cropRgba(frame.data, frame.width, frame.height, cropX, cropY, cropW, cropH);
    const srcRgba = cropped ? cropped.data : frame.data;
    const srcW = cropped ? cropped.width : frame.width;
    const srcH = cropped ? cropped.height : frame.height;
    cropX = cropped ? cropped.x : cropX;
    cropY = cropped ? cropped.y : cropY;
    const target = chooseWorkSize(srcW, srcH);
    const workW = target.width;
    const workH = target.height;
    const work = workW === srcW && workH === srcH ? srcRgba : resizeRgba(srcRgba, srcW, srcH, workW, workH);
    const gray = toGrayscale(work, workW * workH);
    const { edge, count } = buildEdgeMap(gray, workW, workH, edgeThreshold);
    // Safety valve: photographic or heavily dithered content puts almost every pixel on an edge. That
    // yields neither useful elements nor a bounded runtime, so bail out instead of churning.
    const workPixels = workW * workH;
    if (count > workPixels * MAX_EDGE_DENSITY)
        return [];
    const grown = dilate(edge, count, workW, workH, dilateRadius);
    let components = labelComponents(grown.map, grown.positions, grown.count, workW, workH);
    if (components.length === 0)
        return [];
    if (mergeText)
        components = mergeTextLines(components, workW);
    // Working pixel -> global logical screen coordinate mapping.
    const pxToLogicalX = (wx) => frame.originX + ((cropX + wx * (srcW / workW)) / Math.max(1, frame.width)) * frame.logicalWidth;
    const pxToLogicalY = (wy) => frame.originY + ((cropY + wy * (srcH / workH)) / Math.max(1, frame.height)) * frame.logicalHeight;
    const frameLogicalArea = Math.max(1, frame.logicalWidth * frame.logicalHeight);
    const candidates = [];
    for (const s of components) {
        const bw = s.maxX - s.minX + 1;
        const bh = s.maxY - s.minY + 1;
        if (bw < 4 || bh < 4)
            continue;
        const lx = pxToLogicalX(s.minX);
        const ly = pxToLogicalY(s.minY);
        const lw = Math.max(1, pxToLogicalX(s.maxX + 1) - lx);
        const lh = Math.max(1, pxToLogicalY(s.maxY + 1) - ly);
        const logicalArea = lw * lh;
        if (logicalArea < minArea || logicalArea > frameLogicalArea * maxAreaFraction)
            continue;
        const aspect = lw / lh;
        if (aspect > 24 || aspect < 1 / 24)
            continue;
        const solidity = clamp01(s.pixels / (bw * bh));
        const rect = perimeterEdgeDensity(grown.map, workW, s);
        const inner = boxLuminance(gray, workW, workH, s.minX + 2, s.minY + 2, s.maxX - 2, s.maxY - 2);
        const surround = surroundLuminance(gray, workW, workH, s);
        // A filled element reads as: crisp rectangular outline + calm interior + a fill colour that
        // differs from whatever surrounds it.
        const rectScore = clamp01(rect * 1.3);
        const solidityScore = clamp01(solidity * 1.5);
        const flatnessScore = clamp01(1 - inner.stddev / 85);
        const contrastScore = surround === null ? 0 : clamp01(Math.abs(inner.mean - surround) / 70);
        const aspectScore = aspect >= 0.8 && aspect <= 8
            ? 1
            : aspect > 8
                ? clamp01(1 - (aspect - 8) / 16)
                : clamp01(aspect / 0.8);
        const heightScore = lh >= 14 && lh <= 110 ? 1 : lh < 14 ? clamp01(lh / 14) : clamp01(1 - (lh - 110) / 400);
        const areaScore = logicalArea >= 600 && logicalArea <= 60_000
            ? 1
            : logicalArea < 600
                ? clamp01(logicalArea / 600)
                : clamp01(1 - (logicalArea - 60_000) / 240_000);
        const raw = 0.24 * rectScore +
            0.2 * contrastScore +
            0.14 * flatnessScore +
            0.12 * solidityScore +
            0.12 * aspectScore +
            0.1 * heightScore +
            0.08 * areaScore;
        const kind = classifyKind(lw, lh, solidity, inner.stddev);
        if (kindFilter && !kindFilter.has(kind))
            continue;
        // Text lines are useful context but should not crowd out interactive controls.
        const score = Math.round(clamp01(kind === "text" ? raw * 0.86 : raw) * 1000) / 1000;
        if (score < minScore)
            continue;
        candidates.push({
            index: 0,
            x: Math.round(lx),
            y: Math.round(ly),
            width: Math.round(lw),
            height: Math.round(lh),
            centerX: Math.round(lx + lw / 2),
            centerY: Math.round(ly + lh / 2),
            score,
            kind,
        });
    }
    if (candidates.length === 0)
        return [];
    candidates.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);
    // Dedup first, without the mark cap: caption suppression below needs to see every surviving
    // control before deciding which labels to drop. The cap is generous but bounded so a busy
    // screen cannot turn this into an open-ended O(n^2) pass.
    const dedupCap = maxMarks * 4;
    const deduped = [];
    for (const c of candidates) {
        if (deduped.length >= dedupCap)
            break;
        if (!deduped.some((k) => intersectionOverUnion(c, k) > 0.5 || sameElement(c, k)))
            deduped.push(c);
    }
    // A text label or icon sitting inside a control IS that control's caption: the control's own
    // centre is the better click target, and the extra mark only spends budget while inviting a
    // click on the label rather than the button. IoU dedup cannot catch this — a 171x19 label in a
    // 226x54 button has IoU ~0.27 — so containment is measured separately.
    //
    // This is deliberately a post-pass over the whole list rather than an inline check during
    // selection: a caption can out-score the control it belongs to (anti-aliased glyphs are very
    // high-contrast), and score-ordered selection would then keep the label and be unable to
    // remove it once the button arrived.
    //
    // Controls and regions are never suppressed by containment. Nested controls are real (a
    // checkbox in a list row, a button in a card), and a panel legitimately holds many independent
    // text lines worth marking in their own right.
    const kept = deduped.filter((c) => c.kind === "control" ||
        c.kind === "region" ||
        !deduped.some((k) => k !== c && k.kind === "control" && containmentRatio(c, k) >= 0.8));
    // Number marks in reading order so overlay badges read naturally top-to-bottom, left-to-right.
    const numbered = kept.slice(0, maxMarks);
    numbered.sort((a, b) => a.y - b.y || a.x - b.x);
    for (let i = 0; i < numbered.length; i++)
        numbered[i].index = i + 1;
    return numbered;
}
/** Resolves a 1-based mark index to its click centre, with a helpful error when it is out of range. */
export function resolveMarkCenter(elements, index) {
    const found = elements.find((e) => e.index === index);
    if (!found) {
        const available = elements.map((e) => e.index).join(", ");
        throw new Error(`Mark #${index} is not available. Call handy_see with marks: true again and use one of: ${available || "(none detected)"}.`);
    }
    return { x: found.centerX, y: found.centerY };
}
