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
function readJsonObject(filePath) {
    if (!existsSync(filePath))
        return {};
    const raw = readFileSync(filePath, "utf8").trim();
    if (!raw)
        return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Expected JSON object in ${filePath}`);
    }
    return parsed;
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
        const doc = readJsonObject(configPath);
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
            if (fileExisted) {
                backupPath = `${configPath}.handy.bak`;
                copyFileSync(configPath, backupPath);
            }
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
        const doc = readJsonObject(configPath);
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
            backupPath = `${configPath}.handy.bak`;
            copyFileSync(configPath, backupPath);
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
