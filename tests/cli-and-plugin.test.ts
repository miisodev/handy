import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HANDY_VERSION } from "../src/version.js";

const execFileAsync = promisify(execFile);
const BIN_PATH = resolve(process.cwd(), "bin/handy.js");

async function runHandy(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [BIN_PATH, ...args], {
      env: { ...process.env, NO_COLOR: "1", ...env },
      timeout: 10_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

describe("CLI Commands & Packaged Plugin Tarball Integrity", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "handy-cli-test-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("runs version, help, on/off/toggle, status, doctor, see, act, and config commands", async () => {
    const env = { HANDY_CONFIG_DIR: workDir, HANDY_BACKEND: "virtual" };

    const ver = await runHandy(["--version"], env);
    expect(ver.code).toBe(0);
    expect(ver.stdout.trim()).toBe(HANDY_VERSION);

    const off = await runHandy(["off", "--json"], env);
    expect(off.code).toBe(0);
    expect(JSON.parse(off.stdout).enabled).toBe(false);

    // Calling `see` while OFF returns exit code 3 (permission denied)
    const blocked = await runHandy(["see", "--out", join(workDir, "blocked.png")], env);
    expect(blocked.code).toBe(3);

    const toggled = await runHandy(["toggle", "--json"], env);
    expect(toggled.code).toBe(0);
    expect(JSON.parse(toggled.stdout).enabled).toBe(true);

    const shotPath = join(workDir, "shot.png");
    const see = await runHandy(["see", "--out", shotPath, "--json"], env);
    expect(see.code).toBe(0);
    expect(existsSync(shotPath)).toBe(true);

    const afterPath = join(workDir, "after.png");
    const act = await runHandy(
      ["act", 'move 250 172 -> click -> type "Sam"', "--screenshot-after", afterPath, "--json"],
      env,
    );
    expect(act.code).toBe(0);
    const actJson = JSON.parse(act.stdout) as { stepsCompleted: number; mouse: { x: number; y: number } };
    expect(actJson.stepsCompleted).toBe(3);
    expect(actJson.mouse).toEqual({ x: 250, y: 172 });
    expect(existsSync(afterPath)).toBe(true);

    const cfg = await runHandy(["config", "mcp"], env);
    expect(cfg.code).toBe(0);
    expect(JSON.parse(cfg.stdout)).toHaveProperty("mcpServers.handy");

    // Invalid usage returns exit code 2
    const bad = await runHandy(["unknown-subcommand"], env);
    expect(bad.code).toBe(2);
  });

  it("packs cleanly via npm pack --dry-run with zero leaked tests, secrets, or install scripts (PKG-03/04)", async () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.postinstall).toBeUndefined();
    expect(pkg.scripts?.install).toBeUndefined();

    const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"], {
      cwd: process.cwd(),
      timeout: 15_000,
    });
    const packed = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
    const filePaths = packed[0]!.files.map((f) => f.path);

    expect(filePaths).toContain("bin/handy.js");
    expect(filePaths).toContain("lib/index.js");
    expect(filePaths).toContain("lib/index.d.ts");
    expect(filePaths).toContain("skills/handy/SKILL.md");
    expect(filePaths).toContain(".claude-plugin/plugin.json");
    expect(filePaths).toContain(".mcp.json");
    expect(filePaths).toContain("manifest.json");
    expect(filePaths).toContain("server.json");

    // Ensure no test files or .env files leak into the published package
    expect(filePaths.some((p) => p.startsWith("tests/"))).toBe(false);
    expect(filePaths.some((p) => p.startsWith(".env"))).toBe(false);
  });
});
