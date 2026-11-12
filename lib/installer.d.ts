export type McpHostTarget = "claude-desktop" | "cursor" | "windsurf" | "claude-code";
export interface HostInstallResult {
    host: McpHostTarget;
    configPath: string;
    action: "installed" | "updated" | "removed" | "unchanged" | "skipped";
    backupPath?: string;
    dryRun: boolean;
    detail: string;
}
export interface InstallerEnvOptions {
    platform?: NodeJS.Platform;
    homeDir?: string;
    appDataDir?: string;
    dryRun?: boolean;
}
export declare const SUPPORTED_MCP_HOSTS: readonly McpHostTarget[];
export declare function resolveHostConfigPath(host: McpHostTarget, env?: InstallerEnvOptions): string;
export declare function buildHandyMcpEntry(platform?: NodeJS.Platform): {
    command: string;
    args: string[];
};
export declare function installHandyToHosts(target?: McpHostTarget | "all", env?: InstallerEnvOptions): HostInstallResult[];
export declare function uninstallHandyFromHosts(target?: McpHostTarget | "all", env?: InstallerEnvOptions): HostInstallResult[];
