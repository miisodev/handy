import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
export const SUPPORTED_MCP_HOSTS = [
    "claude-desktop",
    "cursor",
    "windsurf",
    "claude-code",
];
export function resolveHostConfigPath(host, env = {}) {
    const platform = env.platform ?? process.platform;
    const home = env.homeDir ?? homedir();
    const appData = env.appDataDir ?? process.env.APPDATA ?? join(home, "AppData", "Roaming");
    switch (host) {
        case "claude-desktop": {
            if (platform === "darwin") {
                return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
            }
            if (platform === "win32") {
                return join(appData, "Claude", "claude_desktop_config.json");
            }
            return join(home, ".config", "Claude", "claude_desktop_config.json");
        }
        case "cursor":
            return join(home, ".cursor", "mcp.json");
        case "windsurf":
            return join(home, ".codeium", "windsurf", "mcp_config.json");
        case "claude-code":
            return join(home, ".claude.json");
    }
}
export function buildHandyMcpEntry(platform = process.platform) {
    // On Windows, GUI hosts (Claude Desktop / Cursor) resolve cmd.exe /c npx reliably without ENOENT
    if (platform === "win32") {
        return {
            command: "cmd",
            args: ["/c", "npx", "-y", "@miisodev/handy", "mcp"],
        };
    }
    return {
        command: "npx",
        args: ["-y", "@miisodev/handy", "mcp"],
    };
}
/**
 * Reads a host config as a JSON object, reporting a malformed file as a result rather than
 * throwing. `handy install` walks every supported host in one pass, and hosts do write
 * near-JSON files in practice — trailing commas, comments, a half-written file from a crashed
 * editor. Letting one unreadable config throw would abort the loop and leave the healthy hosts
 * uninstalled, so the caller records a `skipped` result naming the file and the parse error and
 * carries on.
 */
function readJsonObject(filePath) {
    if (!existsSync(filePath))
        return { doc: {} };
    let raw;
    try {
        raw = readFileSync(filePath, "utf8").trim();
    }
    catch (error) {
        return { error: `Could not read ${filePath}: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!raw)
        return { doc: {} };
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        return {
            error: `${filePath} is not valid JSON (${error instanceof Error ? error.message : String(error)}). ` +
                `Fix or remove the file, then re-run; Handy left it untouched.`,
        };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { error: `Expected a JSON object in ${filePath}` };
    }
    return { doc: parsed };
}
/**
 * Backs up the user's config before Handy modifies it, but never overwrites an existing backup.
 * A second run would otherwise replace the pristine pre-Handy original with a copy that already
 * contains Handy's entry, destroying the only clean restore point.
 */
function backupOnce(configPath) {
    const backupPath = `${configPath}.handy.bak`;
    if (!existsSync(backupPath))
        copyFileSync(configPath, backupPath);
    return backupPath;
}
function atomicWriteJson(filePath, data) {
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.tmp.${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    renameSync(tmp, filePath);
}
export function installHandyToHosts(target = "all", env = {}) {
    const platform = env.platform ?? process.platform;
    const dryRun = Boolean(env.dryRun);
    const hosts = target === "all" ? [...SUPPORTED_MCP_HOSTS] : [target];
    const entry = buildHandyMcpEntry(platform);
    const results = [];
    for (const host of hosts) {
        const configPath = resolveHostConfigPath(host, env);
        const parentExists = existsSync(dirname(configPath)) || existsSync(configPath);
        // When target === "all", install into hosts whose config file or parent folder exists,
        // plus always cursor / claude-code if no host directories exist yet so `handy install` never no-ops silently
        if (target === "all" && !parentExists && host !== "claude-desktop" && host !== "cursor") {
            results.push({
                host,
                configPath,
                action: "skipped",
                dryRun,
                detail: "Host directory not present on this machine",
            });
            continue;
        }
        const fileExisted = existsSync(configPath);
        const read = readJsonObject(configPath);
        if ("error" in read) {
            results.push({ host, configPath, action: "skipped", dryRun, detail: read.error });
            continue;
        }
        const doc = read.doc;
        const servers = doc.mcpServers && typeof doc.mcpServers === "object" && !Array.isArray(doc.mcpServers)
            ? { ...doc.mcpServers }
            : {};
        const prev = JSON.stringify(servers.handy ?? null);
        const next = JSON.stringify(entry);
        if (prev === next) {
            results.push({
                host,
                configPath,
                action: "unchanged",
                dryRun,
                detail: "Handy MCP server already configured",
            });
            continue;
        }
        servers.handy = entry;
        const updatedDoc = { ...doc, mcpServers: servers };
        let backupPath;
        if (!dryRun) {
            if (fileExisted)
                backupPath = backupOnce(configPath);
            atomicWriteJson(configPath, updatedDoc);
        }
        results.push({
            host,
            configPath,
            action: fileExisted ? "updated" : "installed",
            backupPath,
            dryRun,
            detail: dryRun ? "Dry run — would write Handy MCP configuration" : "Configured Handy MCP server",
        });
    }
    return results;
}
export function uninstallHandyFromHosts(target = "all", env = {}) {
    const dryRun = Boolean(env.dryRun);
    const hosts = target === "all" ? [...SUPPORTED_MCP_HOSTS] : [target];
    const results = [];
    for (const host of hosts) {
        const configPath = resolveHostConfigPath(host, env);
        if (!existsSync(configPath)) {
            results.push({
                host,
                configPath,
                action: "skipped",
                dryRun,
                detail: "Config file does not exist",
            });
            continue;
        }
        const read = readJsonObject(configPath);
        if ("error" in read) {
            results.push({ host, configPath, action: "skipped", dryRun, detail: read.error });
            continue;
        }
        const doc = read.doc;
        const servers = doc.mcpServers && typeof doc.mcpServers === "object" && !Array.isArray(doc.mcpServers)
            ? { ...doc.mcpServers }
            : {};
        if (!("handy" in servers)) {
            results.push({
                host,
                configPath,
                action: "unchanged",
                dryRun,
                detail: "Handy entry not present",
            });
            continue;
        }
        delete servers.handy;
        const updatedDoc = { ...doc, mcpServers: servers };
        let backupPath;
        if (!dryRun) {
            backupPath = backupOnce(configPath);
            atomicWriteJson(configPath, updatedDoc);
        }
        results.push({
            host,
            configPath,
            action: "removed",
            backupPath,
            dryRun,
            detail: dryRun ? "Dry run — would remove Handy MCP entry" : "Removed Handy MCP entry",
        });
    }
    return results;
}
