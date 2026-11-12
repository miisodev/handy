import { blendPixel, drawBadge, drawCircleRing, drawLine, fillRect, measureText, } from "./font.js";
const NICE_STEPS = [25, 50, 100, 200, 250, 400, 500, 1000];
export function chooseGridStep(logicalWidth, logicalHeight) {
    const maxDim = Math.max(logicalWidth, logicalHeight);
    const targetIntervals = 8;
    const raw = maxDim / targetIntervals;
    for (const step of NICE_STEPS) {
        if (step >= raw)
            return step;
    }
    return 1000;
}
export function renderScreenOverlay(rgba, imageWidth, imageHeight, options) {
    const drawGrid = options.grid ?? true;
    const drawMouse = options.showMouse ?? true;
    const toImgX = (screenX) => Math.round(((screenX - options.originX) / Math.max(1, options.logicalWidth)) * imageWidth);
    const toImgY = (screenY) => Math.round(((screenY - options.originY) / Math.max(1, options.logicalHeight)) * imageHeight);
    let resolvedStep = null;
    if (drawGrid) {
        const majorStep = options.gridStep && options.gridStep >= 10
            ? Math.round(options.gridStep)
            : chooseGridStep(options.logicalWidth, options.logicalHeight);
        resolvedStep = majorStep;
        const minorStep = majorStep >= 50 ? Math.round(majorStep / 2) : 0;
        const majorColor = [14, 165, 233, 78]; // Sky-500 semi-transparent
        const minorColor = [148, 163, 184, 36]; // Slate-400 subtle
        const tickColor = [56, 189, 248, 220];
        const startX = Math.ceil(options.originX / (minorStep || majorStep)) * (minorStep || majorStep);
        const endX = options.originX + options.logicalWidth;
        const startY = Math.ceil(options.originY / (minorStep || majorStep)) * (minorStep || majorStep);
        const endY = options.originY + options.logicalHeight;
        // Vertical grid lines
        const stepIterX = minorStep || majorStep;
        for (let sx = startX; sx <= endX; sx += stepIterX) {
            const ix = toImgX(sx);
            if (ix <= 0 || ix >= imageWidth)
                continue;
            const isMajor = sx % majorStep === 0;
            const col = isMajor ? majorColor : minorColor;
            for (let py = 0; py < imageHeight; py++) {
                if (isMajor || (py & 3) < 2) {
                    blendPixel(rgba, imageWidth, imageHeight, ix, py, col);
                }
            }
        }
        // Horizontal grid lines
        const stepIterY = minorStep || majorStep;
        for (let sy = startY; sy <= endY; sy += stepIterY) {
            const iy = toImgY(sy);
            if (iy <= 0 || iy >= imageHeight)
                continue;
            const isMajor = sy % majorStep === 0;
            const col = isMajor ? majorColor : minorColor;
            for (let px = 0; px < imageWidth; px++) {
                if (isMajor || (px & 3) < 2) {
                    blendPixel(rgba, imageWidth, imageHeight, px, iy, col);
                }
            }
        }
        // Top & Left thin ruler strips for high legibility over both light and dark apps
        fillRect(rgba, imageWidth, imageHeight, 0, 0, imageWidth, 15, [15, 23, 42, 175]);
        fillRect(rgba, imageWidth, imageHeight, 0, 15, 34, imageHeight - 15, [15, 23, 42, 155]);
        // Interior subtle coordinate pills at every second major intersection so LLM can read local (x,y) directly
        const majorStartX = Math.ceil(options.originX / majorStep) * majorStep;
        const majorStartY = Math.ceil(options.originY / majorStep) * majorStep;
        let rowIdx = 0;
        for (let sy = majorStartY; sy < endY; sy += majorStep) {
            const iy = toImgY(sy);
            rowIdx++;
            if (iy < 32 || iy > imageHeight - 24)
                continue;
            let colIdx = 0;
            for (let sx = majorStartX; sx < endX; sx += majorStep) {
                const ix = toImgX(sx);
                colIdx++;
                if (ix < 52 || ix > imageWidth - 64)
                    continue;
                if ((rowIdx + colIdx) % 2 === 0) {
                    // Small cross marker + subtle coordinate pill
                    drawLine(rgba, imageWidth, imageHeight, ix - 3, iy, ix + 3, iy, [56, 189, 248, 170]);
                    drawLine(rgba, imageWidth, imageHeight, ix, iy - 3, ix, iy + 3, [56, 189, 248, 170]);
                    drawBadge(rgba, imageWidth, imageHeight, ix + 3, iy + 3, `${sx},${sy}`, {
                        bg: [15, 23, 42, 145],
                        fg: [186, 230, 253, 225],
                        padX: 2,
                        padY: 1,
                    });
                }
            }
        }
        // Top X-axis labels & ticks
        for (let sx = majorStartX; sx <= endX; sx += majorStep) {
            const ix = toImgX(sx);
            if (ix < 36 || ix > imageWidth - 20)
                continue;
            drawLine(rgba, imageWidth, imageHeight, ix, 0, ix, 14, tickColor);
            const label = String(sx);
            const m = measureText(label, 1);
            drawBadge(rgba, imageWidth, imageHeight, Math.max(36, ix - Math.floor(m.width / 2) - 2), 2, label, {
                bg: [15, 23, 42, 215],
                fg: [125, 211, 252, 255],
                padX: 2,
                padY: 2,
            });
        }
        // Left Y-axis labels & ticks
        for (let sy = majorStartY; sy <= endY; sy += majorStep) {
            const iy = toImgY(sy);
            if (iy < 20 || iy > imageHeight - 12)
                continue;
            drawLine(rgba, imageWidth, imageHeight, 0, iy, 12, iy, tickColor);
            drawBadge(rgba, imageWidth, imageHeight, 2, Math.max(16, iy - 5), String(sy), {
                bg: [15, 23, 42, 215],
                fg: [125, 211, 252, 255],
                padX: 2,
                padY: 2,
            });
        }
        // Origin badge in top-left corner
        drawBadge(rgba, imageWidth, imageHeight, 2, 2, `${options.originX},${options.originY}`, {
            bg: [2, 132, 199, 235],
            fg: [255, 255, 255, 255],
            padX: 3,
            padY: 2,
        });
    }
    if (drawMouse) {
        const mx = Math.round(options.mouse.x);
        const my = Math.round(options.mouse.y);
        const inBounds = mx >= options.originX &&
            mx <= options.originX + options.logicalWidth &&
            my >= options.originY &&
            my <= options.originY + options.logicalHeight;
        if (inBounds) {
            const cx = Math.max(0, Math.min(imageWidth - 1, toImgX(mx)));
            const cy = Math.max(0, Math.min(imageHeight - 1, toImgY(my)));
            const whiteHalo = [255, 255, 255, 235];
            const redCore = [239, 68, 68, 250]; // Red-500
            // Outer white contrast halo + vivid red reticle ring
            drawCircleRing(rgba, imageWidth, imageHeight, cx, cy, 12, 3.2, whiteHalo);
            drawCircleRing(rgba, imageWidth, imageHeight, cx, cy, 12, 1.8, redCore);
            drawCircleRing(rgba, imageWidth, imageHeight, cx, cy, 4, 1.5, redCore);
            // Crosshair arms with open 3px center so target pixel stays visible
            drawLine(rgba, imageWidth, imageHeight, cx - 18, cy, cx - 5, cy, redCore);
            drawLine(rgba, imageWidth, imageHeight, cx + 5, cy, cx + 18, cy, redCore);
            drawLine(rgba, imageWidth, imageHeight, cx, cy - 18, cx, cy - 5, redCore);
            drawLine(rgba, imageWidth, imageHeight, cx, cy + 5, cx, cy + 18, redCore);
            const badgeText = `MOUSE (${mx},${my})`;
            const textMetrics = measureText(badgeText, 1);
            const badgeW = textMetrics.width + 10;
            const badgeH = textMetrics.height + 6;
            let bx = cx + 15;
            let by = cy + 14;
            if (bx + badgeW > imageWidth - 4) {
                bx = Math.max(4, cx - 15 - badgeW);
            }
            if (by + badgeH > imageHeight - 4) {
                by = Math.max(4, cy - 14 - badgeH);
            }
            drawBadge(rgba, imageWidth, imageHeight, bx, by, badgeText, {
                bg: [127, 29, 29, 235],
                fg: [255, 255, 255, 255],
                border: [248, 113, 113, 255],
                padX: 5,
                padY: 3,
            });
        }
        else {
            const badgeText = `MOUSE (${mx},${my}) [outside region]`;
            const textMetrics = measureText(badgeText, 1);
            const badgeW = textMetrics.width + 10;
            const badgeH = textMetrics.height + 6;
            drawBadge(rgba, imageWidth, imageHeight, Math.max(4, imageWidth - badgeW - 6), Math.max(4, imageHeight - badgeH - 6), badgeText, {
                bg: [127, 29, 29, 230],
                fg: [254, 226, 226, 255],
                border: [248, 113, 113, 255],
                padX: 5,
                padY: 3,
            });
        }
    }
    return { gridStep: resolvedStep };
}
