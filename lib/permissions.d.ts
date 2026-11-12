import type { PermissionMode, PermissionState } from "./types.js";
export declare class HandyPermissionError extends Error {
    readonly code = "HANDY_PERMISSION_DENIED";
    readonly state: PermissionState;
    constructor(message: string, state: PermissionState);
}
export declare function resolveConfigDir(overrideDir?: string): string;
export declare function parseDurationMs(input: string): number;
export interface PermissionStoreOptions {
    configDir?: string;
    allowMcpEnable?: boolean;
}
export declare class PermissionStore {
    readonly configDir: string;
    readonly filePath: string;
    private readonly allowMcpEnableOption?;
    constructor(options?: PermissionStoreOptions);
    get allowMcpEnable(): boolean;
    getState(): PermissionState;
    setEnabled(enabled: boolean, options?: {
        mode?: PermissionMode;
        ttlMs?: number | null;
        updatedBy?: "cli" | "mcp" | "ui";
    }): PermissionState;
    toggle(options?: {
        mode?: PermissionMode;
        updatedBy?: "cli";
    }): PermissionState;
    assertCanSee(): PermissionState;
    assertCanControl(): PermissionState;
    watch(onChange: (state: PermissionState) => void): () => void;
    private getMtimeMs;
    private ensureDir;
    private readDiskState;
    private writeDiskState;
}
