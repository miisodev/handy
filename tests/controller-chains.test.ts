import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VirtualDesktopBackend } from "../src/backends/virtual.js";
import { HandyController, parseChainInput } from "../src/controller.js";
import { parseKeyChord } from "../src/keys.js";
import { PermissionStore } from "../src/permissions.js";

describe("HandyController — Chained Controls & Key Chords", () => {
  let configDir: string;
  let backend: VirtualDesktopBackend;
  let controller: HandyController;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "handy-chain-"));
    backend = new VirtualDesktopBackend();
    controller = new HandyController({
      backend,
      permissions: new PermissionStore({ configDir }),
    });
  });

  afterEach(async () => {
    await controller.close();
    rmSync(configDir, { recursive: true, force: true });
  });

  it("executes chained move -> click -> type 'Sam' -> click Submit in one call", async () => {
    const res = await controller.act({
      actions: [
        { type: "move", x: 250, y: 172 },
        { type: "click" },
        { type: "type", text: "Sam" },
        { type: "click", x: 195, y: 325 },
      ],
      stepDelayMs: 5,
      screenshotAfter: true,
      settleMs: 5,
    });

    expect(res.ok).toBe(true);
    expect(res.stepsCompleted).toBe(4);
    expect(backend.state.fields.name).toBe("Sam");
    expect(backend.state.submittedValue).toBe("Sam");
    expect(res.mouse).toEqual({ x: 195, y: 325 });
    expect(res.screenshots).toHaveLength(1);
    expect(res.screenshots[0]!.imageWidth).toBe(1280);
  });

  it("supports select-all replacement (mod+a -> Backspace -> type), Tab navigation, drag, and scroll", async () => {
    await controller.act({
      actions: [
        { type: "click", x: 250, y: 172 },
        { type: "type", text: "WrongName" },
        { type: "key", key: "mod+a" },
        { type: "key", key: "Backspace" },
        { type: "type", text: "Sam" },
        { type: "key", key: "Tab" },
        { type: "type", text: "Checked via chain" },
        { type: "drag", fromX: 820, fromY: 190, toX: 960, toY: 420, durationMs: 40, steps: 6 },
        { type: "scroll", x: 300, y: 500, direction: "down", amount: 4 },
      ],
      stepDelayMs: 2,
    });

    expect(backend.state.fields.name).toBe("Sam");
    expect(backend.state.fields.notes).toBe("Checked via chain");
    expect(backend.state.cardPosition.x).toBeGreaterThan(850);
    expect(backend.state.cardPosition.y).toBeGreaterThan(300);
    expect(backend.state.scrollOffset).toBe(40);
  });

  it("maps normalized 0..1000 coordinates accurately onto display dimensions", async () => {
    const res = await controller.act({
      actions: [{ type: "move", x: 500, y: 500, coordinateSpace: "normalized" }],
    });
    expect(res.mouse).toEqual({ x: 640, y: 400 });
  });

  it("releases held buttons and keys cleanly if aborted via AbortSignal", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);

    await expect(
      controller.act({
        actions: [
          { type: "mouse_down", x: 800, y: 180 },
          { type: "key_down", key: "shift" },
          { type: "wait", ms: 200 },
        ],
        signal: ac.signal,
      }),
    ).rejects.toThrow(/aborted/);

    expect(backend.state.draggingCard).toBe(false);
  });

  it("parses human chain shorthand and tricky key chords like ctrl++ and mod+c", () => {
    const steps = parseChainInput('move 250 172 -> click -> type "Sam" -> key Enter');
    expect(steps).toEqual([
      { type: "move", x: 250, y: 172 },
      { type: "click" },
      { type: "type", text: "Sam" },
      { type: "key", key: "Enter" },
    ]);

    expect(parseKeyChord("ctrl++", [], "linux")).toEqual({ key: "+", modifiers: ["ctrl"] });
    expect(parseKeyChord("mod+c", [], "darwin")).toEqual({ key: "c", modifiers: ["meta"] });
    expect(parseKeyChord("mod+c", [], "win32")).toEqual({ key: "c", modifiers: ["ctrl"] });
  });
});
