export type RgbaColor = readonly [r: number, g: number, b: number, a: number];
export declare function blendPixel(rgba: Uint8Array, width: number, height: number, x: number, y: number, color: RgbaColor): void;
export declare function fillRect(rgba: Uint8Array, width: number, height: number, x: number, y: number, rectWidth: number, rectHeight: number, color: RgbaColor): void;
export declare function strokeRect(rgba: Uint8Array, width: number, height: number, x: number, y: number, rectWidth: number, rectHeight: number, color: RgbaColor, thickness?: number): void;
export declare function drawLine(rgba: Uint8Array, width: number, height: number, x0: number, y0: number, x1: number, y1: number, color: RgbaColor): void;
export declare function drawCircleRing(rgba: Uint8Array, width: number, height: number, cx: number, cy: number, radius: number, thickness: number, color: RgbaColor): void;
export declare function measureText(text: string, scale?: number): {
    width: number;
    height: number;
};
export declare function drawText(rgba: Uint8Array, width: number, height: number, x: number, y: number, text: string, color: RgbaColor, scale?: number): void;
export declare function drawBadge(rgba: Uint8Array, width: number, height: number, x: number, y: number, text: string, options?: {
    bg?: RgbaColor;
    fg?: RgbaColor;
    border?: RgbaColor;
    scale?: number;
    padX?: number;
    padY?: number;
}): {
    width: number;
    height: number;
};
