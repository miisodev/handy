import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VirtualDesktopBackend } from "../src/backends/virtual.js";
import { HandyController, parseChainInput } from "../src/controller.js";
import { computeFrameDiff, samplePixelHex } from "../src/diff.js";
import { installHandyToHosts, resolveHostConfigPath, uninstallHandyFromHosts } from "../src/installer.js";
import { PermissionStore } from "../src/permissions.js";
import type { RawFrame } from "../src/types.js";
import { startControlPanel } from "../src/ui.js";

describe("Handy v1.1.0 Features (Frame Diffing, Smart Waits, Paste, Failsafe, Installer, Live UI)", () => {
  it("computes exact RGBA visual frame diffs and samples raw pixel hex under cursor", async () => {
    const f1: RawFrame = {
      width: 100,
      height: 100,
      data: new Uint8Array(100 * 100 * 4).fill(0),
      originX: 200,
      originY: 100,
      logicalWidth: 100,
      logicalHeight: 100,
      scaleFactor: 1,
      displayId: 0,
    };
    const f2: RawFrame = {
      ...f1,
      data: new Uint8Array(f1.data),
    };
    // Paint a 10x10 red block at local (20..29, 30..39) -> global (220..229, 130..139)
    for (let y = 30; y < 40; y++) {
      for (let x = 20; x < 30; x++) {
        const i = (y * 100 + x) * 4;
        f2.data[i] = 0xef;
        f2.data[i + 1] = 0x44;
        f2.data[i + 2] = 0x44;
        f2.data[i + 3] = 255;
      }
    }

    expect(samplePixelHex(f2, { x: 225, y: 135 })).toBe("#ef4444");
    expect(samplePixelHex(f2, { x: 50, y: 50 })).toBeNull();

    const diff = computeFrameDiff(f1, f2);
    expect(diff).not.toBeNull();
    expect(diff!.changedPixels).toBe(100);
    expect(diff!.changedPercent).toBe(1);
    expect(diff!.changedBounds).toEqual({ x: 220, y: 130, width: 10, height: 10 });
  });

  it("chains focus_window -> paste -> wait_for_settled and preserves previous clipboard", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "handy-v11-chain-"));
    const backend = new VirtualDesktopBackend();
    const controller = new HandyController({
      backend,
      permissions: new PermissionStore({ configDir }),
    });

    try {
      await controller.writeClipboard("UserOriginalSecret");

      const firstSee = await controller.see();
      expect(firstSee.screenDiff).toBeNull();
      expect(firstSee.activeWindow?.title).toBe("Agent Control Workbench");

      const parsed = parseChainInput(
        'focus "Scratchpad" -> click 820 420 -> paste "Hello multi-line\\nUnicode 🚀" -> wait_for_settled 600 80',
      );
      expect(parsed.map((s) => s.type)).toEqual(["focus_window", "click", "paste", "wait_for_settled"]);

      const res = await controller.act({
        actions: parsed,
        stepDelayMs: 5,
        screenshotAfter: true,
      });

      expect(res.ok).toBe(true);
      expect(res.activeWindow?.title).toBe("Notes Scratchpad");
      expect(backend.state.fields.scratchpad).toBe("Hello multi-line\nUnicode 🚀");
      expect(await controller.readClipboard()).toBe("UserOriginalSecret");

      // Post-action screenshot computes visual diff against firstSee!
      expect(res.screenshots[0]?.screenDiff).not.toBeNull();
      expect(res.screenshots[0]!.screenDiff!.changedPercent).toBeGreaterThan(0);
    } finally {
      await controller.close();
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("detects asynchronous UI updates via wait_for_change", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "handy-v11-waitchange-"));
    const backend = new VirtualDesktopBackend();
    const controller = new HandyController({
      backend,
      permissions: new PermissionStore({ configDir }),
    });

    try {
      setTimeout(() => {
        backend.state.submittedValue = "Order Confirmed #42";
      }, 90);

      const res = await controller.act({
        actions: [{ type: "wait_for_change", timeoutMs: 1500, pollMs: 30 }],
      });
      expect(res.ok).toBe(true);
      expect(res.receipts[0]?.detail).toContain("visual change");
    } finally {
      await controller.close();
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("aborts chain and releases held inputs immediately when human slams cursor to (0,0) failsafe corner", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "handy-v11-failsafe-"));
    const backend = new VirtualDesktopBackend();
    const controller = new HandyController({
      backend,
      permissions: new PermissionStore({ configDir }),
    });

    try {
      // Simulate human slamming mouse to (0,0) 60ms into a multi-step chain while shift is held
      setTimeout(() => {
        void backend.moveMouse(0, 0);
      }, 60);

      await expect(
        controller.act({
          actions: [
            { type: "move", x: 300, y: 300 },
            { type: "key_down", key: "shift" },
            { type: "wait", ms: 120 },
            { type: "click", x: 400, y: 300 },
          ],
          failsafe: true,
        }),
      ).rejects.toThrow(/Failsafe triggered/);
    } finally {
      await controller.close();
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("installs and uninstalls Handy MCP host configs safely with --dry-run and .handy.bak backups", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "handy-installer-"));
    try {
      const cursorPath = resolveHostConfigPath("cursor", { homeDir: fakeHome, platform: "darwin" });
      mkdirSync(join(fakeHome, ".cursor"), { recursive: true });
      writeFileSync(
        cursorPath,
        JSON.stringify({ mcpServers: { existingServer: { command: "node", args: ["other.js"] } } }, null, 2),
      );

      // Dry run does not mutate file
      const dry = installHandyToHosts("cursor", { homeDir: fakeHome, platform: "darwin", dryRun: true });
      expect(dry[0]?.action).toBe("updated");
      expect(JSON.parse(readFileSync(cursorPath, "utf8")).mcpServers.handy).toBeUndefined();

      // Real install preserves existingServer, adds handy, and writes .handy.bak
      const installed = installHandyToHosts("cursor", { homeDir: fakeHome, platform: "darwin" });
      expect(installed[0]?.action).toBe("updated");
      expect(existsSync(`${cursorPath}.handy.bak`)).toBe(true);
      const afterInstall = JSON.parse(readFileSync(cursorPath, "utf8"));
      expect(afterInstall.mcpServers.existingServer).toBeDefined();
      expect(afterInstall.mcpServers.handy).toEqual({
        command: "npx",
        args: ["-y", "@miisodev/handy", "mcp"],
      });

      // Windows host uses cmd /c npx wrapper
      const winClaude = installHandyToHosts("claude-desktop", {
        homeDir: fakeHome,
        appDataDir: join(fakeHome, "Roaming"),
        platform: "win32",
      });
      expect(winClaude[0]?.action).toBe("installed");
      const winJson = JSON.parse(readFileSync(winClaude[0]!.configPath, "utf8"));
      expect(winJson.mcpServers.handy.command).toBe("cmd");

      // Uninstall removes handy while keeping existingServer intact
      const removed = uninstallHandyFromHosts("cursor", { homeDir: fakeHome, platform: "darwin" });
      expect(removed[0]?.action).toBe("removed");
      const afterRemove = JSON.parse(readFileSync(cursorPath, "utf8"));
      expect(afterRemove.mcpServers.handy).toBeUndefined();
      expect(afterRemove.mcpServers.existingServer).toBeDefined();
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("serves loopback Control Panel UI with X-Handy-Token CSRF protection and live endpoints", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "handy-ui-test-"));
    const panel = await startControlPanel({
      port: 0,
      host: "127.0.0.1",
      backendKind: "virtual",
      permissions: new PermissionStore({ configDir }),
    });

    try {
      // 1. HTML page loads cleanly
      const htmlRes = await fetch(panel.url);
      expect(htmlRes.status).toBe(200);
      const html = await htmlRes.text();
      expect(html).toContain("Handy Control Panel");

      // 2. API rejects unauthenticated cross-site requests without X-Handy-Token
      const unauth = await fetch(`${panel.url}/api/permission`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(unauth.status).toBe(403);

      // 3. Authenticated API calls work for status, see, windows, act, and permission toggle
      const headers = { "x-handy-token": panel.token, "content-type": "application/json" };
      const seeRes = await fetch(`${panel.url}/api/see`, { headers });
      const seeJson = (await seeRes.json()) as { ok: boolean; pixelUnderMouse: string };
      expect(seeJson.ok).toBe(true);
      expect(seeJson.pixelUnderMouse).toMatch(/^#[0-9a-f]{6}$/);

      const actRes = await fetch(`${panel.url}/api/act`, {
        method: "POST",
        headers,
        body: JSON.stringify({ chain: 'move 300 220 -> click' }),
      });
      const actJson = (await actRes.json()) as { ok: boolean; stepsCompleted: number };
      expect(actJson.ok).toBe(true);
      expect(actJson.stepsCompleted).toBe(2);

      const offRes = await fetch(`${panel.url}/api/permission`, {
        method: "POST",
        headers,
        body: JSON.stringify({ enabled: false }),
      });
      const offJson = (await offRes.json()) as { permission: { enabled: boolean } };
      expect(offJson.permission.enabled).toBe(false);
    } finally {
      await panel.close();
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
