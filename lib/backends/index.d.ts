import type { DesktopBackend } from "../types.js";
import { DarwinBackend } from "./darwin.js";
import { LinuxCliBackend } from "./linux-cli.js";
import { LinuxX11Backend } from "./linux-x11.js";
import { VirtualDesktopBackend } from "./virtual.js";
import { Win32Backend } from "./win32.js";
export { DarwinBackend, LinuxCliBackend, LinuxX11Backend, VirtualDesktopBackend, Win32Backend };
export type BackendKind = "auto" | "virtual" | "linux-x11" | "linux-cli" | "darwin" | "win32";
export declare function createBackend(options?: {
    kind?: BackendKind | string;
    display?: string;
}): DesktopBackend;
