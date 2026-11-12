export declare function encodePng(width: number, height: number, rgba: Uint8Array, options?: {
    compressionLevel?: number;
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
/**
 * Fast bilinear resizer for RGBA buffers so UI text remains legible when downscaling
 * high-DPI screens before applying crisp 1:1 coordinate rulers and mouse reticles.
 */
export declare function resizeRgba(src: Uint8Array, srcWidth: number, srcHeight: number, dstWidth: number, dstHeight: number): Uint8Array;
