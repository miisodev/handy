import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VirtualDesktopBackend } from "../src/backends/virtual.js";
import { HandyController, parseChainInput } from "../src/controller.js";
import { hexColorDistance, parseHexRgb } from "../src/diff.js";
import { PermissionStore } from "../src/permissions.js";
import { decodePng } from "../src/png.js";
import { startControlPanel } from "../src/ui.js";

describe("Handy v1.2.0 Features (Window Capture, Window Coordinates, wait_for_color, highlightDiff, Live SSE)", () => {
  it("parses hex RGB strings and computes Euclidean RGB color distance accurately", () => {
    expect(parseHexRgb("#10b981")).toEqual([0x10, 0xb9, 0x81]);
    expect(parseHexRgb("ef4444")).toEqual([0xef, 0x44, 0x44]);
    expect(parseHexRgb("#f0a")).toEqual([0xff, 0x00, 0xaa]);
    expect(() => parseHexRgb("invalid")).toThrow(/Invalid hex color/);
    expect(hexColorDistance("#10b981", "#10b981")).toBe(0);
    expect(hexColorDistance("#000000", "#ffffff")).toBeGreaterThan(440);
  });

  it("captures a single desktop window at 1:1 resolution while preserving global screen coordinates", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "handy-v12-wincap-"));
    const backend = new VirtualDesktopBackend();
    const controller = new HandyController({
      backend,
      permissions: new PermissionStore({ configDir }),
    });

    try {
      const shot = await controller.see({ window: "Scratchpad" });
      expect(shot.region).toEqual(VirtualDesktopBackend.LAYOUT.scratchpadWindow);
      expect(shot.imageWidth).toBe(VirtualDesktopBackend.LAYOUT.scratchpadWindow.width);
      expect(shot.imageHeight).toBe(VirtualDesktopBackend.LAYOUT.scratchpadWindow.height);

      await expect(controller.see({ window: "NonExistentWindowXYZ" })).rejects.toThrow(/No visible window/);
    } finally {
      await controller.close();
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("offsets actions relative to the active window when coordinateSpace === 'window'", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "handy-v12-winspace-"));
    const backend = new VirtualDesktopBackend();
    const controller = new HandyController({
      backend,
      permissions: new PermissionStore({ configDir }),
    });

    try {
      // Focus Scratchpad (origin 720, 310), then click window-relative (60, 90) -> global (780, 400)
      const res = await controller.act({
        actions: [
          { type: "focus_window", title: "Scratchpad" },
          { type: "click", x: 60, y: 90, coordinateSpace: "window" },
          { type: "type", text: "WindowRelativeOK" },
        ],
        stepDelayMs: 5,
      });

      expect(res.ok).toBe(true);
      expect(res.mouse).toEqual({
        x: VirtualDesktopBackend.LAYOUT.scratchpadWindow.x + 60,
        y: VirtualDesktopBackend.LAYOUT.scratchpadWindow.y + 90,
      });
      expect(backend.state.fields.scratchpad).toBe("WindowRelativeOK");
    } finally {
      await controller.close();
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("supports wait_for_color in JSON chains and CLI shorthand and detects live color transitions", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "handy-v12-waitcolor-"));
    const backend = new VirtualDesktopBackend();
    const controller = new HandyController({
      backend,
      permissions: new PermissionStore({ configDir }),
    });

    try {
      const parsed = parseChainInput("wait_for_color 800 200 #ef4444 1200 20");
      expect(parsed).toEqual([
        { type: "wait_for_color", x: 800, y: 200, color: "#ef4444", timeoutMs: 1200, tolerance: 20 },
      ]);

      // Sample the draggable card's current color at (800, 200), then move the card away and back
      backend.state.cardPosition = { x: 950, y: 150 };
      const cardTargetProbe = await controller.see({ grid: false, showMouse: false });
      expect(cardTargetProbe.imageWidth).toBe(1280);

      // Put card back at (760, 150) after 80ms; sample its header pixel color first
      backend.state.cardPosition = { x: 760, y: 150 };
      const withCard = await backend.captureScreen({ region: { x: 799, y: 164, width: 3, height: 3 } });
      const r = withCard.data[4]!.toString(16).padStart(2, "0");
      const g = withCard.data[5]!.toString(16).padStart(2, "0");
      const b = withCard.data[6]!.toString(16).padStart(2, "0");
      const cardHeaderHex = `#${r}${g}${b}`;

      // Move card away initially, then move it into place asynchronously
      backend.state.cardPosition = { x: 980, y: 500 };
      setTimeout(() => {
        backend.state.cardPosition = { x: 760, y: 150 };
      }, 75);

      const res = await controller.act({
        actions: [
          {
            type: "wait_for_color",
            x: 800,
            y: 165,
            color: cardHeaderHex,
            tolerance: 12,
            pollMs: 25,
            timeoutMs: 1500,
          },
        ],
      });

      expect(res.ok).toBe(true);
      expect(res.receipts[0]?.detail).toContain("matched");
    } finally {
      await controller.close();
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("renders emerald CHANGED bounding box when highlightDiff: true", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "handy-v12-diffhi-"));
    const backend = new VirtualDesktopBackend();
    const controller = new HandyController({
      backend,
      permissions: new PermissionStore({ configDir }),
    });

    try {
      await controller.see({ grid: false, showMouse: false });
      backend.state.counter = 9;
      const diffPlain = await controller.see({ grid: false, showMouse: false, highlightDiff: false });

      // Reset baseline and capture with highlightDiff: true for identical change
      backend.state.counter = 0;
      await controller.see({ grid: false, showMouse: false });
      backend.state.counter = 9;
      const diffHighlighted = await controller.see({ grid: false, showMouse: false, highlightDiff: true });

      expect(diffHighlighted.screenDiff).not.toBeNull();
      const plainDecoded = decodePng(diffPlain.pngBuffer);
      const hiDecoded = decodePng(diffHighlighted.pngBuffer);

      // Emerald outline pixels (#10b981 = 16, 185, 129) appear on the highlighted capture
      let diffPixelsBetweenRenders = 0;
      for (let i = 0; i < plainDecoded.data.length; i += 4) {
        if (
          plainDecoded.data[i] !== hiDecoded.data[i] ||
          plainDecoded.data[i + 1] !== hiDecoded.data[i + 1] ||
          plainDecoded.data[i + 2] !== hiDecoded.data[i + 2]
        ) {
          diffPixelsBetweenRenders++;
        }
      }
      expect(diffPixelsBetweenRenders).toBeGreaterThan(25);
    } finally {
      await controller.close();
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("streams real-time permission state changes over SSE GET /api/events", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "handy-v12-sse-"));
    const permissions = new PermissionStore({ configDir });
    const panel = await startControlPanel({
      port: 0,
      host: "127.0.0.1",
      backendKind: "virtual",
      permissions,
    });

    try {
      // Unauthenticated SSE request is rejected with 403
      const forbiddenRes = await fetch(`${panel.url}/api/events`);
      expect(forbiddenRes.status).toBe(403);

      // Connect SSE stream and capture initial + live-pushed permission events
      const events: Array<{ enabled: boolean; mode: string }> = [];
      await new Promise<void>((resolveDone, rejectDone) => {
        const req = http.get(
          `${panel.url}/api/events?token=${encodeURIComponent(panel.token)}`,
          (res) => {
            expect(res.statusCode).toBe(200);
            expect(res.headers["content-type"]).toContain("text/event-stream");
            let buf = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
              buf += chunk;
              const blocks = buf.split("\n\n");
              buf = blocks.pop() ?? "";
              for (const block of blocks) {
                const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
                if (dataLine) {
                  events.push(JSON.parse(dataLine.slice(6)) as { enabled: boolean; mode: string });
                }
              }
              if (events.length === 1) {
                // Trigger an external permission change (like `handy off` from the CLI).
                // `updatedBy` is a closed contract ("cli" | "mcp" | "ui"); this simulates the CLI.
                permissions.setEnabled(false, { updatedBy: "cli" });
              } else if (events.length >= 2) {
                req.destroy();
                resolveDone();
              }
            });
          },
        );
        req.on("error", (err) => {
          if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") {
            rejectDone(err);
          }
        });
      });

      expect(events[0]?.enabled).toBe(true);
      expect(events[1]?.enabled).toBe(false);
    } finally {
      await panel.close();
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
