import type { RawFrame, Region, UiElement, UiElementKind } from "./types.js";
export interface DetectElementsOptions {
    /** Maximum number of marks to return. Default: 40 */
    maxMarks?: number;
    /** Minimum element area in *logical* screen pixels. Default: 144 */
    minArea?: number;
    /** Maximum element area as a fraction of the frame area. Default: 0.55 */
    maxAreaFraction?: number;
    /** Minimum confidence score (0..1) to keep a candidate. Default: 0.3 */
    minScore?: number;
    /** Restrict kinds to return. Default: all kinds */
    kinds?: UiElementKind[];
    /** Edge-gradient threshold 0..255. Lower finds subtler elements, higher only strong ones. Default: 30 */
    edgeThreshold?: number;
    /** Dilation radius so nearby strokes merge into one element. Default: 2 */
    dilateRadius?: number;
    /** Merge short components on the same baseline into text lines. Default: true */
    mergeTextLines?: boolean;
    /** Restrict detection to a sub-rectangle of the frame (frame pixel coordinates). */
    searchRegion?: Region;
}
/**
 * Detects candidate interactive UI elements in a captured frame.
 *
 * Bounds and centres are expressed in the frame's **global logical screen coordinate space**, so
 * they can be handed straight to `handy_act` even when the frame came from a window/region zoom or
 * a HiDPI display.
 */
export declare function detectUiElements(frame: RawFrame, options?: DetectElementsOptions): UiElement[];
/** Resolves a 1-based mark index to its click centre, with a helpful error when it is out of range. */
export declare function resolveMarkCenter(elements: UiElement[], index: number): {
    x: number;
    y: number;
};
