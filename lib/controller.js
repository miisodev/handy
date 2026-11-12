import { DarwinBackend } from "./backends/darwin.js";
import { computeFrameDiff, hexColorDistance, samplePixelHex } from "./diff.js";
import { parseKeyChord, resolveModifier } from "./keys.js";
import { renderScreenOverlay } from "./overlay.js";
import { PermissionStore } from "./permissions.js";
import { encodePng, resizeRgba } from "./png.js";
function sleepAbortable(ms, signal) {
    if (ms <= 0)
        return Promise.resolve();
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error("Action chain aborted."));
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(new Error("Action chain aborted."));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
function isTopLeftCorner(p) {
    return p.x <= 2 && p.y <= 2;
}
export class HandyController {
    backend;
    permissions;
    heldButtons = new Set();
    heldKeys = new Set();
    queueTail = Promise.resolve();
    queuedCount = 0;
    lastSeenFrame = null;
    lastObservedMouse = null;
    lastCommandedTarget = null;
    static MAX_QUEUED_CHAINS = 8;
    constructor(options) {
        this.backend = options.backend;
        this.permissions = options.permissions ?? new PermissionStore();
    }
    async init() {
        await this.backend.init();
    }
    async close() {
        await this.releaseHeldInputs();
        await this.backend.close();
    }
    async releaseHeldInputs() {
        for (const btn of Array.from(this.heldButtons)) {
            try {
                await this.backend.mouseUp(btn);
            }
            catch {
                // best-effort cleanup
            }
            this.heldButtons.delete(btn);
        }
        for (const key of Array.from(this.heldKeys).reverse()) {
            try {
                await this.backend.keyUp(key);
            }
            catch {
                // best-effort cleanup
            }
            this.heldKeys.delete(key);
        }
    }
    async status() {
        const perm = this.permissions.getState();
        const base = {
            enabled: perm.enabled,
            mode: perm.mode,
            expiresAt: perm.expiresAt,
            updatedAt: perm.updatedAt,
            updatedBy: perm.updatedBy,
            platform: process.platform,
            backend: this.backend.name,
        };
        if (!perm.enabled) {
            return base;
        }
        try {
            const [displays, mouse, activeWindow] = await Promise.all([
                this.backend.getDisplays(),
                this.backend.getMousePosition(),
                this.backend.getActiveWindow ? this.backend.getActiveWindow().catch(() => null) : Promise.resolve(null),
            ]);
            return { ...base, displays, mouse, activeWindow };
        }
        catch {
            return base;
        }
    }
    async doctor() {
        const permission = this.permissions.getState();
        const checks = await this.backend.doctor();
        return {
            permission,
            backend: this.backend.name,
            checks,
        };
    }
    async listWindows() {
        this.permissions.assertCanSee();
        if (!this.backend.listWindows)
            return [];
        return this.backend.listWindows();
    }
    async getActiveWindow() {
        this.permissions.assertCanSee();
        if (!this.backend.getActiveWindow)
            return null;
        return this.backend.getActiveWindow();
    }
    async focusWindow(query) {
        this.permissions.assertCanControl();
        if (!this.backend.focusWindow) {
            throw new Error(`Window focusing is not supported by backend "${this.backend.name}".`);
        }
        const focused = await this.backend.focusWindow(query);
        const activeWindow = this.backend.getActiveWindow ? await this.backend.getActiveWindow().catch(() => null) : null;
        return { focused, activeWindow };
    }
    async readClipboard() {
        this.permissions.assertCanSee();
        if (!this.backend.getClipboardText) {
            throw new Error(`Clipboard read is not supported by backend "${this.backend.name}".`);
        }
        return this.backend.getClipboardText();
    }
    async writeClipboard(text) {
        this.permissions.assertCanControl();
        if (!this.backend.setClipboardText) {
            throw new Error(`Clipboard write is not supported by backend "${this.backend.name}".`);
        }
        await this.backend.setClipboardText(text);
    }
    async resolveWindowRegion(query, displayIndex) {
        if (!this.backend.listWindows) {
            throw new Error(`Window-scoped capture is not supported by backend "${this.backend.name}".`);
        }
        const q = typeof query === "string" ? { title: query, app: query } : query;
        const [windows, displays] = await Promise.all([this.backend.listWindows(), this.backend.getDisplays()]);
        const titleNeedle = q.title?.toLowerCase();
        const appNeedle = q.app?.toLowerCase();
        const match = windows.find((w) => {
            if (q.id !== undefined && String(w.id) === String(q.id))
                return true;
            if (titleNeedle && w.title.toLowerCase().includes(titleNeedle))
                return true;
            if (appNeedle && (w.app ?? "").toLowerCase().includes(appNeedle))
                return true;
            return false;
        });
        if (!match || !match.bounds) {
            const label = typeof query === "string" ? query : (query.title ?? query.app ?? String(query.id ?? ""));
            throw new Error(`No visible window with bounds matched "${label}".`);
        }
        const disp = displays.find((d) => d.id === (displayIndex ?? 0)) ?? displays[0];
        if (!disp)
            return match.bounds;
        const x1 = Math.max(disp.x, match.bounds.x);
        const y1 = Math.max(disp.y, match.bounds.y);
        const x2 = Math.min(disp.x + disp.width, match.bounds.x + match.bounds.width);
        const y2 = Math.min(disp.y + disp.height, match.bounds.y + match.bounds.height);
        return {
            x: x1,
            y: y1,
            width: Math.max(1, x2 - x1),
            height: Math.max(1, y2 - y1),
        };
    }
    async see(options = {}) {
        this.permissions.assertCanSee();
        const t0 = performance.now();
        const effectiveRegion = options.region ??
            (options.window !== undefined ? await this.resolveWindowRegion(options.window, options.display) : undefined);
        const [frame, mouse, activeWindow] = await Promise.all([
            this.backend.captureScreen({ display: options.display, region: effectiveRegion }),
            this.backend.getMousePosition(),
            this.backend.getActiveWindow ? this.backend.getActiveWindow().catch(() => null) : Promise.resolve(null),
        ]);
        this.lastObservedMouse = { ...mouse };
        // Sample pixel color directly under cursor from the raw unannotated frame
        const pixelUnderMouse = samplePixelHex(frame, mouse);
        // Compute fast RGBA visual diff against previous comparable frame
        let screenDiff = null;
        if (this.lastSeenFrame &&
            this.lastSeenFrame.displayId === frame.displayId &&
            this.lastSeenFrame.originX === frame.originX &&
            this.lastSeenFrame.originY === frame.originY &&
            this.lastSeenFrame.width === frame.width &&
            this.lastSeenFrame.height === frame.height) {
            screenDiff = computeFrameDiff(this.lastSeenFrame, frame);
        }
        this.lastSeenFrame = frame;
        const maxWidth = options.maxWidth ?? 1280;
        let outWidth = frame.width;
        let outHeight = frame.height;
        let rgba;
        if (frame.width > maxWidth) {
            const ratio = maxWidth / frame.width;
            outWidth = maxWidth;
            outHeight = Math.max(1, Math.round(frame.height * ratio));
            rgba = resizeRgba(frame.data, frame.width, frame.height, outWidth, outHeight);
        }
        else {
            rgba = new Uint8Array(frame.data);
        }
        const overlayMeta = renderScreenOverlay(rgba, outWidth, outHeight, {
            originX: frame.originX,
            originY: frame.originY,
            logicalWidth: frame.logicalWidth,
            logicalHeight: frame.logicalHeight,
            mouse,
            grid: options.grid ?? true,
            gridStep: options.gridStep,
            showMouse: options.showMouse ?? true,
            trail: options.trail,
            diffBounds: options.highlightDiff && screenDiff?.changedBounds ? screenDiff.changedBounds : null,
        });
        const pngBuffer = encodePng(outWidth, outHeight, rgba, { compressionLevel: 3 });
        const captureMs = Math.round((performance.now() - t0) * 10) / 10;
        return {
            pngBuffer,
            base64Png: pngBuffer.toString("base64"),
            imageWidth: outWidth,
            imageHeight: outHeight,
            screen: {
                displayId: frame.displayId,
                originX: frame.originX,
                originY: frame.originY,
                width: frame.logicalWidth,
                height: frame.logicalHeight,
                scaleFactor: frame.scaleFactor,
            },
            region: {
                x: frame.originX,
                y: frame.originY,
                width: frame.logicalWidth,
                height: frame.logicalHeight,
            },
            mouse,
            pixelUnderMouse,
            activeWindow,
            screenDiff,
            gridStep: overlayMeta.gridStep,
            coordinateSpace: "screen",
            captureMs,
            timestamp: new Date().toISOString(),
        };
    }
    async act(options) {
        if (!options.actions || options.actions.length === 0) {
            throw new Error("actions must contain at least one step.");
        }
        if (options.actions.length > 100) {
            throw new Error("actions cannot exceed 100 steps in a single chain.");
        }
        if (this.queuedCount >= HandyController.MAX_QUEUED_CHAINS) {
            throw new Error("Too many concurrent action chains queued; wait for active chain to finish.");
        }
        this.queuedCount += 1;
        const run = this.queueTail.then(() => this.executeChainInternal(options), () => this.executeChainInternal(options));
        this.queueTail = run.then(() => undefined, () => undefined);
        try {
            return await run;
        }
        finally {
            this.queuedCount -= 1;
        }
    }
    async checkFailsafe(enabled) {
        const cur = await this.backend.getMousePosition();
        if (enabled &&
            isTopLeftCorner(cur) &&
            this.lastObservedMouse !== null &&
            !isTopLeftCorner(this.lastObservedMouse) &&
            (!this.lastCommandedTarget || !isTopLeftCorner(this.lastCommandedTarget))) {
            this.lastObservedMouse = { ...cur };
            throw new Error("Failsafe triggered: cursor was moved to the top-left corner (0,0). Action chain aborted immediately.");
        }
        this.lastObservedMouse = { ...cur };
    }
    async commandMoveMouse(x, y) {
        const rx = Math.round(x);
        const ry = Math.round(y);
        this.lastCommandedTarget = { x: rx, y: ry };
        await this.backend.moveMouse(rx, ry);
        this.lastObservedMouse = { x: rx, y: ry };
    }
    async resolvePoint(x, y, space, displayIndex, cachedDisplays) {
        if (!space || space === "screen") {
            return { point: { x: Math.round(x), y: Math.round(y) }, displays: cachedDisplays };
        }
        if (space === "window") {
            if (!this.backend.getActiveWindow) {
                throw new Error(`Coordinate space "window" is not supported by backend "${this.backend.name}".`);
            }
            const win = await this.backend.getActiveWindow();
            if (!win || !win.bounds) {
                throw new Error('Cannot resolve coordinateSpace "window": no active window with bounds is available.');
            }
            return {
                point: {
                    x: Math.round(win.bounds.x + x),
                    y: Math.round(win.bounds.y + y),
                },
                displays: cachedDisplays,
            };
        }
        const displays = cachedDisplays ?? (await this.backend.getDisplays());
        const disp = displays.find((d) => d.id === (displayIndex ?? 0)) ?? displays[0];
        if (!disp) {
            throw new Error("No display found for normalized coordinate conversion.");
        }
        const clampedX = Math.max(0, Math.min(1000, x));
        const clampedY = Math.max(0, Math.min(1000, y));
        return {
            point: {
                x: Math.round(disp.x + (clampedX / 1000) * Math.max(1, disp.width - 1)),
                y: Math.round(disp.y + (clampedY / 1000) * Math.max(1, disp.height - 1)),
            },
            displays,
        };
    }
    async interpolateMove(from, to, durationMs, steps, failsafe, signal) {
        const count = steps ?? Math.max(2, Math.min(60, Math.round(durationMs / 10)));
        const interval = durationMs / count;
        for (let i = 1; i <= count; i++) {
            this.permissions.assertCanControl();
            if (signal?.aborted)
                throw new Error("Action chain aborted.");
            if (i > 1 && i % 4 === 0) {
                await this.checkFailsafe(failsafe);
            }
            const t = i / count;
            const eased = 1 - (1 - t) * (1 - t);
            const nx = Math.round(from.x + (to.x - from.x) * eased);
            const ny = Math.round(from.y + (to.y - from.y) * eased);
            await this.commandMoveMouse(nx, ny);
            if (i < count && interval >= 1) {
                await sleepAbortable(interval, signal);
            }
        }
    }
    async performClick(button, count, modifiers, signal) {
        const resolvedMods = (modifiers ?? []).map((m) => resolveModifier(m, this.backend.platform));
        for (const mod of resolvedMods) {
            await this.backend.keyDown(mod);
            this.heldKeys.add(mod);
        }
        try {
            for (let c = 1; c <= count; c++) {
                this.permissions.assertCanControl();
                if (this.backend instanceof DarwinBackend) {
                    await this.backend.mouseDown(button, c, resolvedMods);
                    this.heldButtons.add(button);
                    await this.backend.mouseUp(button, c, resolvedMods);
                    this.heldButtons.delete(button);
                }
                else {
                    await this.backend.mouseDown(button);
                    this.heldButtons.add(button);
                    await this.backend.mouseUp(button);
                    this.heldButtons.delete(button);
                }
                if (c < count) {
                    await sleepAbortable(20, signal);
                }
            }
        }
        finally {
            for (const mod of [...resolvedMods].reverse()) {
                await this.backend.keyUp(mod);
                this.heldKeys.delete(mod);
            }
        }
    }
    async executeChainInternal(options) {
        this.permissions.assertCanControl();
        const chainStart = performance.now();
        const stepDelayMs = options.stepDelayMs ?? 15;
        const failsafeEnabled = options.failsafe ?? true;
        const showTrail = options.showTrail ?? true;
        const receipts = [];
        const screenshots = [];
        const trail = [];
        let cachedDisplays = null;
        try {
            await this.checkFailsafe(failsafeEnabled);
            for (let i = 0; i < options.actions.length; i++) {
                const step = options.actions[i];
                if (options.signal?.aborted) {
                    throw new Error("Action chain aborted.");
                }
                if (i > 0) {
                    await this.checkFailsafe(failsafeEnabled);
                }
                // Check permission before EVERY step in the chain so `handy off` stops immediately mid-chain
                if (step.type === "screenshot" || step.type === "wait_for_change" || step.type === "wait_for_settled") {
                    this.permissions.assertCanSee();
                }
                else {
                    this.permissions.assertCanControl();
                }
                const stepStart = performance.now();
                let detail;
                switch (step.type) {
                    case "move": {
                        let target;
                        if (step.relative) {
                            const cur = await this.backend.getMousePosition();
                            target = { x: Math.round(cur.x + step.x), y: Math.round(cur.y + step.y) };
                        }
                        else {
                            const res = await this.resolvePoint(step.x, step.y, step.coordinateSpace, options.display, cachedDisplays);
                            cachedDisplays = res.displays;
                            target = res.point;
                        }
                        if (step.durationMs && step.durationMs > 0) {
                            const startPos = await this.backend.getMousePosition();
                            await this.interpolateMove(startPos, target, step.durationMs, step.steps, failsafeEnabled, options.signal);
                        }
                        else {
                            await this.commandMoveMouse(target.x, target.y);
                        }
                        detail = `moved to (${target.x},${target.y})`;
                        break;
                    }
                    case "click":
                    case "double_click":
                    case "triple_click":
                    case "right_click": {
                        let clickPos;
                        if (step.x !== undefined && step.y !== undefined) {
                            const res = await this.resolvePoint(step.x, step.y, step.coordinateSpace, options.display, cachedDisplays);
                            cachedDisplays = res.displays;
                            clickPos = res.point;
                            await this.commandMoveMouse(clickPos.x, clickPos.y);
                            await sleepAbortable(6, options.signal);
                        }
                        else {
                            clickPos = await this.backend.getMousePosition();
                        }
                        const button = step.type === "right_click" ? "right" : "button" in step && step.button ? step.button : "left";
                        const count = step.type === "double_click"
                            ? 2
                            : step.type === "triple_click"
                                ? 3
                                : "count" in step && step.count
                                    ? step.count
                                    : 1;
                        await this.performClick(button, count, step.modifiers, options.signal);
                        trail.push({
                            stepNumber: i + 1,
                            kind: "click",
                            x: clickPos.x,
                            y: clickPos.y,
                        });
                        detail = `${button} click x${count} at (${clickPos.x},${clickPos.y})`;
                        break;
                    }
                    case "mouse_down": {
                        if (step.x !== undefined && step.y !== undefined) {
                            const res = await this.resolvePoint(step.x, step.y, step.coordinateSpace, options.display, cachedDisplays);
                            cachedDisplays = res.displays;
                            await this.commandMoveMouse(res.point.x, res.point.y);
                        }
                        const btn = step.button ?? "left";
                        await this.backend.mouseDown(btn);
                        this.heldButtons.add(btn);
                        detail = `${btn} mouse_down`;
                        break;
                    }
                    case "mouse_up": {
                        if (step.x !== undefined && step.y !== undefined) {
                            const res = await this.resolvePoint(step.x, step.y, step.coordinateSpace, options.display, cachedDisplays);
                            cachedDisplays = res.displays;
                            await this.commandMoveMouse(res.point.x, res.point.y);
                        }
                        const btn = step.button ?? "left";
                        await this.backend.mouseUp(btn);
                        this.heldButtons.delete(btn);
                        detail = `${btn} mouse_up`;
                        break;
                    }
                    case "drag": {
                        let startPos;
                        if (step.fromX !== undefined && step.fromY !== undefined) {
                            const fromRes = await this.resolvePoint(step.fromX, step.fromY, step.coordinateSpace, options.display, cachedDisplays);
                            cachedDisplays = fromRes.displays;
                            startPos = fromRes.point;
                            await this.commandMoveMouse(startPos.x, startPos.y);
                            await sleepAbortable(8, options.signal);
                        }
                        else {
                            startPos = await this.backend.getMousePosition();
                        }
                        const toRes = await this.resolvePoint(step.toX, step.toY, step.coordinateSpace, options.display, cachedDisplays);
                        cachedDisplays = toRes.displays;
                        const btn = step.button ?? "left";
                        await this.backend.mouseDown(btn);
                        this.heldButtons.add(btn);
                        try {
                            await this.interpolateMove(startPos, toRes.point, step.durationMs ?? 160, step.steps ?? 16, failsafeEnabled, options.signal);
                        }
                        finally {
                            await this.backend.mouseUp(btn);
                            this.heldButtons.delete(btn);
                        }
                        trail.push({
                            stepNumber: i + 1,
                            kind: "drag_start",
                            x: startPos.x,
                            y: startPos.y,
                        }, {
                            stepNumber: i + 1,
                            kind: "drag_end",
                            x: toRes.point.x,
                            y: toRes.point.y,
                        });
                        detail = `dragged (${startPos.x},${startPos.y}) -> (${toRes.point.x},${toRes.point.y})`;
                        break;
                    }
                    case "scroll": {
                        if (step.x !== undefined && step.y !== undefined) {
                            const res = await this.resolvePoint(step.x, step.y, step.coordinateSpace, options.display, cachedDisplays);
                            cachedDisplays = res.displays;
                            await this.commandMoveMouse(res.point.x, res.point.y);
                        }
                        const amount = step.amount ?? 3;
                        let dx = step.deltaX ?? 0;
                        let dy = step.deltaY ?? 0;
                        if (step.direction === "up")
                            dy -= amount;
                        else if (step.direction === "down")
                            dy += amount;
                        else if (step.direction === "left")
                            dx -= amount;
                        else if (step.direction === "right")
                            dx += amount;
                        await this.backend.scroll(dx, dy);
                        detail = `scrolled dx=${dx} dy=${dy}`;
                        break;
                    }
                    case "type": {
                        if (step.delayMs && step.delayMs > 0) {
                            const chars = Array.from(step.text);
                            for (let cIdx = 0; cIdx < chars.length; cIdx++) {
                                this.permissions.assertCanControl();
                                if (options.signal?.aborted)
                                    throw new Error("Action chain aborted.");
                                await this.backend.typeText(chars[cIdx]);
                                if (cIdx < chars.length - 1) {
                                    await sleepAbortable(step.delayMs, options.signal);
                                }
                            }
                        }
                        else if (step.text.length > 0) {
                            await this.backend.typeText(step.text);
                        }
                        if (step.submit) {
                            await sleepAbortable(10, options.signal);
                            await this.backend.keyTap("enter", []);
                        }
                        detail = `typed ${Array.from(step.text).length} chars${step.submit ? " + Enter" : ""}`;
                        break;
                    }
                    case "paste": {
                        if (!this.backend.setClipboardText) {
                            // Graceful fallback to typeText if clipboard utility is unavailable
                            await this.backend.typeText(step.text);
                            if (step.submit) {
                                await sleepAbortable(10, options.signal);
                                await this.backend.keyTap("enter", []);
                            }
                            detail = `typed (clipboard fallback) ${Array.from(step.text).length} chars`;
                            break;
                        }
                        const shouldRestore = step.restoreClipboard ?? true;
                        let previousClip = null;
                        if (shouldRestore && this.backend.getClipboardText) {
                            try {
                                previousClip = await this.backend.getClipboardText();
                            }
                            catch {
                                previousClip = null;
                            }
                        }
                        await this.backend.setClipboardText(step.text);
                        const pasteParsed = parseKeyChord("mod+v", [], this.backend.platform);
                        await this.backend.keyTap(pasteParsed.key, pasteParsed.modifiers);
                        if (previousClip !== null && this.backend.setClipboardText) {
                            await sleepAbortable(35, options.signal);
                            try {
                                await this.backend.setClipboardText(previousClip);
                            }
                            catch {
                                // ignore restore error
                            }
                        }
                        if (step.submit) {
                            await sleepAbortable(10, options.signal);
                            await this.backend.keyTap("enter", []);
                        }
                        detail = `pasted ${Array.from(step.text).length} chars${step.submit ? " + Enter" : ""}`;
                        break;
                    }
                    case "key": {
                        const parsed = parseKeyChord(step.key, step.modifiers ?? [], this.backend.platform);
                        const repeat = step.count ?? 1;
                        for (let r = 0; r < repeat; r++) {
                            this.permissions.assertCanControl();
                            await this.backend.keyTap(parsed.key, parsed.modifiers);
                            if (r < repeat - 1) {
                                await sleepAbortable(15, options.signal);
                            }
                        }
                        const chordLabel = [...parsed.modifiers, parsed.key].join("+");
                        detail = repeat > 1 ? `key ${chordLabel} x${repeat}` : `key ${chordLabel}`;
                        break;
                    }
                    case "key_down": {
                        await this.backend.keyDown(step.key);
                        this.heldKeys.add(step.key);
                        detail = `key_down ${step.key}`;
                        break;
                    }
                    case "key_up": {
                        await this.backend.keyUp(step.key);
                        this.heldKeys.delete(step.key);
                        detail = `key_up ${step.key}`;
                        break;
                    }
                    case "focus_window": {
                        if (!this.backend.focusWindow) {
                            throw new Error(`Window focusing is not supported by backend "${this.backend.name}".`);
                        }
                        const ok = await this.backend.focusWindow({
                            title: step.title,
                            app: step.app,
                            id: step.id,
                        });
                        if (!ok) {
                            const targetDesc = step.title ?? step.app ?? String(step.id ?? "");
                            throw new Error(`Could not find or focus window matching "${targetDesc}".`);
                        }
                        await sleepAbortable(35, options.signal);
                        detail = `focused window (${step.title ?? step.app ?? step.id})`;
                        break;
                    }
                    case "wait": {
                        await sleepAbortable(step.ms, options.signal);
                        detail = `waited ${step.ms}ms`;
                        break;
                    }
                    case "wait_for_change": {
                        const timeoutMs = step.timeoutMs ?? 3000;
                        const pollMs = step.pollMs ?? 60;
                        const threshold = step.threshold ?? 0.05;
                        const baseline = await this.backend.captureScreen({
                            display: options.display,
                            region: step.region,
                        });
                        const deadline = performance.now() + timeoutMs;
                        let maxObserved = 0;
                        let matchedDiff = null;
                        while (performance.now() < deadline) {
                            await sleepAbortable(pollMs, options.signal);
                            await this.checkFailsafe(failsafeEnabled);
                            const next = await this.backend.captureScreen({
                                display: options.display,
                                region: step.region,
                            });
                            const diff = computeFrameDiff(baseline, next);
                            if (diff) {
                                if (diff.changedPercent > maxObserved)
                                    maxObserved = diff.changedPercent;
                                if (diff.changedPercent >= threshold) {
                                    matchedDiff = diff;
                                    break;
                                }
                            }
                        }
                        if (!matchedDiff) {
                            throw new Error(`Timed out after ${timeoutMs}ms waiting for screen change >= ${threshold}% (max observed: ${maxObserved}%).`);
                        }
                        detail = `detected ${matchedDiff.changedPercent}% visual change`;
                        break;
                    }
                    case "wait_for_settled": {
                        const timeoutMs = step.timeoutMs ?? 3000;
                        const quietMs = step.quietMs ?? 120;
                        const pollMs = step.pollMs ?? 80;
                        const threshold = step.threshold ?? 0.1;
                        let prev = await this.backend.captureScreen({
                            display: options.display,
                            region: step.region,
                        });
                        const deadline = performance.now() + timeoutMs;
                        let quietSince = performance.now();
                        let settled = false;
                        while (performance.now() < deadline) {
                            await sleepAbortable(pollMs, options.signal);
                            await this.checkFailsafe(failsafeEnabled);
                            const curr = await this.backend.captureScreen({
                                display: options.display,
                                region: step.region,
                            });
                            const diff = computeFrameDiff(prev, curr);
                            prev = curr;
                            if (!diff || diff.changedPercent <= threshold) {
                                if (performance.now() - quietSince >= quietMs) {
                                    settled = true;
                                    break;
                                }
                            }
                            else {
                                quietSince = performance.now();
                            }
                        }
                        detail = settled
                            ? `screen settled (${quietMs}ms quiet)`
                            : `timeout (${timeoutMs}ms) reached while waiting for settle`;
                        break;
                    }
                    case "wait_for_color": {
                        const timeoutMs = step.timeoutMs ?? 5000;
                        const pollMs = step.pollMs ?? 80;
                        const tolerance = step.tolerance ?? 24;
                        const resolved = await this.resolvePoint(step.x, step.y, step.coordinateSpace, options.display, cachedDisplays);
                        cachedDisplays = resolved.displays ?? (await this.backend.getDisplays());
                        const disp = cachedDisplays.find((d) => d.id === (options.display ?? 0)) ?? cachedDisplays[0];
                        let sampleRegion;
                        if (disp) {
                            const rx1 = Math.max(disp.x, resolved.point.x - 1);
                            const ry1 = Math.max(disp.y, resolved.point.y - 1);
                            const rx2 = Math.min(disp.x + disp.width, resolved.point.x + 2);
                            const ry2 = Math.min(disp.y + disp.height, resolved.point.y + 2);
                            sampleRegion = {
                                x: rx1,
                                y: ry1,
                                width: Math.max(1, rx2 - rx1),
                                height: Math.max(1, ry2 - ry1),
                            };
                        }
                        const deadline = performance.now() + timeoutMs;
                        let matched = false;
                        let lastHex = null;
                        let lastDist = null;
                        while (true) {
                            const frame = await this.backend.captureScreen({
                                display: options.display,
                                region: sampleRegion,
                            });
                            lastHex = samplePixelHex(frame, resolved.point);
                            if (lastHex) {
                                lastDist = Math.round(hexColorDistance(lastHex, step.color) * 10) / 10;
                                if (lastDist <= tolerance) {
                                    matched = true;
                                    break;
                                }
                            }
                            if (performance.now() >= deadline) {
                                break;
                            }
                            await sleepAbortable(Math.min(pollMs, Math.max(1, deadline - performance.now())), options.signal);
                        }
                        detail = matched
                            ? `matched ${lastHex} near ${step.color} (dist ${lastDist}) at (${resolved.point.x}, ${resolved.point.y})`
                            : `timeout (${timeoutMs}ms) waiting for ${step.color} at (${resolved.point.x}, ${resolved.point.y}); last ${lastHex ?? "none"}`;
                        break;
                    }
                    case "screenshot": {
                        const shot = await this.see({
                            display: options.display,
                            region: step.region,
                            window: step.window,
                            grid: step.grid ?? options.grid ?? true,
                            showMouse: step.showMouse ?? options.showMouse ?? true,
                            maxWidth: step.maxWidth ?? options.maxWidth,
                            highlightDiff: step.highlightDiff ?? options.highlightDiff,
                            trail: showTrail && trail.length > 0 ? trail : undefined,
                        });
                        if (step.label)
                            shot.label = step.label;
                        screenshots.push(shot);
                        detail = `captured ${shot.imageWidth}x${shot.imageHeight}`;
                        break;
                    }
                }
                const stepDurationMs = Math.round((performance.now() - stepStart) * 10) / 10;
                receipts.push({
                    index: i,
                    type: step.type,
                    durationMs: stepDurationMs,
                    detail,
                });
                if (i < options.actions.length - 1 &&
                    stepDelayMs > 0 &&
                    step.type !== "wait" &&
                    step.type !== "wait_for_change" &&
                    step.type !== "wait_for_settled" &&
                    step.type !== "wait_for_color" &&
                    step.type !== "screenshot") {
                    await sleepAbortable(stepDelayMs, options.signal);
                }
            }
            if (options.screenshotAfter) {
                const settleMs = options.settleMs ?? 50;
                if (settleMs > 0) {
                    await sleepAbortable(settleMs, options.signal);
                }
                const postShot = await this.see({
                    display: options.display,
                    grid: options.grid ?? true,
                    showMouse: options.showMouse ?? true,
                    maxWidth: options.maxWidth,
                    highlightDiff: options.highlightDiff,
                    trail: showTrail && trail.length > 0 ? trail : undefined,
                });
                postShot.label = "after";
                screenshots.push(postShot);
            }
            const [finalMouse, activeWindow] = await Promise.all([
                this.backend.getMousePosition(),
                this.backend.getActiveWindow ? this.backend.getActiveWindow().catch(() => null) : Promise.resolve(null),
            ]);
            this.lastObservedMouse = { ...finalMouse };
            const totalDurationMs = Math.round((performance.now() - chainStart) * 10) / 10;
            return {
                ok: true,
                stepsCompleted: receipts.length,
                totalDurationMs,
                mouse: finalMouse,
                activeWindow,
                receipts,
                screenshots,
            };
        }
        catch (err) {
            await this.releaseHeldInputs();
            throw err;
        }
    }
}
/**
 * Parses a human/CLI chain expression like:
 *   `focus "Scratchpad" -> click 800 420 -> paste "Hello 🌍" -> key Enter`
 * OR JSON array `[{"type":"move","x":420,"y":260}, ...]` into ActionStep[].
 */
export function parseChainInput(input) {
    const trimmed = input.trim();
    if (!trimmed) {
        throw new Error("Empty action input.");
    }
    if (trimmed.startsWith("[")) {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) {
            throw new Error("JSON action input must be an array of steps.");
        }
        return parsed;
    }
    if (trimmed.startsWith("{")) {
        return [JSON.parse(trimmed)];
    }
    const segments = [];
    let current = "";
    let quote = null;
    for (let i = 0; i < trimmed.length; i++) {
        const ch = trimmed[i];
        if (quote) {
            if (ch === "\\" && i + 1 < trimmed.length) {
                current += ch + trimmed[i + 1];
                i++;
                continue;
            }
            if (ch === quote)
                quote = null;
            current += ch;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            current += ch;
            continue;
        }
        if (ch === ";") {
            if (current.trim())
                segments.push(current.trim());
            current = "";
            continue;
        }
        if (ch === "-" && trimmed[i + 1] === ">") {
            if (current.trim())
                segments.push(current.trim());
            current = "";
            i++;
            continue;
        }
        current += ch;
    }
    if (current.trim())
        segments.push(current.trim());
    const tokenize = (seg) => {
        const out = [];
        let tok = "";
        let q = null;
        for (let i = 0; i < seg.length; i++) {
            const ch = seg[i];
            if (q) {
                if (ch === "\\" && i + 1 < seg.length) {
                    const next = seg[i + 1];
                    tok += next === "n" ? "\n" : next === "t" ? "\t" : next;
                    i++;
                    continue;
                }
                if (ch === q) {
                    q = null;
                    continue;
                }
                tok += ch;
                continue;
            }
            if (ch === '"' || ch === "'") {
                q = ch;
                continue;
            }
            if (/\s/.test(ch)) {
                if (tok.length > 0) {
                    out.push(tok);
                    tok = "";
                }
                continue;
            }
            tok += ch;
        }
        if (tok.length > 0)
            out.push(tok);
        return out;
    };
    return segments.map((seg) => {
        const tokens = tokenize(seg);
        const cmd = (tokens[0] ?? "").toLowerCase();
        const parseCoords = (a, b) => {
            if (a && a.includes(",") && b === undefined) {
                const [xs, ys] = a.split(",");
                const x = Number(xs);
                const y = Number(ys);
                if (!Number.isNaN(x) && !Number.isNaN(y))
                    return [x, y];
            }
            if (a !== undefined && b !== undefined) {
                const x = Number(a);
                const y = Number(b);
                if (!Number.isNaN(x) && !Number.isNaN(y))
                    return [x, y];
            }
            return null;
        };
        switch (cmd) {
            case "move": {
                const coords = parseCoords(tokens[1], tokens[2]);
                if (!coords)
                    throw new Error(`Invalid move step "${seg}". Expected: move <x> <y>`);
                return { type: "move", x: coords[0], y: coords[1] };
            }
            case "click": {
                const coords = parseCoords(tokens[1], tokens[2]);
                return coords ? { type: "click", x: coords[0], y: coords[1] } : { type: "click" };
            }
            case "double_click":
            case "doubleclick":
            case "dblclick": {
                const coords = parseCoords(tokens[1], tokens[2]);
                return coords ? { type: "double_click", x: coords[0], y: coords[1] } : { type: "double_click" };
            }
            case "triple_click":
            case "tripleclick": {
                const coords = parseCoords(tokens[1], tokens[2]);
                return coords ? { type: "triple_click", x: coords[0], y: coords[1] } : { type: "triple_click" };
            }
            case "right_click":
            case "rightclick":
            case "rclick": {
                const coords = parseCoords(tokens[1], tokens[2]);
                return coords ? { type: "right_click", x: coords[0], y: coords[1] } : { type: "right_click" };
            }
            case "drag": {
                if (tokens.length >= 5) {
                    return {
                        type: "drag",
                        fromX: Number(tokens[1]),
                        fromY: Number(tokens[2]),
                        toX: Number(tokens[3]),
                        toY: Number(tokens[4]),
                    };
                }
                const coords = parseCoords(tokens[1], tokens[2]);
                if (!coords)
                    throw new Error(`Invalid drag step "${seg}". Expected: drag [fromX fromY] <toX> <toY>`);
                return { type: "drag", toX: coords[0], toY: coords[1] };
            }
            case "scroll": {
                const dir = tokens[1]?.toLowerCase();
                if (dir === "up" || dir === "down" || dir === "left" || dir === "right") {
                    const amount = tokens[2] ? Number(tokens[2]) : 3;
                    return { type: "scroll", direction: dir, amount };
                }
                const coords = parseCoords(tokens[1], tokens[2]);
                if (coords)
                    return { type: "scroll", deltaX: coords[0], deltaY: coords[1] };
                throw new Error(`Invalid scroll step "${seg}". Expected: scroll <up|down|left|right> [amount]`);
            }
            case "type": {
                const rawAfterCmd = seg.replace(/^type\s+/i, "");
                const text = (rawAfterCmd.startsWith('"') && rawAfterCmd.endsWith('"')) ||
                    (rawAfterCmd.startsWith("'") && rawAfterCmd.endsWith("'"))
                    ? (tokens[1] ?? "")
                    : rawAfterCmd;
                return { type: "type", text };
            }
            case "paste": {
                const rawAfterCmd = seg.replace(/^paste\s+/i, "");
                const text = (rawAfterCmd.startsWith('"') && rawAfterCmd.endsWith('"')) ||
                    (rawAfterCmd.startsWith("'") && rawAfterCmd.endsWith("'"))
                    ? (tokens[1] ?? "")
                    : rawAfterCmd;
                return { type: "paste", text };
            }
            case "key":
            case "press": {
                if (!tokens[1])
                    throw new Error(`Invalid key step "${seg}". Expected: key <KeyOrChord>`);
                return { type: "key", key: tokens[1] };
            }
            case "focus":
            case "focus_window": {
                const title = tokens.slice(1).join(" ").trim();
                if (!title)
                    throw new Error(`Invalid focus_window step "${seg}". Expected: focus <WindowTitle>`);
                return { type: "focus_window", title };
            }
            case "wait":
            case "sleep": {
                const ms = Number(tokens[1] ?? 0);
                if (Number.isNaN(ms) || ms < 0)
                    throw new Error(`Invalid wait step "${seg}". Expected: wait <ms>`);
                return { type: "wait", ms };
            }
            case "wait_for_change": {
                const timeoutMs = tokens[1] ? Number(tokens[1]) : undefined;
                return { type: "wait_for_change", timeoutMs };
            }
            case "wait_for_settled": {
                const timeoutMs = tokens[1] ? Number(tokens[1]) : undefined;
                const quietMs = tokens[2] ? Number(tokens[2]) : undefined;
                return { type: "wait_for_settled", timeoutMs, quietMs };
            }
            case "wait_for_color": {
                const x = Number(tokens[1]);
                const y = Number(tokens[2]);
                const color = tokens[3];
                if (Number.isNaN(x) ||
                    Number.isNaN(y) ||
                    !color ||
                    !/^#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)) {
                    throw new Error(`Invalid wait_for_color step "${seg}". Expected: wait_for_color <x> <y> <#rrggbb> [timeoutMs] [tolerance]`);
                }
                const timeoutMs = tokens[4] ? Number(tokens[4]) : undefined;
                const tolerance = tokens[5] ? Number(tokens[5]) : undefined;
                return { type: "wait_for_color", x, y, color, timeoutMs, tolerance };
            }
            case "screenshot":
            case "see":
                return { type: "screenshot" };
            default:
                throw new Error(`Unknown step "${cmd}" in "${seg}". Supported steps: move, click, double_click, triple_click, right_click, drag, scroll, type, paste, key, focus_window, wait, wait_for_change, wait_for_settled, wait_for_color, screenshot.`);
        }
    });
}
