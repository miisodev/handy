import { existsSync, mkdirSync, readFileSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PermissionMode, PermissionState } from "./types.js";

export class HandyPermissionError extends Error {
  readonly code = "HANDY_PERMISSION_DENIED";
  readonly state: PermissionState;

  constructor(message: string, state: PermissionState) {
    super(message);
    this.name = "HandyPermissionError";
    this.state = state;
  }
}

function parseBoolEnv(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "" || normalized === "${user_config.enabled}") return undefined;
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  return undefined;
}

export function resolveConfigDir(overrideDir?: string): string {
  if (overrideDir) return overrideDir;
  const fromEnv = process.env.HANDY_CONFIG_DIR?.trim();
  if (fromEnv) return fromEnv;
  return join(homedir(), ".handy");
}

export function parseDurationMs(input: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|m|min|mins|h|hr|hrs)?$/i.exec(input.trim());
  if (!match) {
    throw new Error(`Invalid duration "${input}". Examples: 30s, 15m, 2h.`);
  }
  const value = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    sec: 1000,
    secs: 1000,
    m: 60_000,
    min: 60_000,
    mins: 60_000,
    h: 3_600_000,
    hr: 3_600_000,
    hrs: 3_600_000,
  };
  const ms = Math.round(value * (multipliers[unit] ?? 1000));
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`Duration must be positive: "${input}".`);
  }
  return ms;
}

export interface PermissionStoreOptions {
  configDir?: string;
  allowMcpEnable?: boolean;
}

export class PermissionStore {
  readonly configDir: string;
  readonly filePath: string;
  private readonly allowMcpEnableOption?: boolean;

  constructor(options: PermissionStoreOptions = {}) {
    this.configDir = resolveConfigDir(options.configDir);
    this.filePath = join(this.configDir, "permissions.json");
    this.allowMcpEnableOption = options.allowMcpEnable;
  }

  get allowMcpEnable(): boolean {
    if (this.allowMcpEnableOption !== undefined) return this.allowMcpEnableOption;
    return parseBoolEnv(process.env.HANDY_ALLOW_MCP_ENABLE) === true;
  }

  getState(): PermissionState {
    // Hard environment kill-switch (e.g. HANDY_ENABLED=false from MCPB toggle or host env)
    const envEnabled = parseBoolEnv(process.env.HANDY_ENABLED);
    if (envEnabled === false) {
      return {
        enabled: false,
        mode: "full",
        expiresAt: null,
        updatedAt: new Date().toISOString(),
        updatedBy: "env",
      };
    }

    const disk = this.readDiskState();
    if (disk) {
      if (disk.enabled && disk.expiresAt) {
        const exp = Date.parse(disk.expiresAt);
        if (!Number.isNaN(exp) && Date.now() >= exp) {
          const expiredState: PermissionState = {
            ...disk,
            enabled: false,
            expiresAt: null,
            updatedAt: new Date().toISOString(),
            updatedBy: "expired",
          };
          this.writeDiskState(expiredState);
          return expiredState;
        }
      }
      return disk;
    }

    const defaultEnabled = parseBoolEnv(process.env.HANDY_DEFAULT_ENABLED) ?? true;
    const defaultMode: PermissionMode =
      process.env.HANDY_DEFAULT_MODE?.trim().toLowerCase() === "view_only" ? "view_only" : "full";
    return {
      enabled: envEnabled ?? defaultEnabled,
      mode: defaultMode,
      expiresAt: null,
      updatedAt: new Date(0).toISOString(),
      updatedBy: envEnabled !== undefined ? "env" : "default",
    };
  }

  setEnabled(
    enabled: boolean,
    options: {
      mode?: PermissionMode;
      ttlMs?: number | null;
      updatedBy?: "cli" | "mcp" | "ui";
    } = {},
  ): PermissionState {
    const updatedBy = options.updatedBy ?? "cli";
    const current = this.getState();

    if (updatedBy === "mcp" && enabled && !this.allowMcpEnable) {
      if (!current.enabled) {
        throw new HandyPermissionError(
          "Handy is currently turned OFF by user permission controls and cannot re-enable itself via MCP. Ask the user to run `handy on` (or `/handy:on`).",
          current,
        );
      }
      const requestedMode = options.mode ?? current.mode ?? "full";
      if (current.mode === "view_only" && requestedMode === "full") {
        throw new HandyPermissionError(
          "Handy is in VIEW-ONLY mode and cannot escalate to full control via MCP. Ask the user to run `handy on` (without --view-only).",
          current,
        );
      }
    }

    if (enabled && parseBoolEnv(process.env.HANDY_ENABLED) === false && updatedBy === "mcp") {
      throw new HandyPermissionError(
        "Handy is disabled via HANDY_ENABLED=false in the host configuration.",
        current,
      );
    }

    const now = Date.now();
    const requestedExpiresMs = enabled && options.ttlMs && options.ttlMs > 0 ? now + options.ttlMs : null;
    let expiresAt: string | null = requestedExpiresMs !== null ? new Date(requestedExpiresMs).toISOString() : null;

    // Never allow unprivileged MCP calls to clear or extend an existing user-configured TTL
    if (enabled && updatedBy === "mcp" && !this.allowMcpEnable && current.expiresAt) {
      const existingExpMs = Date.parse(current.expiresAt);
      if (!Number.isNaN(existingExpMs)) {
        const clampedMs = requestedExpiresMs !== null ? Math.min(existingExpMs, requestedExpiresMs) : existingExpMs;
        expiresAt = new Date(clampedMs).toISOString();
      }
    }

    const next: PermissionState = {
      enabled,
      mode: options.mode ?? current.mode ?? "full",
      expiresAt,
      updatedAt: new Date(now).toISOString(),
      updatedBy,
    };
    this.writeDiskState(next);
    return next;
  }

  toggle(options: { mode?: PermissionMode; updatedBy?: "cli" } = {}): PermissionState {
    const current = this.getState();
    return this.setEnabled(!current.enabled, {
      mode: options.mode ?? current.mode,
      updatedBy: options.updatedBy ?? "cli",
    });
  }

  assertCanSee(): PermissionState {
    const state = this.getState();
    if (!state.enabled) {
      throw new HandyPermissionError(
        "Handy permission is OFF — screen capture and computer control are disabled. Run `handy on` (or `/handy:on`) to enable.",
        state,
      );
    }
    return state;
  }

  assertCanControl(): PermissionState {
    const state = this.assertCanSee();
    if (state.mode === "view_only") {
      throw new HandyPermissionError(
        "Handy is in VIEW-ONLY permission mode — screen viewing is allowed, but mouse and keyboard control are disabled. Run `handy on` (without --view-only) to allow input control.",
        state,
      );
    }
    return state;
  }

  watch(onChange: (state: PermissionState) => void): () => void {
    this.ensureDir();
    let closed = false;
    let watcher: FSWatcher | null = null;
    let lastMtime = this.getMtimeMs();

    const check = () => {
      if (closed) return;
      const mtime = this.getMtimeMs();
      if (mtime !== lastMtime) {
        lastMtime = mtime;
        onChange(this.getState());
      }
    };

    try {
      watcher = watch(this.configDir, (_event, filename) => {
        if (!filename || filename === "permissions.json") {
          check();
        }
      });
      watcher.unref?.();
    } catch {
      // Ignore if fs.watch is unsupported on a virtual filesystem
    }

    const interval = setInterval(check, 1000);
    interval.unref?.();

    return () => {
      closed = true;
      clearInterval(interval);
      watcher?.close();
    };
  }

  private getMtimeMs(): number {
    try {
      return statSync(this.filePath).mtimeMs;
    } catch {
      return -1;
    }
  }

  private ensureDir(): void {
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
    }
  }

  private readDiskState(): PermissionState | null {
    if (!existsSync(this.filePath)) return null;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<PermissionState>;
      if (typeof raw.enabled !== "boolean") return null;
      return {
        enabled: raw.enabled,
        mode: raw.mode === "view_only" ? "view_only" : "full",
        expiresAt: typeof raw.expiresAt === "string" ? raw.expiresAt : null,
        updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
        updatedBy:
          raw.updatedBy === "cli" ||
          raw.updatedBy === "mcp" ||
          raw.updatedBy === "env" ||
          raw.updatedBy === "expired"
            ? raw.updatedBy
            : "default",
      };
    } catch {
      return null;
    }
  }

  private writeDiskState(state: PermissionState): void {
    this.ensureDir();
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmpPath, this.filePath);
  }
}
