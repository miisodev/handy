import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualDesktopBackend } from "../src/backends/virtual.js";
import { HandyController } from "../src/controller.js";
import { PermissionStore } from "../src/permissions.js";
import { decodePng } from "../src/png.js";

/**
 * Element detection is an enhancement layered on top of a capture, not the deliverable. These
 * tests force the detector to throw and assert that `see()` degrades to a plain screenshot
 * instead of failing, that the reason reaches the caller, and that no stale marks survive to be
 * acted on.
 *
 * `vi.hoisted` shares the switch with the hoisted mock factory, which runs while the module
 * graph is still being evaluated and so cannot see a plain top-level `let`. Detection runs for
 * real until a test flips the switch, which keeps the "stale marks are cleared" case honest —
 * those marks were genuinely detected, not injected through a test-only seam.
 */
const detector = vi.hoisted(() => ({ failNext: false }));

vi.mock("../src/marks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/marks.js")>();
  return {
    ...actual,
    detectUiElements: (...args: Parameters<typeof actual.detectUiElements>) => {
      if (detector.failNext) throw new Error("simulated detector failure");
      return actual.detectUiElements(...args);
    },
  };
});

describe("Marks — detection failure degrades instead of failing the capture", () => {
  let configDir: string;
  let backend: VirtualDesktopBackend;
  let controller: HandyController;

  beforeEach(async () => {
    detector.failNext = false;
    configDir = mkdtempSync(join(tmpdir(), "handy-marks-failsoft-"));
    backend = new VirtualDesktopBackend();
    controller = new HandyController({ backend, permissions: new PermissionStore({ configDir }) });
    await controller.init();
  });

  afterEach(async () => {
    detector.failNext = false;
    await controller.close();
    rmSync(configDir, { recursive: true, force: true });
  });

  it("still returns a valid screenshot and reports why marks are missing", async () => {
    detector.failNext = true;
    const shot = await controller.see({ marks: true });

    // The capture itself is intact and decodable — that is the artifact the agent needs.
    expect(shot.pngBuffer.length).toBeGreaterThan(0);
    const decoded = decodePng(shot.pngBuffer);
    expect(decoded.width).toBe(1280);
    expect(decoded.height).toBe(800);
    expect(shot.base64Png.length).toBeGreaterThan(0);
    expect(shot.mouse).toBeDefined();
    expect(shot.activeWindow).toBeDefined();
    expect(shot.captureMs).toBeGreaterThanOrEqual(0);

    // No elements, and the reason is surfaced rather than silently swallowed.
    expect(shot.elements).toBeUndefined();
    expect(shot.marksError).toBe("simulated detector failure");
    expect(controller.detectedElements).toBeNull();
  });

  it("does not report marksError when marks were not requested", async () => {
    detector.failNext = true;
    // Detection is never invoked, so a broken detector cannot affect a plain capture at all.
    const shot = await controller.see();
    expect(shot.elements).toBeUndefined();
    expect(shot.marksError).toBeUndefined();
    expect(shot.pngBuffer.length).toBeGreaterThan(0);
  });

  it("keeps working on the next capture once detection recovers", async () => {
    detector.failNext = true;
    const failed = await controller.see({ marks: true });
    expect(failed.marksError).toBe("simulated detector failure");

    detector.failNext = false;
    const recovered = await controller.see({ marks: true });
    expect(recovered.marksError).toBeUndefined();
    expect(recovered.elements).toBeDefined();
    expect(recovered.elements!.length).toBeGreaterThan(0);
    expect(controller.detectedElements).toEqual(recovered.elements);
  });

  it("clears marks from an earlier successful capture so a stale index cannot be clicked", async () => {
    // A genuinely detected mark set, including one that resolves to a real control.
    const good = await controller.see({ marks: true });
    expect(good.marksError).toBeUndefined();
    expect(good.elements!.length).toBeGreaterThan(0);
    const markOne = good.elements!.find((e) => e.index === 1)!;
    expect(markOne).toBeDefined();

    // Clicking it works while those marks are current.
    const acted = await controller.act({ actions: [{ type: "click", mark: 1 }], stepDelayMs: 2 });
    expect(acted.stepsCompleted).toBe(1);
    expect(acted.mouse).toEqual({ x: markOne.centerX, y: markOne.centerY });

    // Now break detection. The next marked capture must not leave those marks resolvable: the
    // screen may have changed, so mark #1 could now point at a different control entirely.
    detector.failNext = true;
    const failed = await controller.see({ marks: true });
    expect(failed.marksError).toBe("simulated detector failure");
    expect(failed.elements).toBeUndefined();
    expect(controller.detectedElements).toBeNull();

    await expect(controller.act({ actions: [{ type: "click", mark: 1 }] })).rejects.toThrow(
      /no detected UI elements are available/i,
    );
  });
});
