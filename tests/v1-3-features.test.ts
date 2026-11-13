import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VirtualDesktopBackend } from "../src/backends/virtual.js";
import { HandyController, fittsDurationMs, parseChainInput } from "../src/controller.js";
import { computeFrameDiff } from "../src/diff.js";
import { detectUiElements, resolveMarkCenter } from "../src/marks.js";
import { PermissionStore } from "../src/permissions.js";
import { decodePng, encodePng, resizeRgba, type PngFilterStrategy } from "../src/png.js";
import { renderScreenOverlay } from "../src/overlay.js";
import { pickDisplay, type DisplayInfo, type MouseButton, type RawFrame, type UiElement } from "../src/types.js";
import { startControlPanel } from "../src/ui.js";

function makeFrame(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number],
  overrides: Partial<RawFrame> = {},
): RawFrame {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return {
    width,
    height,
    data,
    originX: 0,
    originY: 0,
    logicalWidth: width,
    logicalHeight: height,
    scaleFactor: 1,
    displayId: 0,
    ...overrides,
  };
}

function meanLuminance(data: Uint8Array): number {
  let sum = 0;
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) sum += data[i]!;
  return sum / n;
}

/** Solid button-like rectangle on a flat background: the canonical detection target. */
function buttonFrame(width = 640, height = 400): RawFrame {
  return makeFrame(width, height, (x, y) => {
    const inButton = x >= 200 && x < 360 && y >= 150 && y < 200;
    return inButton ? [2, 132, 199] : [241, 245, 249];
  });
}

function findByBox(elements: UiElement[], target: { x: number; y: number; width: number; height: number }, tol = 14) {
  return elements.find(
    (e) =>
      Math.abs(e.x - target.x) <= tol &&
      Math.abs(e.y - target.y) <= tol &&
      Math.abs(e.width - target.width) <= tol * 2 &&
      Math.abs(e.height - target.height) <= tol * 2,
  );
}

describe("Handy v1.3.0 — Area-average downscaling", () => {
  it("preserves thin features that bilinear sampling drops entirely", () => {
    // 1px dark rules every 6px mimic text lines; at 3x downscale bilinear samples between them.
    const src = makeFrame(1800, 900, (_x, y) => {
      const v = y % 6 === 0 ? 20 : 245;
      return [v, v, v];
    });
    const srcMean = meanLuminance(src.data);

    const box = resizeRgba(src.data, 1800, 900, 600, 300);
    const bilinear = resizeRgba(src.data, 1800, 900, 600, 300, { filter: "bilinear" });

    // Box filtering conserves energy exactly, so the dark rules survive.
    expect(Math.abs(meanLuminance(box) - srcMean)).toBeLessThan(1);
    // Bilinear lands on the light background and erases them.
    expect(Math.abs(meanLuminance(bilinear) - srcMean)).toBeGreaterThan(10);
    expect(box.length).toBe(600 * 300 * 4);
  });

  it("integer fast path agrees with the general coverage-weighted path", () => {
    const src = makeFrame(120, 80, (x, y) => [(x * 7) % 256, (y * 11) % 256, (x * y) % 256]);
    // 2x is served by the unrolled integer path; 120->61 exercises the fractional path.
    const exact = resizeRgba(src.data, 120, 80, 60, 40);
    const near = resizeRgba(src.data, 120, 80, 61, 40);
    expect(exact.length).toBe(60 * 40 * 4);
    expect(near.length).toBe(61 * 40 * 4);
    // Neighbouring output sizes must produce broadly similar images, not garbage.
    expect(Math.abs(meanLuminance(exact) - meanLuminance(near))).toBeLessThan(6);
    expect(Math.abs(meanLuminance(exact) - meanLuminance(src.data))).toBeLessThan(6);
  });

  it("returns a copy for identity resize and rejects non-positive dimensions", () => {
    const src = makeFrame(8, 8, () => [10, 20, 30]);
    const same = resizeRgba(src.data, 8, 8, 8, 8);
    expect(same.length).toBe(src.data.length);
    expect(same).not.toBe(src.data);
    expect(() => resizeRgba(src.data, 8, 8, 0, 4)).toThrow(/Invalid resize dimensions/);
  });

  it("still upscales via bilinear when asked", () => {
    const src = makeFrame(16, 16, (x, y) => [(x * 16) % 256, (y * 16) % 256, 128]);
    const up = resizeRgba(src.data, 16, 16, 32, 32);
    expect(up.length).toBe(32 * 32 * 4);
    expect(up[3]).toBe(255); // alpha forced opaque
  });
});

describe("Handy v1.3.0 — PNG row filtering", () => {
  const strategies: PngFilterStrategy[] = ["auto", "none", "sub", "up", "paeth"];

  it("round-trips losslessly with every filter strategy", () => {
    const src = makeFrame(48, 32, (x, y) => [(x * 5) % 256, (y * 9) % 256, ((x + y) * 3) % 256]);
    for (const filter of strategies) {
      const encoded = encodePng(48, 32, src.data, { filter });
      const decoded = decodePng(encoded);
      expect(decoded.width).toBe(48);
      expect(decoded.height).toBe(32);
      expect(Buffer.from(decoded.data).equals(Buffer.from(src.data))).toBe(true);
    }
  });

  it("collapses flat UI content far better than filtering every row as Sub", () => {
    // Large uniform areas with a few crisp rows: the case where identical-row -> Up pays off.
    const src = makeFrame(400, 300, (x, y) => {
      if (y === 10 || y === 200) return [15, 23, 42];
      if (x > 100 && x < 200 && y > 100 && y < 160) return [2, 132, 199];
      return [248, 250, 252];
    });
    const auto = encodePng(400, 300, src.data, { filter: "auto", compressionLevel: 6 });
    const sub = encodePng(400, 300, src.data, { filter: "sub", compressionLevel: 6 });
    const none = encodePng(400, 300, src.data, { filter: "none", compressionLevel: 6 });
    expect(auto.length).toBeLessThan(sub.length);
    expect(auto.length).toBeLessThan(none.length);
  });

  it("keeps alpha opaque and validates buffer length", () => {
    expect(() => encodePng(4, 4, new Uint8Array(8))).toThrow(/RGBA buffer too small/);
    expect(() => encodePng(0, 4, new Uint8Array(0))).toThrow(/Invalid PNG dimensions/);
  });
});

describe("Handy v1.3.0 — Frame diff fast path", () => {
  it("matches the unaligned-buffer fallback pixel for pixel", () => {
    const prev = buttonFrame(200, 120);
    const curr = buttonFrame(200, 120);
    // Paint a small change so there is something to find.
    for (let y = 40; y < 60; y++) {
      for (let x = 30; x < 70; x++) {
        const i = (y * 200 + x) * 4;
        curr.data[i] = 220;
        curr.data[i + 1] = 30;
        curr.data[i + 2] = 30;
      }
    }

    const aligned = computeFrameDiff(prev, curr)!;
    expect(aligned.changedPixels).toBeGreaterThan(0);
    expect(aligned.changedBounds).not.toBeNull();

    // Force the byte fallback by handing over a 1-byte-offset view of the same pixels.
    const padded = new Uint8Array(curr.data.length + 1);
    padded.set(curr.data, 1);
    const unalignedFrame: RawFrame = { ...curr, data: padded.subarray(1) };
    expect(unalignedFrame.data.byteOffset % 4).toBe(1);
    const fallback = computeFrameDiff(prev, unalignedFrame)!;

    expect(fallback.changedPixels).toBe(aligned.changedPixels);
    expect(fallback.changedPercent).toBe(aligned.changedPercent);
    expect(fallback.changedBounds).toEqual(aligned.changedBounds);
  });

  it("ignores alpha-only differences and honours the legacy numeric threshold argument", () => {
    const prev = makeFrame(40, 20, () => [100, 100, 100]);
    const curr = makeFrame(40, 20, () => [100, 100, 100]);
    for (let i = 3; i < curr.data.length; i += 4) curr.data[i] = 0; // alpha only
    expect(computeFrameDiff(prev, curr)!.changedPixels).toBe(0);

    const shifted = makeFrame(40, 20, () => [110, 100, 100]);
    expect(computeFrameDiff(prev, shifted, 5)!.changedPixels).toBe(40 * 20);
    expect(computeFrameDiff(prev, shifted, 20)!.changedPixels).toBe(0);
    expect(computeFrameDiff(prev, shifted, { channelDeltaThreshold: 5 })!.changedPixels).toBe(40 * 20);
  });

  it("skips bounds work when only the percentage is needed", () => {
    const prev = buttonFrame(200, 120);
    const curr = buttonFrame(200, 120);
    for (let i = 0; i < 400; i++) curr.data[i * 4] = 0;

    const withBounds = computeFrameDiff(prev, curr, { computeBounds: true })!;
    const withoutBounds = computeFrameDiff(prev, curr, { computeBounds: false })!;
    expect(withBounds.changedBounds).not.toBeNull();
    expect(withoutBounds.changedBounds).toBeNull();
    expect(withoutBounds.changedPixels).toBe(withBounds.changedPixels);
  });

  it("flags partial results when earlyExitPercent short-circuits the scan", () => {
    const prev = makeFrame(200, 200, () => [250, 250, 250]);
    const curr = makeFrame(200, 200, () => [10, 10, 10]); // 100% changed

    const full = computeFrameDiff(prev, curr)!;
    expect(full.partial).toBeUndefined();
    expect(full.changedPercent).toBe(100);

    const early = computeFrameDiff(prev, curr, { earlyExitPercent: 5, computeBounds: false })!;
    expect(early.partial).toBe(true);
    expect(early.changedPercent).toBeGreaterThanOrEqual(5);
    expect(early.changedPercent).toBeLessThanOrEqual(full.changedPercent);
  });

  it("returns null for incomparable frames and a zero diff for empty ones", () => {
    const a = buttonFrame(100, 100);
    const b = buttonFrame(120, 100);
    expect(computeFrameDiff(a, b)).toBeNull();
    const empty: RawFrame = { ...a, width: 0, height: 0, data: new Uint8Array(0) };
    expect(computeFrameDiff(empty, { ...empty })).toEqual({
      changedPercent: 0,
      changedPixels: 0,
      changedBounds: null,
    });
  });
});

describe("Handy v1.3.0 — Set-of-Mark UI element detection", () => {
  it("finds a filled button and reports its exact logical bounds and centre", () => {
    const elements = detectUiElements(buttonFrame());
    expect(elements.length).toBeGreaterThan(0);

    const button = elements.find((e) => e.kind === "control");
    expect(button).toBeDefined();
    expect(Math.abs(button!.centerX - 280)).toBeLessThanOrEqual(6);
    expect(Math.abs(button!.centerY - 175)).toBeLessThanOrEqual(6);
    expect(button!.score).toBeGreaterThan(0.4);
  });

  it("numbers marks 1..N in reading order and resolves them by index", () => {
    const frame = makeFrame(640, 400, (x, y) => {
      const inA = x >= 40 && x < 160 && y >= 40 && y < 90;
      const inB = x >= 40 && x < 160 && y >= 200 && y < 250;
      const inC = x >= 400 && x < 560 && y >= 120 && y < 170;
      if (inA || inB || inC) return [16, 185, 129];
      return [248, 250, 252];
    });

    const elements = detectUiElements(frame, { maxMarks: 20 });
    const boxes = elements.filter((e) => e.kind !== "text");
    expect(boxes.length).toBeGreaterThanOrEqual(3);

    const indices = elements.map((e) => e.index);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    expect(indices[0]).toBe(1);
    expect(new Set(indices).size).toBe(indices.length);

    // Reading order: the topmost box is #1 among the three buttons.
    const topButton = elements.find((e) => Math.abs(e.y - 40) < 14 && e.kind === "control")!;
    expect(topButton).toBeDefined();
    expect(resolveMarkCenter(elements, topButton.index)).toEqual({
      x: topButton.centerX,
      y: topButton.centerY,
    });
    expect(() => resolveMarkCenter(elements, 9999)).toThrow(/not available/);
  });

  it("detects every known control on the virtual desktop and ranks controls above text", async () => {
    const backend = new VirtualDesktopBackend();
    const captured = await backend.captureScreen();
    const L = VirtualDesktopBackend.LAYOUT;

    const elements = detectUiElements(captured, { maxMarks: 40 });
    expect(elements.length).toBeGreaterThan(0);

    for (const target of [L.submitButton, L.counterButton, L.clearButton, L.nameInput, L.notesInput, L.scrollBox]) {
      const match = findByBox(elements, target);
      expect(match, `expected a mark near ${JSON.stringify(target)}`).toBeDefined();
    }

    const controls = elements.filter((e) => e.kind === "control");
    const texts = elements.filter((e) => e.kind === "text");
    expect(controls.length).toBeGreaterThanOrEqual(3);
    const bestControl = Math.max(...controls.map((e) => e.score));
    const bestText = texts.length > 0 ? Math.max(...texts.map((e) => e.score)) : 0;
    expect(bestControl).toBeGreaterThan(bestText);
  });

  it("maps HiDPI frames back into logical screen coordinates", () => {
    // Physical 2x capture of a 400x300 logical screen with a button at logical (150,100)-(250,150).
    const frame = makeFrame(
      800,
      600,
      (x, y) => {
        const inButton = x >= 300 && x < 500 && y >= 200 && y < 300;
        return inButton ? [220, 38, 38] : [250, 250, 250];
      },
      { logicalWidth: 400, logicalHeight: 300, scaleFactor: 2 },
    );

    const elements = detectUiElements(frame);
    const button = elements.find((e) => e.kind === "control");
    expect(button).toBeDefined();
    // Reported in logical space, i.e. roughly half the physical pixel coordinates.
    expect(Math.abs(button!.centerX - 200)).toBeLessThanOrEqual(8);
    expect(Math.abs(button!.centerY - 125)).toBeLessThanOrEqual(8);
    expect(button!.width).toBeLessThan(400);
  });

  it("offsets detected bounds by the frame origin for window/region captures", () => {
    const frame = makeFrame(
      300,
      200,
      (x, y) => (x >= 100 && x < 220 && y >= 60 && y < 110 ? [37, 99, 235] : [245, 245, 245]),
      { originX: 720, originY: 310 },
    );
    const elements = detectUiElements(frame);
    const button = elements.find((e) => e.kind === "control");
    expect(button).toBeDefined();
    // Global logical coords: origin (720,310) + local ~(160,85) = ~(880,395)
    expect(Math.abs(button!.centerX - 880)).toBeLessThanOrEqual(10);
    expect(Math.abs(button!.centerY - 395)).toBeLessThanOrEqual(10);
  });

  it("honours maxMarks, kind filtering, minScore, and searchRegion", () => {
    const frame = makeFrame(640, 400, (x, y) => {
      const boxes: Array<[number, number, number, number]> = [
        [40, 40, 160, 90],
        [40, 200, 160, 250],
        [400, 40, 520, 90],
        [400, 200, 520, 250],
      ];
      for (const [x0, y0, x1, y1] of boxes) {
        if (x >= x0 && x < x1 && y >= y0 && y < y1) return [16, 185, 129];
      }
      return [248, 250, 252];
    });

    expect(detectUiElements(frame, { maxMarks: 2 }).length).toBeLessThanOrEqual(2);
    expect(detectUiElements(frame, { kinds: ["icon"] }).every((e) => e.kind === "icon")).toBe(true);
    expect(detectUiElements(frame, { minScore: 0.99 })).toEqual([]);

    // Restricting to the left half must not report the right-hand boxes.
    const leftOnly = detectUiElements(frame, { searchRegion: { x: 0, y: 0, width: 300, height: 400 } });
    expect(leftOnly.length).toBeGreaterThan(0);
    expect(leftOnly.every((e) => e.x + e.width <= 320)).toBe(true);
  });

  it("returns nothing for photographic noise instead of churning (safety valve)", () => {
    const width = 400;
    const height = 300;
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = (i * 7919) % 256;
      data[i + 1] = (i * 104729) % 256;
      data[i + 2] = (i * 15485863) % 256;
      data[i + 3] = 255;
    }
    const frame: RawFrame = {
      width,
      height,
      data,
      originX: 0,
      originY: 0,
      logicalWidth: width,
      logicalHeight: height,
      scaleFactor: 1,
      displayId: 0,
    };
    expect(detectUiElements(frame)).toEqual([]);
  });

  it("tolerates degenerate frames", () => {
    expect(detectUiElements(makeFrame(4, 4, () => [255, 255, 255]))).toEqual([]);
    const empty: RawFrame = {
      width: 0,
      height: 0,
      data: new Uint8Array(0),
      originX: 0,
      originY: 0,
      logicalWidth: 0,
      logicalHeight: 0,
      scaleFactor: 1,
      displayId: 0,
    };
    expect(detectUiElements(empty)).toEqual([]);
  });
});

describe("Handy v1.3.0 — Mark overlay rendering", () => {
  it("draws numbered mark badges without clipping at any corner", () => {
    const w = 640;
    const h = 400;
    const corners: UiElement[] = [
      { index: 1, x: 0, y: 0, width: 60, height: 30, centerX: 30, centerY: 15, score: 0.9, kind: "control" },
      { index: 2, x: w - 60, y: 0, width: 60, height: 30, centerX: w - 30, centerY: 15, score: 0.9, kind: "text" },
      { index: 3, x: 0, y: h - 30, width: 60, height: 30, centerX: 30, centerY: h - 15, score: 0.9, kind: "icon" },
      { index: 4, x: w - 60, y: h - 30, width: 60, height: 30, centerX: w - 30, centerY: h - 15, score: 0.9, kind: "region" },
    ];

    const buf = new Uint8Array(w * h * 4).fill(255);
    expect(() =>
      renderScreenOverlay(buf, w, h, {
        originX: 0,
        originY: 0,
        logicalWidth: w,
        logicalHeight: h,
        mouse: { x: 10, y: 10 },
        grid: true,
        showMouse: true,
        marks: corners,
      }),
    ).not.toThrow();

    // The violet control outline must have overwritten the white background somewhere on its box.
    let painted = 0;
    for (let i = 0; i < buf.length; i += 4) {
      if (buf[i + 2]! > buf[i]! && buf[i + 2]! > 150) painted++;
    }
    expect(painted).toBeGreaterThan(0);
  });

  it("renders marks through the controller and returns them in the result", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "handy-v13-overlay-"));
    const backend = new VirtualDesktopBackend();
    const controller = new HandyController({ backend, permissions: new PermissionStore({ configDir }) });
    try {
      const plain = await controller.see();
      expect(plain.elements).toBeUndefined();

      const marked = await controller.see({ marks: true });
      expect(marked.elements).toBeDefined();
      expect(marked.elements!.length).toBeGreaterThan(0);
      expect(controller.detectedElements).toEqual(marked.elements);
      expect(marked.pngBuffer.length).toBeGreaterThan(0);
    } finally {
      await controller.close();
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

describe("Handy v1.3.0 — Acting on detected marks", () => {
  let configDir: string;
  let backend: VirtualDesktopBackend;
  let controller: HandyController;

  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), "handy-v13-marks-"));
    backend = new VirtualDesktopBackend();
    controller = new HandyController({ backend, permissions: new PermissionStore({ configDir }) });
    await controller.init();
  });

  afterEach(async () => {
    await controller.close();
    rmSync(configDir, { recursive: true, force: true });
  });

  it("clicks a detected field by mark, types, and submits by mark", async () => {
    const L = VirtualDesktopBackend.LAYOUT;
    const shot = await controller.see({ marks: true });
    const nameMark = findByBox(shot.elements!, L.nameInput)!;
    const submitMark = findByBox(shot.elements!, L.submitButton)!;
    expect(nameMark).toBeDefined();
    expect(submitMark).toBeDefined();

    const res = await controller.act({
      actions: [
        { type: "click", mark: nameMark.index },
        { type: "type", text: "MarkDriven" },
        { type: "click", mark: submitMark.index },
      ],
      stepDelayMs: 2,
    });

    expect(res.stepsCompleted).toBe(3);
    expect(backend.state.fields.name).toBe("MarkDriven");
    expect(backend.state.submittedValue).toBe("MarkDriven");
    expect(res.receipts[0]!.detail).toContain(`mark #${nameMark.index}`);
  });

  it("moves, double-clicks, scrolls, and presses by mark", async () => {
    const L = VirtualDesktopBackend.LAYOUT;
    const shot = await controller.see({ marks: true });
    const nameMark = findByBox(shot.elements!, L.nameInput)!;
    const logMark = findByBox(shot.elements!, L.scrollBox)!;

    await controller.act({
      actions: [{ type: "move", mark: nameMark.index }],
      stepDelayMs: 2,
    });
    expect(Math.abs(backend.state.cardPosition.x)).toBeGreaterThan(0); // sanity: state alive
    const mouse = await backend.getMousePosition();
    expect(mouse).toEqual({ x: nameMark.centerX, y: nameMark.centerY });

    await controller.act({
      actions: [
        { type: "click", mark: nameMark.index },
        { type: "type", text: "SelectMe" },
        { type: "double_click", mark: nameMark.index },
        { type: "key", key: "Backspace" },
      ],
      stepDelayMs: 2,
    });
    // double_click selects all, so Backspace clears the field
    expect(backend.state.fields.name).toBe("");

    const before = backend.state.scrollOffset;
    await controller.act({
      actions: [{ type: "scroll", mark: logMark.index, direction: "down", amount: 4 }],
      stepDelayMs: 2,
    });
    expect(backend.state.scrollOffset).toBeGreaterThan(before);
    expect(await backend.getMousePosition()).toEqual({ x: logMark.centerX, y: logMark.centerY });
  });

  it("drags a card between two detected marks", async () => {
    const L = VirtualDesktopBackend.LAYOUT;
    const shot = await controller.see({ marks: true });
    const cardMark = findByBox(
      shot.elements!,
      { ...L.cardSize, x: backend.state.cardPosition.x, y: backend.state.cardPosition.y },
    )!;
    const logMark = findByBox(shot.elements!, L.scrollBox)!;
    expect(cardMark).toBeDefined();
    expect(logMark).toBeDefined();

    const start = { ...backend.state.cardPosition };
    const res = await controller.act({
      actions: [{ type: "drag", fromMark: cardMark.index, toMark: logMark.index, durationMs: 40, steps: 6 }],
      stepDelayMs: 2,
    });

    expect(res.stepsCompleted).toBe(1);
    expect(res.receipts[0]!.detail).toContain("dragged mark");
    expect(backend.state.cardPosition).not.toEqual(start);
  });

  it("rejects an out-of-range mark with an actionable error listing what is available", async () => {
    await controller.see({ marks: true });
    await expect(controller.act({ actions: [{ type: "click", mark: 9999 }] })).rejects.toThrow(/not available/);
  });

  it("rejects a mark when no marked capture has been taken yet", async () => {
    await expect(controller.act({ actions: [{ type: "click", mark: 1 }] })).rejects.toThrow(
      /no detected UI elements are available/i,
    );
  });

  it("rejects malformed pointer steps that supply neither coordinates nor a mark", async () => {
    await expect(controller.act({ actions: [{ type: "move" } as never] })).rejects.toThrow(
      /requires either \{ x, y \} or \{ mark \}/,
    );
    await expect(controller.act({ actions: [{ type: "move", relative: true, x: 5 } as never] })).rejects.toThrow(
      /relative move step requires both x and y/,
    );
    await expect(
      controller.act({ actions: [{ type: "drag", fromX: 10, fromY: 10 } as never] }),
    ).rejects.toThrow(/requires either \{ toX, toY \} or \{ toMark \}/);
  });

  it("reports verifyChange truthfully for both a mutating and an inert chain", async () => {
    const L = VirtualDesktopBackend.LAYOUT;
    const mutating = await controller.act({
      actions: [{ type: "click", x: L.counterButton.x + 10, y: L.counterButton.y + 10 }],
      stepDelayMs: 2,
      verifyChange: true,
    });
    expect(mutating.changed).toBe(true);
    expect(mutating.change!.changedPixels).toBeGreaterThan(0);

    const inert = await controller.act({
      actions: [{ type: "wait", ms: 5 }],
      stepDelayMs: 2,
      verifyChange: true,
    });
    expect(inert.changed).toBe(false);
    expect(inert.change!.changedPixels).toBe(0);

    const notRequested = await controller.act({ actions: [{ type: "wait", ms: 1 }] });
    expect(notRequested.change).toBeUndefined();
    expect(notRequested.changed).toBeUndefined();
  });
});

describe("Handy v1.3.0 — Pointer motion profiles", () => {
  it("scales travel time with distance per Fitts's law and clamps the extremes", () => {
    expect(fittsDurationMs({ x: 0, y: 0 }, { x: 1, y: 0 })).toBe(0);
    const near = fittsDurationMs({ x: 0, y: 0 }, { x: 60, y: 0 });
    const far = fittsDurationMs({ x: 0, y: 0 }, { x: 1800, y: 0 });
    expect(far).toBeGreaterThan(near);
    expect(fittsDurationMs({ x: 0, y: 0 }, { x: 100000, y: 100000 })).toBeLessThanOrEqual(1200);
    // Smaller targets take longer to acquire.
    expect(fittsDurationMs({ x: 0, y: 0 }, { x: 500, y: 0 }, 8)).toBeGreaterThan(
      fittsDurationMs({ x: 0, y: 0 }, { x: 500, y: 0 }, 120),
    );
  });

  it("travels along a straight line for linear motion and bows for human motion", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "handy-v13-motion-"));
    const backend = new VirtualDesktopBackend();
    const controller = new HandyController({ backend, permissions: new PermissionStore({ configDir }) });
    await controller.init();

    const START = { x: 900, y: 200 };
    const TARGET = { x: 200, y: 600 };

    const record = async (motion: "linear" | "human") => {
      // Reset outside the spy so every run travels the same distance from the same origin.
      await backend.moveMouse(START.x, START.y);
      const from = await backend.getMousePosition();

      const seen: Array<{ x: number; y: number }> = [];
      const inner = backend.moveMouse.bind(backend);
      backend.moveMouse = async (x: number, y: number) => {
        seen.push({ x, y });
        await inner(x, y);
      };
      try {
        await controller.act({
          actions: [{ type: "move", x: TARGET.x, y: TARGET.y, durationMs: 120, steps: 24, motion }],
          stepDelayMs: 0,
          failsafe: false,
        });
      } finally {
        backend.moveMouse = inner;
      }
      return { from, seen };
    };

    try {
      const linearRun = await record("linear");
      const humanRun = await record("human");
      const straight = linearRun.seen;
      const bowed = humanRun.seen;
      expect(straight.length).toBeGreaterThan(5);
      expect(bowed.length).toBeGreaterThan(5);
      expect(linearRun.from).toEqual(TARGET.x === START.x ? TARGET : START);

      // Perpendicular distance from the ideal straight line between the run's endpoints.
      const deviation = (path: Array<{ x: number; y: number }>, from: { x: number; y: number }) => {
        const ax = from.x;
        const ay = from.y;
        const bx = TARGET.x;
        const by = TARGET.y;
        const len = Math.hypot(bx - ax, by - ay);
        let max = 0;
        for (const p of path) {
          const d = Math.abs((bx - ax) * (ay - p.y) - (ax - p.x) * (by - ay)) / len;
          if (d > max) max = d;
        }
        return max;
      };

      expect(deviation(straight, linearRun.from)).toBeLessThan(1.5);
      expect(deviation(bowed, humanRun.from)).toBeGreaterThan(1.5);
      // Both must actually arrive at the requested target.
      expect(straight[straight.length - 1]).toEqual(TARGET);
      expect(bowed[bowed.length - 1]).toEqual(TARGET);
    } finally {
      await controller.close();
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("derives a Fitts's-law duration automatically for human motion without durationMs", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "handy-v13-fitts-"));
    const backend = new VirtualDesktopBackend();
    const controller = new HandyController({ backend, permissions: new PermissionStore({ configDir }) });
    await controller.init();
    try {
      const res = await controller.act({
        actions: [{ type: "move", x: 1200, y: 700, motion: "human" }],
        stepDelayMs: 0,
        failsafe: false,
      });
      expect(res.stepsCompleted).toBe(1);
      // Interpolated travel should have taken a measurable, bounded amount of time.
      expect(res.receipts[0]!.durationMs).toBeGreaterThan(20);
      expect(res.receipts[0]!.durationMs).toBeLessThan(2000);
      expect(await backend.getMousePosition()).toEqual({ x: 1200, y: 700 });
    } finally {
      await controller.close();
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

describe("Handy v1.3.0 — Backend capability detection & display resolution", () => {
  it("uses nativeClickCount instead of an instanceof check for multi-clicks", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "handy-v13-cap-"));
    const backend = new VirtualDesktopBackend();
    const seen: Array<{ button: string; clickCount?: number }> = [];
    const innerDown = backend.mouseDown.bind(backend);
    // A plain (non-Darwin) backend that nonetheless advertises native click-count support.
    (backend as unknown as { nativeClickCount: boolean }).nativeClickCount = true;
    backend.mouseDown = async (button: MouseButton, clickCount?: number) => {
      seen.push({ button, clickCount });
      await innerDown(button, clickCount);
    };

    const controller = new HandyController({ backend, permissions: new PermissionStore({ configDir }) });
    await controller.init();
    try {
      await controller.act({ actions: [{ type: "triple_click", x: 300, y: 500 }], stepDelayMs: 0 });
      expect(seen).toHaveLength(3);
      expect(seen.map((s) => s.clickCount)).toEqual([1, 2, 3]);
    } finally {
      await controller.close();
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("falls back through id, positional index, then primary when resolving a display", () => {
    const displays: DisplayInfo[] = [
      { id: 7, name: "a", x: 0, y: 0, width: 100, height: 100, scaleFactor: 1, primary: false },
      { id: 9, name: "b", x: 100, y: 0, width: 200, height: 100, scaleFactor: 1, primary: true },
    ];
    expect(pickDisplay(displays, 7)?.name).toBe("a");
    expect(pickDisplay(displays, 9)?.name).toBe("b");
    // No display carries id 1: fall back to positional index 1, then to primary.
    expect(pickDisplay(displays, 1)?.name).toBe("b"); // positional index 1
    expect(pickDisplay(displays, 99)?.name).toBe("b"); // out of range -> primary
    expect(pickDisplay(displays)?.name).toBe("a"); // default index 0 -> first display
    expect(pickDisplay([])).toBeUndefined();
  });
});

describe("Handy v1.3.0 — Control Panel mark support (real HTTP on loopback)", () => {
  it("serves marks through /api/see and exposes them in the panel HTML", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "handy-v13-ui-"));
    const backend = new VirtualDesktopBackend();
    const controller = new HandyController({ backend, permissions: new PermissionStore({ configDir }) });
    const panel = await startControlPanel({ port: 0, controller });

    try {
      const headers = { "x-handy-token": panel.token };

      const plain = (await (
        await fetch(`http://127.0.0.1:${panel.port}/api/see`, { headers })
      ).json()) as { ok: boolean; elements: UiElement[] | null };
      expect(plain.ok).toBe(true);
      expect(plain.elements).toBeNull();

      const marked = (await (
        await fetch(`http://127.0.0.1:${panel.port}/api/see?marks=1`, { headers })
      ).json()) as { ok: boolean; elements: UiElement[] | null; base64Png: string };
      expect(marked.ok).toBe(true);
      expect(Array.isArray(marked.elements)).toBe(true);
      expect(marked.elements!.length).toBeGreaterThan(0);
      expect(marked.base64Png.length).toBeGreaterThan(0);

      // The served page must wire the toggle and the mark-aware click handler.
      const html = await (await fetch(`http://127.0.0.1:${panel.port}/?token=${panel.token}`)).text();
      expect(html).toContain('id="marksToggle"');
      expect(html).toContain('id="marksCard"');
      expect(html).toContain('id="mMarks"');
      expect(html).toContain("click mark ");
      expect(html).toContain("function markAt");

      // A chained click by mark through the panel's own /api/act endpoint must land.
      const L = VirtualDesktopBackend.LAYOUT;
      const submitMark = findByBox(marked.elements!, L.submitButton)!;
      expect(submitMark).toBeDefined();
      const nameMark = findByBox(marked.elements!, L.nameInput)!;
      expect(nameMark).toBeDefined();

      const acted = (await (
        await fetch(`http://127.0.0.1:${panel.port}/api/act`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            chain: `click mark ${nameMark.index} -> type "PanelMark" -> click mark ${submitMark.index}`,
          }),
        })
      ).json()) as { ok: boolean };
      expect(acted.ok).toBe(true);
      expect(backend.state.submittedValue).toBe("PanelMark");
    } finally {
      await panel.close();
      await controller.close();
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("rejects panel requests that omit the bearer token", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "handy-v13-ui-auth-"));
    const backend = new VirtualDesktopBackend();
    const controller = new HandyController({ backend, permissions: new PermissionStore({ configDir }) });
    const panel = await startControlPanel({ port: 0, controller });
    try {
      const res = await fetch(`http://127.0.0.1:${panel.port}/api/see?marks=1`);
      // The panel rejects a missing/incorrect token with 403 before touching the controller.
      expect(res.status).toBe(403);
    } finally {
      await panel.close();
      await controller.close();
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

describe("Handy v1.3.0 — Chain DSL mark references & argument validation", () => {
  it("parses mark targets for every pointer step", () => {
    expect(parseChainInput("move mark 3")).toEqual([{ type: "move", mark: 3 }]);
    expect(parseChainInput("click mark 5")).toEqual([{ type: "click", mark: 5 }]);
    expect(parseChainInput("double_click mark 5")).toEqual([{ type: "double_click", mark: 5 }]);
    expect(parseChainInput("triple_click mark 5")).toEqual([{ type: "triple_click", mark: 5 }]);
    expect(parseChainInput("right_click mark 5")).toEqual([{ type: "right_click", mark: 5 }]);
    expect(parseChainInput("scroll down 4 mark 9")).toEqual([{ type: "scroll", direction: "down", amount: 4, mark: 9 }]);
    // Compact aliases, and amount omitted so the mark is not mistaken for one.
    expect(parseChainInput("click #12")).toEqual([{ type: "click", mark: 12 }]);
    expect(parseChainInput("click m 12")).toEqual([{ type: "click", mark: 12 }]);
    expect(parseChainInput("scroll down mark 9")).toEqual([{ type: "scroll", direction: "down", amount: 3, mark: 9 }]);
  });

  it("parses drag endpoints as coordinates, marks, or a mix", () => {
    expect(parseChainInput("drag 100 200 300 400")).toEqual([
      { type: "drag", fromX: 100, fromY: 200, toX: 300, toY: 400 },
    ]);
    expect(parseChainInput("drag 300 400")).toEqual([{ type: "drag", toX: 300, toY: 400 }]);
    expect(parseChainInput("drag mark 3 mark 7")).toEqual([{ type: "drag", fromMark: 3, toMark: 7 }]);
    expect(parseChainInput("drag mark 3 300 400")).toEqual([{ type: "drag", fromMark: 3, toX: 300, toY: 400 }]);
    expect(parseChainInput("drag 100 200 mark 7")).toEqual([{ type: "drag", fromX: 100, fromY: 200, toMark: 7 }]);
    expect(parseChainInput("drag mark 7")).toEqual([{ type: "drag", toMark: 7 }]);
  });

  it("still parses pre-existing coordinate forms, including the comma shorthand", () => {
    expect(parseChainInput("click 400 300")).toEqual([{ type: "click", x: 400, y: 300 }]);
    expect(parseChainInput("click 400,300")).toEqual([{ type: "click", x: 400, y: 300 }]);
    expect(parseChainInput("move 10,20")).toEqual([{ type: "move", x: 10, y: 20 }]);
    // A bare click acts at the current cursor position.
    expect(parseChainInput("click")).toEqual([{ type: "click" }]);
    expect(parseChainInput("scroll down")).toEqual([{ type: "scroll", direction: "down", amount: 3 }]);
    expect(parseChainInput("scroll 5 10")).toEqual([{ type: "scroll", deltaX: 5, deltaY: 10 }]);
  });

  it("rejects malformed targets instead of silently acting at the cursor", () => {
    // Before this change `click mark 5` parsed as a bare click and quietly clicked the wrong place.
    expect(() => parseChainInput("click mark")).toThrow(/mark index of 1 or more/);
    expect(() => parseChainInput("click mark 0")).toThrow(/mark index of 1 or more/);
    expect(() => parseChainInput("click mark abc")).toThrow(/mark index of 1 or more/);
    expect(() => parseChainInput("click 12")).toThrow(/Invalid click step/);
    expect(() => parseChainInput("click maybe here")).toThrow(/Invalid click step/);
    expect(() => parseChainInput("move")).toThrow(/Invalid move step/);
    expect(() => parseChainInput("click 100 200 300")).toThrow(/Unexpected trailing argument/);
    expect(() => parseChainInput("drag 100 200 300")).toThrow(/Invalid drag step/);
    expect(() => parseChainInput("drag")).toThrow(/Invalid drag step/);
    expect(() => parseChainInput("drag mark 1 mark 2 mark 3")).toThrow(/Invalid drag step/);
    expect(() => parseChainInput("scroll down 3 mark")).toThrow(/mark index of 1 or more/);
    expect(() => parseChainInput("scroll down 3 400")).toThrow(/Unexpected trailing argument/);
  });

  it("reports the offending segment text in every parse error", () => {
    expect(() => parseChainInput('type "hi" -> click bogus')).toThrow(/click bogus/);
  });

  it("executes a whole mark-driven chain parsed from text, end to end", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "handy-v13-dsl-"));
    const backend = new VirtualDesktopBackend();
    const controller = new HandyController({ backend, permissions: new PermissionStore({ configDir }) });
    await controller.init();
    try {
      const L = VirtualDesktopBackend.LAYOUT;
      const shot = await controller.see({ marks: true });
      const nameMark = findByBox(shot.elements!, L.nameInput)!;
      const submitMark = findByBox(shot.elements!, L.submitButton)!;

      const res = await controller.act({
        actions: parseChainInput(
          `click mark ${nameMark.index} -> type "DslMark" -> click mark ${submitMark.index}`,
        ),
        stepDelayMs: 2,
      });

      expect(res.stepsCompleted).toBe(3);
      expect(backend.state.submittedValue).toBe("DslMark");
    } finally {
      await controller.close();
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
