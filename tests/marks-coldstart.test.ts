import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualDesktopBackend } from "../src/backends/virtual.js";
import { HandyController } from "../src/controller.js";
import { PermissionStore } from "../src/permissions.js";

/**
 * Marks live on a controller instance, and every CLI invocation is a fresh process — so
 * `handy see --marks` followed by `handy act "click mark 5"` has nothing to hand over. A mark
 * reference therefore resolves itself: with no cached elements, the controller captures and
 * detects from the live screen on demand.
 *
 * These tests pin both halves of that contract — marks work from a cold start, and a warm cache
 * is *not* re-detected, so a marked chain does not pay for capture and detection twice per step.
 */
describe("Marks resolve across process boundaries", () => {
  let configDir: string;
  let backend: VirtualDesktopBackend;
  let controller: HandyController;

  const freshController = async () => {
    const c = new HandyController({ backend, permissions: new PermissionStore({ configDir }) });
    await c.init();
    return c;
  };

  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), "handy-marks-coldstart-"));
    backend = new VirtualDesktopBackend();
    controller = await freshController();
  });

  afterEach(async () => {
    await controller.close();
    rmSync(configDir, { recursive: true, force: true });
  });

  it("clicks a mark from a cold start, as a separate CLI process would", async () => {
    const cold = await freshController();
    try {
      expect(cold.detectedElements).toBeNull();
      const res = await cold.act({ actions: [{ type: "click", mark: 5 }], stepDelayMs: 2 });
      expect(res.stepsCompleted).toBe(1);
      expect(res.receipts[0]!.detail).toMatch(/mark #5/);
      expect(res.receipts[0]!.detail).not.toMatch(/at cursor/i);
    } finally {
      await cold.close();
    }
  });

  it("drags between two marks from a cold start", async () => {
    const cold = await freshController();
    try {
      const res = await cold.act({
        actions: [{ type: "drag", fromMark: 3, toMark: 7 }],
        stepDelayMs: 2,
      });
      expect(res.stepsCompleted).toBe(1);
      expect(res.receipts[0]!.detail).toMatch(/dragged mark #3 -> mark #7/);

      // Both endpoints resolved to real element centres, not the cursor's starting position.
      const elements = cold.detectedElements!;
      const from = elements.find((e) => e.index === 3)!;
      const to = elements.find((e) => e.index === 7)!;
      expect(res.mouse).toEqual({ x: to.centerX, y: to.centerY });
      expect(from.centerX).not.toBe(to.centerX);
    } finally {
      await cold.close();
    }
  });

  it("scrolls at a mark from a cold start", async () => {
    const cold = await freshController();
    try {
      const res = await cold.act({
        actions: [{ type: "scroll", direction: "down", amount: 3, mark: 9 }],
        stepDelayMs: 2,
      });
      expect(res.stepsCompleted).toBe(1);
      expect(res.receipts[0]!.detail).toMatch(/mark #9/);
    } finally {
      await cold.close();
    }
  });

  it("does not re-capture or re-detect once marks are warm", async () => {
    // A marked chain would otherwise pay for a full capture plus detection on every pointer step.
    const spy = vi.spyOn(backend, "captureScreen");

    await controller.see({ marks: true });
    const afterSee = spy.mock.calls.length;
    expect(afterSee).toBeGreaterThan(0);

    await controller.act({
      actions: [
        { type: "move", mark: 1 },
        { type: "click", mark: 2 },
        { type: "click", mark: 3 },
      ],
      stepDelayMs: 1,
    });

    expect(spy.mock.calls.length).toBe(afterSee);
    spy.mockRestore();
  });

  it("keeps mark indices stable across steps in one chain", async () => {
    // Detecting once per chain (not per step) is what makes `click mark 5 -> click mark 5` hit the
    // same place twice. Resolving indices against a fresh detection per step could renumber them.
    await controller.see({ marks: true });
    const first = controller.detectedElements!.find((e) => e.index === 5)!;

    const res = await controller.act({
      actions: [{ type: "click", mark: 5 }, { type: "click", mark: 5 }],
      stepDelayMs: 2,
    });
    expect(res.stepsCompleted).toBe(2);
    expect(res.mouse).toEqual({ x: first.centerX, y: first.centerY });
    for (const r of res.receipts) expect(r.detail).toMatch(/mark #5/);
  });

  it("scroll receipt names the target for coordinates and for a bare scroll", async () => {
    // Three branches: an explicit point, no point at all (scroll wherever the cursor is), and a
    // mark (covered above). An agent replaying a chain needs to distinguish them.
    const atCoords = await controller.act({
      actions: [{ type: "scroll", direction: "down", amount: 2, x: 300, y: 400 }],
      stepDelayMs: 1,
    });
    expect(atCoords.receipts[0]!.detail).toMatch(/scrolled dx=0 dy=2 at \(300,400\)/);

    const bare = await controller.act({
      actions: [{ type: "scroll", direction: "up", amount: 2 }],
      stepDelayMs: 1,
    });
    expect(bare.receipts[0]!.detail).toMatch(/scrolled dx=0 dy=-2 at the cursor/);
  });

  it("reports a capture failure during cold-start detection as an actionable error", async () => {
    const cold = await freshController();
    try {
      cold.backend.captureScreen = async () => {
        throw new Error("screen capture unavailable");
      };
      await expect(cold.act({ actions: [{ type: "click", mark: 1 }] })).rejects.toThrow(
        /could not be captured to detect them now/i,
      );
    } finally {
      await cold.close();
    }
  });

  it("still rejects an out-of-range mark after cold-start detection", async () => {
    const cold = await freshController();
    try {
      // Lazy detection must not turn an impossible index into a click at some arbitrary place.
      await expect(cold.act({ actions: [{ type: "click", mark: 150 }] })).rejects.toThrow(
        /not available/i,
      );
    } finally {
      await cold.close();
    }
  });
});
