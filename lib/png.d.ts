/**
 * PNG row-filter strategy.
 * - `auto` (default): Up for rows identical to the previous one, otherwise Paeth. Benchmarked as
 *   both smaller *and* faster than a full per-row min-sum search on UI screenshots, because flat
 *   background rows collapse to all-zero bytes that deflate encodes almost for free.
 * - `sub`: legacy behaviour (Sub on every row).
 * - `none` / `up` / `paeth`: force a single filter for every row.
 */
export type PngFilterStrategy = "auto" | "none" | "sub" | "up" | "paeth";
export declare function encodePng(width: number, height: number, rgba: Uint8Array, options?: {
    compressionLevel?: number;
    filter?: PngFilterStrategy;
}): Buffer;
export declare function decodePng(pngBytes: Uint8Array): {
    width: number;
    height: number;
    data: Uint8Array;
};
export declare function cropRgba(src: Uint8Array, srcWidth: number, srcHeight: number, x: number, y: number, cropWidth: number, cropHeight: number): {
    width: number;
    height: number;
    data: Uint8Array;
    x: number;
    y: number;
};
/** Resampling filter used by {@link resizeRgba}. */
export type ResizeFilter = "auto" | "box" | "bilinear";
/**
 * Resizes an RGBA buffer.
 *
 * `auto` (default) picks an area-average box filter when downscaling — the right choice for screen
 * captures, because it averages every covered source pixel instead of sampling only four of them.
 * That keeps small UI text legible (and coordinate rulers crisp) where bilinear produces moiré and
 * dropped strokes. Bilinear is used when upscaling.
 */
export declare function resizeRgba(src: Uint8Array, srcWidth: number, srcHeight: number, dstWidth: number, dstHeight: number, options?: {
    filter?: ResizeFilter;
}): Uint8Array;
