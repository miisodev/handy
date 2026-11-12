import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

    client = new Client({ name: "handy-test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
  });

  afterEach(async () => {
    await client.close();
    rmSync(configDir, { recursive: true, force: true });
  });

  it("advertises tools, resources, and prompts and executes chained controls + live screen vision", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["handy_act", "handy_permission", "handy_see", "handy_status"]);

    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual(["handy://screen/current", "handy://status"]);

    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("computer-control");
    const promptRes = await client.getPrompt({ name: "computer-control", arguments: { goal: "Type Sam" } });
    expect(promptRes.messages[0]?.content).toMatchObject({ type: "text" });

    // 1. Inspect initial screen via handy_see
    const seeRes = await client.callTool({ name: "handy_see", arguments: {} });
    expect(seeRes.isError).toBeFalsy();
    const seeContent = seeRes.content as Array<{ type: string; data?: string; text?: string }>;
    const imgBlock = seeContent.find((c) => c.type === "image");
    const txtBlock = seeContent.find((c) => c.type === "text");
    expect(imgBlock?.data).toBeTruthy();
    const decoded = decodePng(Buffer.from(imgBlock!.data!, "base64"));
    expect(decoded.width).toBe(1280);
    expect(decoded.height).toBe(800);
    const meta = JSON.parse(txtBlock!.text!) as { mouse: { x: number; y: number }; coordinateSpace: string };
    expect(meta.coordinateSpace).toBe("screen");
    expect(meta.mouse).toEqual({ x: 640, y: 400 });

    // 2. Execute chained control: move -> click -> type "Sam" -> click Submit + screenshotAfter
    const actRes = await client.callTool({
      name: "handy_act",
      arguments: {
        actions: [
          { type: "move", x: 250, y: 172 },
          { type: "click" },
          { type: "type", text: "Sam" },
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
  });

  it("enforces live on/off permission toggle across processes without restarting MCP server", async () => {
    const externalStore = new PermissionStore({ configDir });

    // User flips Handy OFF externally (`handy off`)
    externalStore.setEnabled(false, { updatedBy: "cli" });

    const deniedSee = await client.callTool({ name: "handy_see", arguments: {} });
    expect(deniedSee.isError).toBe(true);
    expect(JSON.stringify(deniedSee.content)).toContain("HANDY_PERMISSION_DENIED");

    const deniedAct = await client.callTool({
      name: "handy_act",
      arguments: { actions: [{ type: "click", x: 100, y: 100 }] },
    });
    expect(deniedAct.isError).toBe(true);

    // MCP cannot self-enable after user turned it OFF
    const attemptEnable = await client.callTool({
      name: "handy_permission",
      arguments: { action: "on" },
    });
    expect(attemptEnable.isError).toBe(true);

    // Status still works cleanly and reports enabled: false
    const statusRes = await client.callTool({ name: "handy_status", arguments: {} });
    expect(statusRes.isError).toBeFalsy();
    const statusJson = JSON.parse((statusRes.content as Array<{ text: string }>)[0]!.text);
    expect(statusJson.enabled).toBe(false);

    // User flips Handy back ON externally (`handy on`) -> works immediately!
    externalStore.setEnabled(true, { updatedBy: "cli" });
    const allowedSee = await client.callTool({ name: "handy_see", arguments: { maxWidth: 640 } });
    expect(allowedSee.isError).toBeFalsy();

    // Agent CAN safely turn Handy OFF via handy_permission({ action: "off" })
    const agentOff = await client.callTool({ name: "handy_permission", arguments: { action: "off" } });
    expect(agentOff.isError).toBeFalsy();
    expect(externalStore.getState().enabled).toBe(false);

    // Resource read of live screen while OFF must also be denied (MCP-11)
    await expect(client.readResource({ uri: "handy://screen/current" })).rejects.toThrow();
  });

  it("handles invalid tool schemas, unknown tools, and concurrent requests cleanly (MCP-03, MCP-07)", async () => {
    // Empty actions array violates min(1) schema
    const invalidRes = await client.callTool({
      name: "handy_act",
      arguments: { actions: [] },
    });
    expect(invalidRes.isError).toBe(true);

    // Concurrent calls serialize safely without corrupting responses
    const [r1, r2, r3] = await Promise.all([
      client.callTool({ name: "handy_status", arguments: {} }),
      client.callTool({ name: "handy_act", arguments: { actions: [{ type: "move", x: 300, y: 200 }] } }),
      client.callTool({ name: "handy_see", arguments: { maxWidth: 640 } }),
    ]);
    expect(r1.isError).toBeFalsy();
    expect(r2.isError).toBeFalsy();
    expect(r3.isError).toBeFalsy();
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
          clientInfo: { name: "eof-probe", version: "1.0.0" },
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

      // Every non-empty line on stdout must parse as valid JSON-RPC 2.0
      for (const line of stdoutData.trim().split("\n")) {
        const parsed = JSON.parse(line) as { jsonrpc: string };
        expect(parsed.jsonrpc).toBe("2.0");
      }

      // Close stdin -> process must exit cleanly with code 0
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
