import { describe, expect, it } from "vitest";
import { detectUiElements } from "../src/marks.js";
import type { RawFrame, UiElement } from "../src/types.js";

/**
 * The virtual desktop used by the other suites is a light, flat, sharp-cornered synthetic scene.
 * Real UIs are dark-themed, gradient-filled, drop-shadowed, rounded, and anti-aliased, so these
 * tests exercise detection against styles the happy-path fixtures never produce.
 */

const W = 900;
const H = 620;

function frameOf(paint: (x: number, y: number) => [number, number, number]): RawFrame {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b] = paint(x, y);
      const i = (y * W + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return {
    width: W,
    height: H,
    data,
    originX: 0,
    originY: 0,
    logicalWidth: W,
    logicalHeight: H,
    scaleFactor: 1,
    displayId: 0,
  };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const inRect = (x: number, y: number, r: { x: number; y: number; w: number; h: number }) =>
  x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

/** Rounded-box coverage, so corners are genuinely curved rather than notched. */
function rounded(x: number, y: number, r: { x: number; y: number; w: number; h: number }, radius: number): boolean {
  if (x < r.x || x >= r.x + r.w || y < r.y || y >= r.y + r.h) return false;
  const cx = Math.max(r.x + radius, Math.min(x, r.x + r.w - radius));
  const cy = Math.max(r.y + radius, Math.min(y, r.y + r.h - radius));
  if (cx === x || cy === y) return true;
  return Math.hypot(x - cx, y - cy) <= radius;
}

// Minimal 6x7 stroke font: enough to give "text" real glyph edges with interior holes.
const GLYPHS: Record<string, string[]> = {
  S: ["011110", "100001", "100000", "011110", "000001", "100001", "011110"],
  U: ["100001", "100001", "100001", "100001", "100001", "100001", "011110"],
  B: ["111110", "100001", "100001", "111110", "100001", "100001", "111110"],
  M: ["100001", "110011", "101101", "100001", "100001", "100001", "100001"],
  I: ["011110", "001100", "001100", "001100", "001100", "001100", "011110"],
  T: ["111111", "001100", "001100", "001100", "001100", "001100", "001100"],
  C: ["011110", "100001", "100000", "100000", "100000", "100001", "011110"],
  A: ["011110", "100001", "100001", "111111", "100001", "100001", "100001"],
  N: ["100001", "110001", "101001", "100101", "100011", "100001", "100001"],
  L: ["100000", "100000", "100000", "100000", "100000", "100000", "111111"],
  D: ["111110", "100001", "100001", "100001", "100001", "100001", "111110"],
  E: ["111111", "100000", "100000", "111110", "100000", "100000", "111111"],
  O: ["011110", "100001", "100001", "100001", "100001", "100001", "011110"],
  P: ["111110", "100001", "100001", "111110", "100000", "100000", "100000"],
  R: ["111110", "100001", "100001", "111110", "100100", "100010", "100001"],
  V: ["100001", "100001", "100001", "100001", "100001", "010010", "001100"],
  G: ["011110", "100001", "100000", "100111", "100001", "100001", "011110"],
  H: ["100001", "100001", "100001", "111111", "100001", "100001", "100001"],
  K: ["100001", "100010", "100100", "111000", "100100", "100010", "100001"],
  F: ["111111", "100000", "100000", "111110", "100000", "100000", "100000"],
  W: ["100001", "100001", "100001", "100001", "101101", "110011", "100001"],
  Y: ["100001", "100001", "010010", "001100", "001100", "001100", "001100"],
  X: ["100001", "100001", "010010", "001100", "010010", "100001", "100001"],
  " ": ["000000", "000000", "000000", "000000", "000000", "000000", "000000"],
};

/** Paints `text` into `data` at 2x scale, returning the advance width. */
function drawText(
  data: Uint8Array,
  x0: number,
  y0: number,
  text: string,
  color: [number, number, number],
  scale = 2,
): number {
  let cx = x0;
  for (const ch of text.toUpperCase()) {
    const glyph = GLYPHS[ch] ?? GLYPHS[" "]!;
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 6; col++) {
        if (glyph[row]![col] !== "1") continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const X = cx + col * scale + dx;
            const Y = y0 + row * scale + dy;
            if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
            const i = (Y * W + X) * 4;
            data[i] = color[0];
            data[i + 1] = color[1];
            data[i + 2] = color[2];
          }
        }
      }
    }
    cx += 7 * scale;
  }
  return cx - x0;
}

function strokeRect(
  data: Uint8Array,
  r: { x: number; y: number; w: number; h: number },
  color: [number, number, number],
): void {
  const put = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    data[i] = color[0];
    data[i + 1] = color[1];
    data[i + 2] = color[2];
  };
  for (let x = r.x; x < r.x + r.w; x++) {
    put(x, r.y);
    put(x, r.y + r.h - 1);
  }
  for (let y = r.y; y < r.y + r.h; y++) {
    put(r.x, y);
    put(r.x + r.w - 1, y);
  }
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The tightest detected box containing the target's centre. Elements are numbered in reading
 * order, so a naive `find` returns whichever container happens to sort first — and a button's
 * centre is also inside the card it sits on. Picking the smallest area matches what an agent
 * actually wants (the innermost target) and mirrors `markAt` in the Control Panel.
 */
function centreHit(elements: UiElement[], target: Rect): UiElement | undefined {
  const cx = target.x + target.w / 2;
  const cy = target.y + target.h / 2;
  let best: UiElement | undefined;
  for (const e of elements) {
    if (cx < e.x || cx > e.x + e.width || cy < e.y || cy > e.y + e.height) continue;
    if (!best || e.width * e.height < best.width * best.height) best = e;
  }
  return best;
}

/** Text marks lying vertically inside `r` — used to assert a caption was suppressed. */
function textsInside(elements: UiElement[], r: Rect): UiElement[] {
  return elements.filter((e) => e.kind === "text" && e.y > r.y && e.y < r.y + r.h);
}

describe("Marks — realistic UI styles beyond the synthetic light desktop", () => {
  it("detects dark-theme controls, including a borderless one, at full recall", () => {
    const panel = { x: 520, y: 100, w: 330, h: 420 };
    const nameInput = { x: 60, y: 150, w: 380, h: 40 };
    const primary = { x: 60, y: 400, w: 170, h: 46 };
    const secondary = { x: 250, y: 400, w: 170, h: 46 };

    const frame = frameOf((x, y) => {
      if (inRect(x, y, primary)) return [59, 130, 246];
      if (inRect(x, y, nameInput)) return [17, 18, 22];
      if (inRect(x, y, secondary)) return [45, 47, 54];
      if (inRect(x, y, panel)) return [32, 34, 40];
      return [24, 26, 30];
    });
    // Dark UIs separate surfaces with 1px hairlines rather than fills or shadows.
    strokeRect(frame.data, panel, [58, 60, 68]);
    strokeRect(frame.data, nameInput, [70, 72, 82]);
    strokeRect(frame.data, secondary, [70, 72, 82]);
    drawText(frame.data, 95, 415, "SUBMIT", [255, 255, 255]);
    drawText(frame.data, 285, 415, "CANCEL", [200, 202, 210]);
    drawText(frame.data, 70, 110, "DARK SETTINGS", [225, 228, 235]);
    drawText(frame.data, 72, 162, "USERNAME", [140, 145, 158]);

    const elements = detectUiElements(frame, { maxMarks: 60 });
    for (const target of [panel, nameInput, primary, secondary]) {
      expect(centreHit(elements, target), `missed ${JSON.stringify(target)}`).toBeDefined();
    }
    // The accent button is a control, and the panel it sits beside is a region.
    expect(centreHit(elements, primary)!.kind).toBe("control");
    expect(centreHit(elements, panel)!.kind).toBe("region");
    expect(centreHit(elements, nameInput)!.kind).toBe("control");
  });

  it("detects a rounded, gradient-filled, drop-shadowed card and its button", () => {
    const card = { x: 300, y: 180, w: 300, h: 220 };
    const button = { x: 340, y: 330, w: 220, h: 48 };

    const frame = frameOf((x, y) => {
      // Diagonal gradient background: no flat region and low global contrast anywhere.
      const t = (x / W + y / H) / 2;
      let c: [number, number, number] = [lerp(238, 205, t), lerp(242, 225, t), lerp(250, 245, t)];
      // Soft drop shadow behind the card, quadratic falloff over 26px.
      const sx = Math.max(card.x, Math.min(x, card.x + card.w));
      const sy = Math.max(card.y, Math.min(y, card.y + card.h));
      const sd = Math.hypot(x - sx, y - sy);
      if (sd < 26 && !rounded(x, y, card, 14)) {
        const k = 1 - sd / 26;
        c = [c[0] - 46 * k * k, c[1] - 48 * k * k, c[2] - 52 * k * k];
      }
      // Innermost layer first: the button lives inside the card's bounds, so testing the card
      // first would early-return white and never paint the button at all.
      if (rounded(x, y, button, 24)) {
        const bt = (x - button.x) / button.w;
        return [lerp(99, 79, bt), lerp(102, 70, bt), lerp(241, 229, bt)];
      }
      if (rounded(x, y, card, 14)) return [255, 255, 255];
      return c;
    });
    drawText(frame.data, 320, 200, "PROFILE CARD", [40, 44, 55]);
    drawText(frame.data, 320, 240, "ROUNDED AND SHADOWED", [110, 116, 130]);
    drawText(frame.data, 385, 345, "SAVE CHANGES", [255, 255, 255]);

    const elements = detectUiElements(frame, { maxMarks: 60 });
    expect(centreHit(elements, card)).toBeDefined();
    const buttonHit = centreHit(elements, button);
    expect(buttonHit).toBeDefined();
    expect(buttonHit!.kind).toBe("control");
  });

  it("finds a borderless flat link from glyph colour alone", () => {
    // No box, no border, no fill: only the link's colour differs from the background.
    const frame = frameOf(() => [250, 250, 252]);
    const link = { x: 80, y: 200, w: 180, h: 22 };
    drawText(frame.data, link.x, link.y, "FORGOT PASSWORD", [37, 99, 235]);
    drawText(frame.data, 80, 300, "PLAIN BODY TEXT HERE", [60, 62, 70]);

    const elements = detectUiElements(frame, { maxMarks: 60 });
    expect(centreHit(elements, link)).toBeDefined();
    // Both lines are text; neither should be promoted to a control.
    expect(elements.every((e) => e.kind === "text")).toBe(true);
  });

  it("resolves every icon in a dense toolbar as a separate mark", () => {
    const icons = Array.from({ length: 8 }, (_, n) => ({ x: 40 + n * 46, y: 60, w: 34, h: 34 }));
    const frame = frameOf((x, y) => {
      for (let n = 0; n < icons.length; n++) {
        const r = icons[n]!;
        if (!inRect(x, y, r)) continue;
        // Distinct per-icon pattern so these are not eight copies of one blob.
        const on = ((x - r.x + (y - r.y) + n * 3) % 7) < 3;
        return on ? [71, 85, 105] : [203, 213, 225];
      }
      return y >= 48 && y < 106 ? [243, 244, 246] : [255, 255, 255];
    });

    const elements = detectUiElements(frame, { maxMarks: 60 });
    for (const icon of icons) {
      const hit = centreHit(elements, icon);
      expect(hit, `missed icon at ${icon.x},${icon.y}`).toBeDefined();
      expect(hit!.kind).toBe("icon");
    }
    // Adjacent icons must not merge into one mark.
    expect(new Set(elements.map((e) => e.index)).size).toBeGreaterThanOrEqual(icons.length);
  });
});

describe("Marks — caption suppression inside controls", () => {
  /** Button with a centred label; the label is a separate high-contrast component. */
  function labelledButton(labelColor: [number, number, number], fillColor: [number, number, number]) {
    const button = { x: 340, y: 300, w: 220, h: 54 };
    const frame = frameOf((x, y) => (inRect(x, y, button) ? fillColor : [248, 250, 252]));
    drawText(frame.data, 365, 318, "SAVE CHANGES", labelColor);
    return { frame, button };
  }

  it("drops a button's own label so the control is the single mark", () => {
    const { frame, button } = labelledButton([255, 255, 255], [79, 70, 229]);
    const elements = detectUiElements(frame, { maxMarks: 60 });

    const control = centreHit(elements, button);
    expect(control).toBeDefined();
    expect(control!.kind).toBe("control");

    // The caption is ~80% contained by the button, so it must not also be marked. IoU cannot
    // catch this (a 171x19 label in a 226x54 button has IoU ~0.27).
    expect(textsInside(elements, button)).toEqual([]);
  });

  it("still drops the caption when the label out-scores its own button", () => {
    // Anti-aliased glyphs are extremely high contrast, so a caption can outrank the control it
    // sits in. Suppression must therefore not depend on selection order.
    const { frame, button } = labelledButton([255, 255, 255], [99, 102, 241]);
    const elements = detectUiElements(frame, { maxMarks: 60 });
    const control = centreHit(elements, button);
    expect(control).toBeDefined();
    expect(textsInside(elements, button)).toEqual([]);
  });

  it("keeps text inside a region, since a panel holds many independent lines", () => {
    const panel = { x: 120, y: 100, w: 620, h: 380 };
    const frame = frameOf((x, y) => (inRect(x, y, panel) ? [255, 255, 255] : [226, 232, 240]));
    strokeRect(frame.data, panel, [148, 163, 184]);
    drawText(frame.data, 150, 140, "TERMS OF SERVICE", [30, 41, 59]);
    drawText(frame.data, 150, 200, "PLEASE READ CAREFULLY", [71, 85, 105]);
    drawText(frame.data, 150, 260, "BY CONTINUING YOU AGREE", [71, 85, 105]);

    const elements = detectUiElements(frame, { maxMarks: 60 });
    expect(centreHit(elements, panel)).toBeDefined();
    const texts = elements.filter((e) => e.kind === "text");
    expect(texts.length).toBeGreaterThanOrEqual(2);
  });

  it("never suppresses a nested control, because those are real targets", () => {
    const card = { x: 100, y: 100, w: 500, h: 320 };
    const checkbox = { x: 130, y: 140, w: 26, h: 26 };
    const innerButton = { x: 130, y: 330, w: 150, h: 44 };

    const frame = frameOf((x, y) => {
      if (inRect(x, y, checkbox)) return [255, 255, 255];
      if (inRect(x, y, innerButton)) return [16, 185, 129];
      if (inRect(x, y, card)) return [250, 250, 251];
      return [226, 232, 240];
    });
    strokeRect(frame.data, card, [148, 163, 184]);
    strokeRect(frame.data, checkbox, [100, 116, 139]);
    strokeRect(frame.data, innerButton, [5, 150, 105]);
    drawText(frame.data, 170, 143, "ACCEPT TERMS", [51, 65, 85]);
    drawText(frame.data, 152, 344, "CONFIRM", [255, 255, 255]);

    const elements = detectUiElements(frame, { maxMarks: 60 });
    expect(centreHit(elements, card)).toBeDefined();
    expect(centreHit(elements, checkbox)).toBeDefined();
    expect(centreHit(elements, innerButton)).toBeDefined();
    // The label beside the checkbox is outside it, so it stays; CONFIRM inside the button does not.
    // ACCEPT TERMS sits beside the checkbox (outside it), CONFIRM sits inside the button.
    expect(textsInside(elements, innerButton)).toEqual([]);
  });

  it("leaves standalone icons alone when no control contains them", () => {
    const icons = Array.from({ length: 5 }, (_, n) => ({ x: 60 + n * 60, y: 80, w: 36, h: 36 }));
    const frame = frameOf((x, y) => {
      for (const r of icons) {
        if (!inRect(x, y, r)) continue;
        return ((x - r.x + (y - r.y)) % 6) < 3 ? [71, 85, 105] : [203, 213, 225];
      }
      return [248, 250, 252];
    });
    const elements = detectUiElements(frame, { maxMarks: 60 });
    for (const icon of icons) expect(centreHit(elements, icon)).toBeDefined();
  });
});
