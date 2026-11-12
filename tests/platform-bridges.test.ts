import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DarwinBackend } from "../src/backends/darwin.js";
import { Win32Backend } from "../src/backends/win32.js";
import { HandyController } from "../src/controller.js";
import { PermissionStore } from "../src/permissions.js";
import { encodePng } from "../src/png.js";

describe("Cross-Platform Native Bridges (macOS CoreGraphics & Windows SendInput)", () => {
  it("drives DarwinBackend with Retina 2x logical coordinate mapping and double-click state", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "handy-darwin-test-"));
    // Node one-liner mock JSONL worker recording every CoreGraphics command
    const mockWorkerScript = `
      const rl = require("node:readline").createInterface({ input: process.stdin });
      let mouse = { x: 100, y: 100 };
      const events = [];
      rl.on("line", (line) => {
        const cmd = JSON.parse(line);
        events.push(cmd);
        if (cmd.op === "doctor") {
          console.log(JSON.stringify({ id: cmd.id, ok: true, accessibility: true, screenRecording: true }));
        } else if (cmd.op === "displays") {
          console.log(JSON.stringify({
            id: cmd.id,
            ok: true,
            displays: [{ id: 0, name: "Retina", x: 0, y: 0, width: 1512, height: 982, scaleFactor: 2, primary: true }]
          }));
        } else if (cmd.op === "mouse_pos") {
          console.log(JSON.stringify({ id: cmd.id, ok: true, x: mouse.x, y: mouse.y, count: events.length }));
        } else if (cmd.op === "move") {
          mouse = { x: cmd.x, y: cmd.y };
          console.log(JSON.stringify({ id: cmd.id, ok: true }));
        } else {
          console.log(JSON.stringify({ id: cmd.id, ok: true }));
        }
      });
    `;

    // Simulate Retina 2x physical image (3024x1964 -> scaled test 600x400 for 300x200 logical)
    const retinaPng = encodePng(600, 400, new Uint8Array(600 * 400 * 4).fill(220));
    const darwin = new DarwinBackend({
      workerOptions: {
        command: process.execPath,
        args: ["-e", mockWorkerScript],
      },
      capturePng: async () => retinaPng,
    });

    const controller = new HandyController({
      backend: darwin,
      permissions: new PermissionStore({ configDir }),
    });

    try {
      const doc = await controller.doctor();
      expect(doc.checks.every((c) => c.ok)).toBe(true);

      const res = await controller.act({
        actions: [
          { type: "move", x: 420, y: 260 },
          { type: "double_click" },
          { type: "type", text: "Sam 🚀" },
          { type: "key", key: "mod+s" },
        ],
        stepDelayMs: 2,
      });

      expect(res.mouse).toEqual({ x: 420, y: 260 });

      const shot = await controller.see({ region: { x: 0, y: 0, width: 300, height: 200 } });
      expect(shot.screen.scaleFactor).toBe(2);
      expect(shot.screen.width).toBe(300);
      expect(shot.screen.height).toBe(200);
    } finally {
      await controller.close();
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("drives Win32Backend SendInput VK + Unicode batching and GDI PNG capture", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "handy-win32-test-"));
    const samplePng = encodePng(320, 200, new Uint8Array(320 * 200 * 4).fill(200)).toString("base64");

    const mockWinWorker = `
      const rl = require("node:readline").createInterface({ input: process.stdin });
      let mouse = { x: 50, y: 50 };
      let typed = "";
      rl.on("line", (line) => {
        const cmd = JSON.parse(line);
        if (cmd.op === "doctor") {
          console.log(JSON.stringify({ id: cmd.id, ok: true, dpiAware: true }));
        } else if (cmd.op === "displays") {
          console.log(JSON.stringify({
            id: cmd.id,
            ok: true,
            displays: [{ id: 0, name: "\\\\\\\\.\\\\DISPLAY1", x: 0, y: 0, width: 1920, height: 1080, scaleFactor: 1, primary: true }]
          }));
        } else if (cmd.op === "mouse_pos") {
          console.log(JSON.stringify({ id: cmd.id, ok: true, x: mouse.x, y: mouse.y }));
        } else if (cmd.op === "move") {
          mouse = { x: cmd.x, y: cmd.y };
          console.log(JSON.stringify({ id: cmd.id, ok: true }));
        } else if (cmd.op === "unicode") {
          typed += cmd.text;
          console.log(JSON.stringify({ id: cmd.id, ok: true }));
        } else if (cmd.op === "capture") {
          console.log(JSON.stringify({ id: cmd.id, ok: true, pngBase64: ${JSON.stringify(samplePng)} }));
        } else {
          console.log(JSON.stringify({ id: cmd.id, ok: true }));
        }
      });
    `;

    const win32 = new Win32Backend({
      workerOptions: {
        command: process.execPath,
        args: ["-e", mockWinWorker],
      },
    });
    const controller = new HandyController({
      backend: win32,
      permissions: new PermissionStore({ configDir }),
    });

    try {
      const doc = await controller.doctor();
      expect(doc.checks[0]?.ok).toBe(true);

      const actRes = await controller.act({
        actions: [
          { type: "move", x: 510, y: 340 },
          { type: "click" },
          { type: "type", text: "Sam", submit: true },
          { type: "key", key: "mod+c" },
        ],
        stepDelayMs: 2,
        screenshotAfter: true,
        settleMs: 5,
      });

      expect(actRes.stepsCompleted).toBe(4);
      expect(actRes.mouse).toEqual({ x: 510, y: 340 });
      expect(actRes.screenshots).toHaveLength(1);
    } finally {
      await controller.close();
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")(
    "compiles and initializes real Win32 C# SendInput/GDI/Clipboard/Window bridge on native Windows",
    async () => {
      const realWin = new Win32Backend();
      try {
        const checks = await realWin.doctor();
        expect(checks[0]?.ok, JSON.stringify(checks)).toBe(true);
        const displays = await realWin.getDisplays();
        expect(displays.length).toBeGreaterThanOrEqual(1);
        const wins = await realWin.listWindows();
        expect(Array.isArray(wins)).toBe(true);
        await realWin.setClipboardText("Handy Win32 🚀");
        const clip = await realWin.getClipboardText();
        expect(clip).toBe("Handy Win32 🚀");
      } finally {
        await realWin.close();
      }
    },
    20_000,
  );
});
