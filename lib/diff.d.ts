import type { FrameDiff, Point, RawFrame } from "./types.js";
/**
 * Samples the exact #rrggbb hex color at global logical coordinate (mouse.x, mouse.y)
 * from a raw frame BEFORE any rulers or reticles are drawn on top of it.
 */
export declare function samplePixelHex(frame: RawFrame, point: Point): string | null;
/**
 * Computes fast (<2ms on 1080p) visual frame difference between two RawFrames covering the
 * same logical screen region, returning changed percentage and global logical bounding box.
 */
export declare function computeFrameDiff(prev: RawFrame, curr: RawFrame, channelDeltaThreshold?: number): FrameDiff | null;
