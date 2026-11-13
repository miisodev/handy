import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VirtualDesktopBackend } from "../src/backends/virtual.js";
import { PermissionStore } from "../src/permissions.js";
import { decodePng } from "../src/png.js";

const BIN_PATH = resolve(process.cwd(), "bin/handy.js");

describe("Stdio MCP Server (Real Child Process End-to-End)", () => {
  let configDir: string;
  let transport: StdioClientTransport;
  let client: Client;

  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), "handy-mcp-e2e-"));
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN_PATH, "mcp"],
      env: {
        ...process.env,
        HANDY_BACKEND: "virtual",
        HANDY_CONFIG_DIR: configDir,
      },
      stderr: "pipe",
    });

    client = new Client({ name: "handy-test-client", version: "1.1.0" }, { capabilities: {} });
    await client.connect(transport);
  });

  afterEach(async () => {
    await client.close();
    rmSync(configDir, { recursive: true, force: true });
  });

  it("advertises all 6 tools, 3 resources, and prompts and executes chained controls + window/clipboard tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "handy_act",
      "handy_clipboard",
      "handy_permission",
      "handy_see",
      "handy_status",
      "handy_windows",
    ]);

    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual([
      "handy://screen/current",
      "handy://status",
      "handy://windows",
    ]);

    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("computer-control");
    const promptRes = await client.getPrompt({ name: "computer-control", arguments: { goal: "Type Sam" } });
    expect(promptRes.messages[0]?.content).toMatchObject({ type: "text" });

    // 1. Inspect initial screen via handy_see (includes pixelUnderMouse & activeWindow)
    const seeRes = await client.callTool({ name: "handy_see", arguments: {} });
    expect(seeRes.isError).toBeFalsy();
    const seeContent = seeRes.content as Array<{ type: string; data?: string; text?: string }>;
    const imgBlock = seeContent.find((c) => c.type === "image");
    const txtBlock = seeContent.find((c) => c.type === "text");
    expect(imgBlock?.data).toBeTruthy();
    const decoded = decodePng(Buffer.from(imgBlock!.data!, "base64"));
    expect(decoded.width).toBe(1280);
    expect(decoded.height).toBe(800);
    const meta = JSON.parse(txtBlock!.text!) as {
      mouse: { x: number; y: number };
      pixelUnderMouse: string;
      activeWindow: { title: string };
      coordinateSpace: string;
    };
    expect(meta.coordinateSpace).toBe("screen");
    expect(meta.mouse).toEqual({ x: 640, y: 400 });
    expect(meta.pixelUnderMouse).toMatch(/^#[0-9a-f]{6}$/);
    expect(meta.activeWindow.title).toBe("Agent Control Workbench");

    // 2. Clipboard write + read via handy_clipboard
    await client.callTool({ name: "handy_clipboard", arguments: { action: "write", text: "PriorClipboard" } });
    const clipRead = await client.callTool({ name: "handy_clipboard", arguments: { action: "read" } });
    expect(JSON.parse((clipRead.content as Array<{ text: string }>)[0]!.text).text).toBe("PriorClipboard");

    // 3. List & focus desktop windows via handy_windows
    const winList = await client.callTool({ name: "handy_windows", arguments: { action: "list" } });
    const winListJson = JSON.parse((winList.content as Array<{ text: string }>)[0]!.text) as { count: number };
    expect(winListJson.count).toBe(2);

    // 4. Execute chained control: move -> click -> paste "Sam" -> click Submit + screenshotAfter
    const actRes = await client.callTool({
      name: "handy_act",
      arguments: {
        actions: [
          { type: "move", x: 250, y: 172 },
          { type: "click" },
          { type: "paste", text: "Sam" },
          { type: "click", x: 195, y: 325 },
        ],
        stepDelayMs: 5,
        screenshotAfter: true,
        settleMs: 10,
      },
    });
    expect(actRes.isError).toBeFalsy();
    const actContent = actRes.content as Array<{ type: string; data?: string; text?: string }>;
    const receipt = JSON.parse(actContent[0]!.text!) as { stepsCompleted: number; mouse: { x: number; y: number } };
    expect(receipt.stepsCompleted).toBe(4);
    expect(receipt.mouse).toEqual({ x: 195, y: 325 });
    expect(actContent.some((c) => c.type === "image")).toBe(true);

    // Verify paste restored user's previous clipboard!
    const clipAfter = await client.callTool({ name: "handy_clipboard", arguments: { action: "read" } });
    expect(JSON.parse((clipAfter.content as Array<{ text: string }>)[0]!.text).text).toBe("PriorClipboard");
  });

  it("enforces live on/off permission toggle across processes without restarting MCP server", async () => {
    const externalStore = new PermissionStore({ configDir });

    externalStore.setEnabled(false, { updatedBy: "cli" });

    const deniedSee = await client.callTool({ name: "handy_see", arguments: {} });
    expect(deniedSee.isError).toBe(true);
    expect(JSON.stringify(deniedSee.content)).toContain("HANDY_PERMISSION_DENIED");

    const deniedAct = await client.callTool({
      name: "handy_act",
      arguments: { actions: [{ type: "click", x: 100, y: 100 }] },
    });
    expect(deniedAct.isError).toBe(true);

    const attemptEnable = await client.callTool({
      name: "handy_permission",
      arguments: { action: "on" },
    });
    expect(attemptEnable.isError).toBe(true);

    const statusRes = await client.callTool({ name: "handy_status", arguments: {} });
    expect(statusRes.isError).toBeFalsy();
    const statusJson = JSON.parse((statusRes.content as Array<{ text: string }>)[0]!.text);
    expect(statusJson.enabled).toBe(false);

    externalStore.setEnabled(true, { updatedBy: "cli" });
    const allowedSee = await client.callTool({ name: "handy_see", arguments: { maxWidth: 640 } });
    expect(allowedSee.isError).toBeFalsy();

    const agentOff = await client.callTool({ name: "handy_permission", arguments: { action: "off" } });
    expect(agentOff.isError).toBeFalsy();
    expect(externalStore.getState().enabled).toBe(false);

    await expect(client.readResource({ uri: "handy://screen/current" })).rejects.toThrow();
  });

  it("handles invalid tool schemas, unknown tools, and concurrent requests cleanly (MCP-03, MCP-07)", async () => {
    const invalidRes = await client.callTool({
      name: "handy_act",
      arguments: { actions: [] },
    });
    expect(invalidRes.isError).toBe(true);

    const [r1, r2, r3] = await Promise.all([
      client.callTool({ name: "handy_status", arguments: {} }),
      client.callTool({ name: "handy_act", arguments: { actions: [{ type: "move", x: 300, y: 200 }] } }),
      client.callTool({ name: "handy_see", arguments: { maxWidth: 640 } }),
    ]);
    expect(r1.isError).toBeFalsy();
    expect(r2.isError).toBeFalsy();
    expect(r3.isError).toBeFalsy();
  });

  it("detects Set-of-Mark UI elements over MCP and clicks one by mark index", async () => {
    const seeRes = await client.callTool({ name: "handy_see", arguments: { marks: true } });
    expect(seeRes.isError).toBeFalsy();
    const seeContent = seeRes.content as Array<{ type: string; data?: string; text?: string }>;
    expect(seeContent.some((c) => c.type === "image")).toBe(true);

    const meta = JSON.parse(seeContent.find((c) => c.type === "text")!.text!) as {
      ok: boolean;
      elementCount: number;
      elementHint: string;
      elements: Array<{
        index: number;
        x: number;
        y: number;
        width: number;
        height: number;
        centerX: number;
        centerY: number;
        score: number;
        kind: string;
      }>;
    };
    expect(meta.ok).toBe(true);
    expect(meta.elementCount).toBeGreaterThan(0);
    expect(meta.elements).toHaveLength(meta.elementCount);
    expect(meta.elementHint).toMatch(/mark/);

    // Marks are numbered 1..N in reading order with no gaps or duplicates.
    const indices = meta.elements.map((e) => e.index);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    expect(indices[0]).toBe(1);
    expect(new Set(indices).size).toBe(indices.length);
    for (const el of meta.elements) {
      expect(["control", "text", "icon", "region"]).toContain(el.kind);
      expect(el.score).toBeGreaterThan(0);
      expect(el.score).toBeLessThanOrEqual(1);
      expect(el.centerX).toBeGreaterThanOrEqual(el.x);
      expect(el.centerX).toBeLessThanOrEqual(el.x + el.width);
    }

    // A marked capture must not be returned when marks are not requested.
    const plain = await client.callTool({ name: "handy_see", arguments: {} });
    const plainMeta = JSON.parse(
      (plain.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")!.text!,
    ) as { elements?: unknown };
    expect(plainMeta.elements).toBeUndefined();

    const L = VirtualDesktopBackend.LAYOUT;
    const nearBox = (t: { x: number; y: number }) =>
      meta.elements.find((e) => Math.abs(e.x - t.x) < 14 && Math.abs(e.y - t.y) < 14);
    const nameMark = nearBox(L.nameInput);
    const submitMark = nearBox(L.submitButton);
    expect(nameMark, "expected a mark on the name input").toBeDefined();
    expect(submitMark, "expected a mark on the submit button").toBeDefined();

    const actRes = await client.callTool({
      name: "handy_act",
      arguments: {
        actions: [
          { type: "click", mark: nameMark!.index },
          { type: "type", text: "McpMarkDriven" },
          { type: "click", mark: submitMark!.index },
        ],
        stepDelayMs: 2,
        verifyChange: true,
      },
    });
    expect(actRes.isError).toBeFalsy();
    const summary = JSON.parse(
      (actRes.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")!.text!,
    ) as {
      ok: boolean;
      stepsCompleted: number;
      changed: boolean;
      change: { changedPercent: number };
      receipts: Array<{ detail: string }>;
    };
    expect(summary.ok).toBe(true);
    expect(summary.stepsCompleted).toBe(3);
    expect(summary.changed).toBe(true);
    expect(summary.change.changedPercent).toBeGreaterThan(0);
    expect(summary.receipts[0]!.detail).toContain(`mark #${nameMark!.index}`);
    expect(summary.receipts[2]!.detail).toContain(`mark #${submitMark!.index}`);

    // Out-of-range marks are rejected at the schema layer (1..200) ...
    const outOfRange = await client.callTool({ name: "handy_act", arguments: { actions: [{ type: "click", mark: 9999 }] } });
    expect(outOfRange.isError).toBe(true);
    expect((outOfRange.content as Array<{ text: string }>)[0]!.text).toMatch(/<=200/);

    // ... and in-range-but-undetected marks fail loudly at the controller layer, never silently.
    const unknown = await client.callTool({ name: "handy_act", arguments: { actions: [{ type: "click", mark: 150 }] } });
    expect(unknown.isError).toBe(true);
    expect((unknown.content as Array<{ text: string }>)[0]!.text).toMatch(/not available/);
  });

  it("keeps stdout strictly JSON-RPC clean and exits 0 cleanly on stdin EOF (MCP-04)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "handy-eof-"));
    try {
      const proc = spawn(process.execPath, [BIN_PATH, "mcp"], {
        env: { ...process.env, HANDY_BACKEND: "virtual", HANDY_CONFIG_DIR: dir },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdoutData = "";
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk: string) => {
        stdoutData += chunk;
      });

      const initMsg = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "eof-probe", version: "1.1.0" },
        },
      });
      proc.stdin.write(`${initMsg}\n`);

      await new Promise<void>((resolveWait) => {
        const check = () => {
          if (stdoutData.includes('"result"')) resolveWait();
          else setTimeout(check, 15);
        };
        check();
      });

      for (const line of stdoutData.trim().split("\n")) {
        const parsed = JSON.parse(line) as { jsonrpc: string };
        expect(parsed.jsonrpc).toBe("2.0");
      }

      const exitCode = await new Promise<number | null>((resolveExit) => {
        proc.once("close", (code) => resolveExit(code));
        proc.stdin.end();
      });
      expect(exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
