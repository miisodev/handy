import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VirtualDesktopBackend } from "../src/backends/virtual.js";
import { HandyController } from "../src/controller.js";
import { HandyPermissionError, parseDurationMs, PermissionStore } from "../src/permissions.js";

describe("PermissionStore & Live On/Off Toggle", () => {
  let configDir: string;
  let store: PermissionStore;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "handy-perm-"));
    store = new PermissionStore({ configDir });
    delete process.env.HANDY_ENABLED;
    delete process.env.HANDY_ALLOW_MCP_ENABLE;
  });

  afterEach(() => {
    delete process.env.HANDY_ENABLED;
    delete process.env.HANDY_ALLOW_MCP_ENABLE;
    rmSync(configDir, { recursive: true, force: true });
  });

  it("defaults to ON and toggles cleanly with 0600 file permissions", () => {
    expect(store.getState().enabled).toBe(true);

    const off = store.setEnabled(false, { updatedBy: "cli" });
    expect(off.enabled).toBe(false);
    expect(() => store.assertCanSee()).toThrow(HandyPermissionError);
    expect(() => store.assertCanControl()).toThrow(HandyPermissionError);

    if (process.platform !== "win32") {
      const mode = statSync(store.filePath).mode & 0o777;
      expect(mode).toBe(0o600);
    }

    const toggled = store.toggle({ updatedBy: "cli" });
    expect(toggled.enabled).toBe(true);
    expect(store.assertCanControl().enabled).toBe(true);
  });

  it("supports view_only mode (allows screen viewing, blocks mouse/keyboard)", () => {
    store.setEnabled(true, { mode: "view_only", updatedBy: "cli" });
    expect(store.assertCanSee().mode).toBe("view_only");
    expect(() => store.assertCanControl()).toThrow(HandyPermissionError);
  });

  it("auto-expires permissions when ttlMs elapses", async () => {
    expect(parseDurationMs("2s")).toBe(2000);
    expect(parseDurationMs("5m")).toBe(300_000);

    store.setEnabled(true, { ttlMs: 35, updatedBy: "cli" });
    expect(store.getState().enabled).toBe(true);

    await new Promise((r) => setTimeout(r, 55));
    const expired = store.getState();
    expect(expired.enabled).toBe(false);
    expect(expired.updatedBy).toBe("expired");
  });

  it("prevents MCP from re-enabling Handy after user turns it OFF unless HANDY_ALLOW_MCP_ENABLE=true", () => {
    // MCP can turn Handy OFF safely
    const off = store.setEnabled(false, { updatedBy: "mcp" });
    expect(off.enabled).toBe(false);

    // MCP cannot turn Handy back ON by default
    expect(() => store.setEnabled(true, { updatedBy: "mcp" })).toThrow(HandyPermissionError);
    expect(store.getState().enabled).toBe(false);

    // User CLI can turn Handy back ON
    expect(store.setEnabled(true, { updatedBy: "cli" }).enabled).toBe(true);

    // MCP cannot escalate view_only -> full or clear/extend a user-set TTL
    store.setEnabled(true, { mode: "view_only", ttlMs: 60_000, updatedBy: "cli" });
    const initialExp = store.getState().expiresAt!;
    expect(initialExp).toBeTruthy();
    expect(() => store.setEnabled(true, { mode: "full", updatedBy: "mcp" })).toThrow(HandyPermissionError);

    // Calling MCP with view_only and no ttlMs must preserve the user's TTL expiration
    const preserved = store.setEnabled(true, { mode: "view_only", updatedBy: "mcp" });
    expect(preserved.mode).toBe("view_only");
    expect(preserved.expiresAt).toBe(initialExp);
  });

  it("aborts visual polling loops (wait_for_settled) immediately when permission is revoked mid-poll", async () => {
    const backend = new VirtualDesktopBackend();
    const controller = new HandyController({ backend, permissions: store });

    setTimeout(() => {
      store.setEnabled(false, { updatedBy: "cli" });
    }, 35);

    await expect(
      controller.act({
        actions: [
          { type: "mouse_down", x: 780, y: 180 },
          { type: "wait_for_settled", quietMs: 400, pollMs: 25, timeoutMs: 1500 },
        ],
      }),
    ).rejects.toBeInstanceOf(HandyPermissionError);

    expect(backend.state.draggingCard).toBe(false);
    await controller.close();
  });

  it("aborts an in-flight chained action immediately when toggled OFF mid-chain and releases held inputs", async () => {
    const backend = new VirtualDesktopBackend();
    const controller = new HandyController({ backend, permissions: store });

    // Toggle OFF after 40ms while chain is waiting at step 2
    setTimeout(() => {
      store.setEnabled(false, { updatedBy: "cli" });
    }, 40);

    await expect(
      controller.act({
        actions: [
          { type: "mouse_down", x: 780, y: 180 },
          { type: "wait", ms: 90 },
          { type: "move", x: 250, y: 172 },
          { type: "click" },
          { type: "type", text: "ShouldNotType" },
        ],
      }),
    ).rejects.toBeInstanceOf(HandyPermissionError);

    expect(backend.state.fields.name).toBe("");
    // Held drag/mouse button must have been cleanly released by failsafe cleanup
    expect(backend.state.draggingCard).toBe(false);
    await controller.close();
  });
});
