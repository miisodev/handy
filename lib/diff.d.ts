import type { FrameDiff, FrameDiffOptions, Point, RawFrame } from "./types.js";
export declare function parseHexRgb(hex: string): [number, number, number];
export declare function hexColorDistance(hexA: string, hexB: string): number;
/**
 * Samples the exact #rrggbb hex color at global logical coordinate (mouse.x, mouse.y)
 * from a raw frame BEFORE any rulers or reticles are drawn on top of it.
 */
export declare function samplePixelHex(frame: RawFrame, point: Point): string | null;
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
export declare function computeFrameDiff(prev: RawFrame, curr: RawFrame, channelDeltaThresholdOrOptions?: number | FrameDiffOptions, maybeOptions?: FrameDiffOptions): FrameDiff | null;
