import { DarwinBackend } from "./darwin.js";
import { LinuxCliBackend } from "./linux-cli.js";
import { LinuxX11Backend } from "./linux-x11.js";
import { VirtualDesktopBackend } from "./virtual.js";
import { Win32Backend } from "./win32.js";
export { DarwinBackend, LinuxCliBackend, LinuxX11Backend, VirtualDesktopBackend, Win32Backend };
export function createBackend(options = {}) {
    const rawKind = (options.kind ?? process.env.HANDY_BACKEND ?? "auto").trim().toLowerCase();
    if (rawKind === "virtual") {
        return new VirtualDesktopBackend();
    }
    if (rawKind === "x11" || rawKind === "linux-x11") {
        return new LinuxX11Backend({ display: options.display });
    }
    if (rawKind === "linux-cli" || rawKind === "wayland") {
        return new LinuxCliBackend();
    }
    if (rawKind === "darwin" || rawKind === "macos") {
        return new DarwinBackend();
    }
    if (rawKind === "win32" || rawKind === "windows") {
        return new Win32Backend();
    }
    if (process.platform === "win32") {
        return new Win32Backend();
    }
    if (process.platform === "darwin") {
        return new DarwinBackend();
    }
    if (process.platform === "linux") {
        const display = options.display ?? process.env.DISPLAY;
        if (!display && process.env.WAYLAND_DISPLAY) {
            return new LinuxCliBackend();
        }
        return new LinuxX11Backend({ display });
    }
    throw new Error(`Unsupported OS platform "${process.platform}". Set HANDY_BACKEND=virtual for headless testing.`);
}
