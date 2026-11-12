import type { Point, Region, TrailMarker } from "./types.js";
export declare function chooseGridStep(logicalWidth: number, logicalHeight: number): number;
export interface OverlayOptions {
    /** Global logical X of top-left pixel */
    originX: number;
    /** Global logical Y of top-left pixel */
    originY: number;
    /** Logical screen width covered by this image */
    logicalWidth: number;
    /** Logical screen height covered by this image */
    logicalHeight: number;
    /** Live mouse cursor position in global logical screen coordinates */
    mouse: Point;
    /** Draw coordinate rulers & grid */
    grid?: boolean;
    /** Optional explicit major grid step in logical screen pixels */
    gridStep?: number;
    /** Draw live mouse reticle & coordinate badge */
    showMouse?: boolean;
    /** Optional chain action trail markers (clicks / drags) to render on post-action screenshots */
    trail?: TrailMarker[];
    /** Optional visual diff bounding box in global logical coordinates to highlight */
    diffBounds?: Region | null;
}
export declare function renderScreenOverlay(rgba: Uint8Array, imageWidth: number, imageHeight: number, options: OverlayOptions): {
    gridStep: number | null;
};
