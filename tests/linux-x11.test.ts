import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LinuxX11Backend } from "../src/backends/linux-x11.js";
import { HandyController } from "../src/controller.js";
import { PermissionStore } from "../src/permissions.js";
import { decodePng } from "../src/png.js";
import { MockX11Server } from "./helpers/mock-x11-server.js";

describe("LinuxX11Backend (Real X11 binary wire protocol)", () => {
  let x11Server: MockX11Server;
  let configDir: string;
  let backend: LinuxX11Backend;
  let controller: HandyController;

  beforeEach(async () => {
    x11Server = new MockX11Server(800, 600);
    await x11Server.start();
    configDir = mkdtempSync(join(tmpdir(), "handy-perm-x11-"));
    backend = new LinuxX11Backend({ display: x11Server.displayString });
    controller = new HandyController({
      backend,
      permissions: new PermissionStore({ configDir }),
    });
  });

  afterEach(async () => {
    await controller.close();
    await x11Server.stop();
    rmSync(configDir, { recursive: true, force: true });
  });

  it("connects over X11 socket, reports RANDR display info, and passes doctor()", async () => {
    const doc = await controller.doctor();
    expect(doc.checks.every((c) => c.ok)).toBe(true);

    const displays = await backend.getDisplays();
    expect(displays).toHaveLength(1);
    expect(displays[0]).toMatchObject({
      id: 0,
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      primary: true,
    });
  });

  it("executes chained move -> click -> type 'Sam' over XTEST and captures annotated GetImage screenshot", async () => {
    const res = await controller.act({
      actions: [
        { type: "move", x: 240, y: 140 },
        { type: "click" },
        { type: "type", text: "Sam" },
      ],
      stepDelayMs: 5,
      screenshotAfter: true,
      settleMs: 10,
    });

    expect(res.ok).toBe(true);
    expect(res.stepsCompleted).toBe(3);
    expect(res.mouse).toEqual({ x: 240, y: 140 });
    expect(x11Server.focusedInput).toBe(true);
    expect(x11Server.typedText).toBe("Sam");

    expect(res.screenshots).toHaveLength(1);
    const shot = res.screenshots[0]!;
    expect(shot.imageWidth).toBe(800);
    expect(shot.imageHeight).toBe(600);
    expect(shot.mouse).toEqual({ x: 240, y: 140 });

    const decoded = decodePng(shot.pngBuffer);
    expect(decoded.width).toBe(800);
    expect(decoded.height).toBe(600);
  });

  it("dynamically maps Unicode codepoints via ChangeKeyboardMapping and supports scroll + Backspace", async () => {
    await controller.act({
      actions: [
        { type: "click", x: 220, y: 140 },
        { type: "type", text: "SamX🚀" },
        { type: "key", key: "Backspace" },
        { type: "key", key: "Backspace" },
        { type: "scroll", direction: "down", amount: 2 },
      ],
      stepDelayMs: 2,
    });

    expect(x11Server.typedText).toBe("Sam");
    // Button 5 = scroll wheel down (2 ticks -> 2 down + 2 up events)
    const wheelDownPresses = x11Server.buttonEvents.filter((e) => e.button === 5 && e.type === "down");
    expect(wheelDownPresses).toHaveLength(2);
  });

  it("captures zoomed region via X11 GetImage with global coordinate mapping", async () => {
    await controller.act({
      actions: [{ type: "move", x: 260, y: 145 }],
    });

    const zoomed = await controller.see({
      region: { x: 160, y: 100, width: 320, height: 100 },
      gridStep: 50,
    });

    expect(zoomed.imageWidth).toBe(320);
    expect(zoomed.imageHeight).toBe(100);
    expect(zoomed.region).toEqual({ x: 160, y: 100, width: 320, height: 100 });
    expect(zoomed.mouse).toEqual({ x: 260, y: 145 });
  });

  it("inspects and focuses EWMH X11 desktop windows over pure wire protocol", async () => {
    const windows = await controller.listWindows();
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({
      title: "X11 Workbench",
      app: "HandyWorkbench",
      bounds: { x: 40, y: 40, width: 520, height: 420 },
      focused: true,
    });

    const focusRes = await controller.focusWindow({ title: "Terminal" });
    expect(focusRes.focused).toBe(true);
    expect(focusRes.activeWindow?.title).toBe("X11 Terminal");
    expect(x11Server.activeWindowId).toBe(0x00200002);
  });
});
