import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installHandyToHosts, uninstallHandyFromHosts } from "../src/installer.js";

/**
 * `handy install` walks every supported host in one pass and writes into real user config files,
 * so a single unreadable file must not abort the run, and the backup it leaves behind must stay a
 * usable restore point.
 */
describe("Installer resilience against malformed host configs", () => {
  let home: string;

  const cursorPath = () => join(home, ".cursor", "mcp.json");
  const claudeCodePath = () => join(home, ".claude.json");

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "handy-installer-"));
    mkdirSync(join(home, ".cursor"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("reports a corrupt config as skipped instead of throwing out of the whole run", () => {
    // A trailing comma is the realistic case: several editors and hosts write JSONC.
    writeFileSync(cursorPath(), '{ "mcpServers": { "other": { "command": "x" }, } }');

    const results = installHandyToHosts("cursor", { homeDir: home, platform: "darwin" });

    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe("skipped");
    expect(results[0]!.detail).toMatch(/not valid JSON/);
    expect(results[0]!.detail).toContain("mcp.json");
    // The user's file must be left exactly as it was — no partial write, no truncation.
    expect(readFileSync(cursorPath(), "utf8")).toBe('{ "mcpServers": { "other": { "command": "x" }, } }');
  });

  it("installs into the healthy hosts even when a sibling host config is corrupt", () => {
    // cursor is corrupt; claude-code is a valid existing config. Both are in the same run.
    writeFileSync(cursorPath(), "{ this is not json at all");
    writeFileSync(claudeCodePath(), JSON.stringify({ mcpServers: { existing: { command: "keep-me" } } }));

    const results = installHandyToHosts("all", { homeDir: home, platform: "darwin" });
    const byHost = new Map(results.map((r) => [r.host, r]));

    expect(byHost.get("cursor")!.action).toBe("skipped");
    expect(byHost.get("cursor")!.detail).toMatch(/not valid JSON/);

    // The healthy host still got installed, and its pre-existing server was preserved.
    expect(byHost.get("claude-code")!.action).toBe("updated");
    const written = JSON.parse(readFileSync(claudeCodePath(), "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(written.mcpServers.existing).toEqual({ command: "keep-me" });
    expect(written.mcpServers.handy?.args).toContain("mcp");
  });

  it("reports a corrupt config as skipped on uninstall too, leaving the file untouched", () => {
    writeFileSync(cursorPath(), "[]"); // valid JSON, but an array rather than an object

    const results = uninstallHandyFromHosts("cursor", { homeDir: home, platform: "darwin" });
    expect(results[0]!.action).toBe("skipped");
    expect(results[0]!.detail).toMatch(/Expected a JSON object/);
    expect(readFileSync(cursorPath(), "utf8")).toBe("[]");
  });

  it("never overwrites the pristine backup on a second run", () => {
    const original = JSON.stringify({ mcpServers: { other: { command: "original" } } }, null, 2);
    writeFileSync(cursorPath(), original);

    const first = installHandyToHosts("cursor", { homeDir: home, platform: "darwin" });
    expect(first[0]!.action).toBe("updated");
    const backupPath = `${cursorPath()}.handy.bak`;
    expect(first[0]!.backupPath).toBe(backupPath);
    expect(readFileSync(backupPath, "utf8")).toBe(original);

    // Change the entry Handy would write so the second run is not a no-op, then re-install.
    const mutated = JSON.parse(readFileSync(cursorPath(), "utf8")) as {
      mcpServers: { handy: { command: string; args: string[] } };
    };
    mutated.mcpServers.handy.args = ["-y", "@miisodev/handy@older", "mcp"];
    writeFileSync(cursorPath(), JSON.stringify(mutated, null, 2));

    const second = installHandyToHosts("cursor", { homeDir: home, platform: "darwin" });
    expect(second[0]!.action).toBe("updated");
    expect(second[0]!.backupPath).toBe(backupPath);

    // The backup must still be the user's pre-Handy original, not the intermediate state.
    expect(readFileSync(backupPath, "utf8")).toBe(original);
  });

  it("does not report a backup path for a newly created config or a dry run", () => {
    const fresh = installHandyToHosts("cursor", { homeDir: home, platform: "darwin" });
    expect(fresh[0]!.action).toBe("installed");
    expect(fresh[0]!.backupPath).toBeUndefined();

    const secondHome = mkdtempSync(join(tmpdir(), "handy-installer-dry-"));
    try {
      mkdirSync(join(secondHome, ".cursor"), { recursive: true });
      writeFileSync(join(secondHome, ".cursor", "mcp.json"), "{}");
      const dry = installHandyToHosts("cursor", { homeDir: secondHome, platform: "darwin", dryRun: true });
      expect(dry[0]!.action).toBe("updated");
      expect(dry[0]!.dryRun).toBe(true);
      expect(dry[0]!.detail).toMatch(/Dry run/);
      expect(dry[0]!.backupPath).toBeUndefined();
      // Nothing at all is written on a dry run: no backup, and the config is untouched.
      expect(existsSync(join(secondHome, ".cursor", "mcp.json.handy.bak"))).toBe(false);
      expect(readFileSync(join(secondHome, ".cursor", "mcp.json"), "utf8")).toBe("{}");
    } finally {
      rmSync(secondHome, { recursive: true, force: true });
    }
  });

  it("survives an unreadable config file (permissions denied)", () => {
    // Skipped on Windows, where POSIX permission bits do not prevent the owner from reading,
    // and as root, where 0o000 is still readable so EACCES cannot be provoked.
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    writeFileSync(cursorPath(), '{"mcpServers":{}}');
    chmodSync(cursorPath(), 0o000);
    try {
      const results = installHandyToHosts("cursor", { homeDir: home, platform: "darwin" });
      expect(results[0]!.action).toBe("skipped");
      expect(results[0]!.detail).toMatch(/Could not read/);
    } finally {
      chmodSync(cursorPath(), 0o644);
    }
  });
});
