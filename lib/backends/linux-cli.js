import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseKeyChord, toXdotoolKey } from "../keys.js";
import { cropRgba, decodePng } from "../png.js";
const execFileAsync = promisify(execFile);
async function commandExists(cmd) {
    try {
        await execFileAsync("which", [cmd], { timeout: 2000 });
        return true;
    }
    catch {
        return false;
    }
}
function pipeStdin(cmd, args, input, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "pipe"] });
        let stderr = "";
        let settled = false;
        let stdinError = null;
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            child.kill("SIGKILL");
            reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        child.on("error", (err) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            reject(err);
        });
        // The helper can exit before draining stdin — no Wayland compositor, no DISPLAY, or it
        // rejected the payload — which surfaces as EPIPE on the stdin stream. A stream 'error' event
        // with no listener is thrown as an uncaught exception, so a clipboard write to a broken
        // helper used to take the entire MCP server process down with it. Capture it here and report
        // it through the promise instead; 'close' still produces the final rejection so the helper's
        // own stderr is preserved in the message.
        child.stdin.on("error", (err) => {
            stdinError = err;
        });
        child.on("close", (code) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            if (code === 0 && !stdinError) {
                resolve();
                return;
            }
            const detail = stderr.trim();
            if (detail) {
                reject(new Error(detail));
                return;
            }
            reject(new Error(stdinError
                ? `${cmd} exited with code ${code} without reading the piped input (${stdinError.message})`
                : `${cmd} exited with code ${code}`));
        });
        child.stdin.write(input, "utf8", (err) => {
            if (err)
                stdinError = err;
        });
        child.stdin.end();
    });
}
export async function readLinuxClipboard() {
    const isWayland = Boolean(process.env.WAYLAND_DISPLAY);
    if (isWayland && (await commandExists("wl-paste"))) {
        const { stdout } = await execFileAsync("wl-paste", ["--no-newline"], { timeout: 3000 });
        return stdout;
    }
    if (await commandExists("xclip")) {
        const { stdout } = await execFileAsync("xclip", ["-selection", "clipboard", "-o"], { timeout: 3000 });
        return stdout;
    }
    if (await commandExists("xsel")) {
        const { stdout } = await execFileAsync("xsel", ["--clipboard", "--output"], { timeout: 3000 });
        return stdout;
    }
    if (await commandExists("wl-paste")) {
        const { stdout } = await execFileAsync("wl-paste", ["--no-newline"], { timeout: 3000 });
        return stdout;
    }
    throw new Error("No Linux clipboard utility found (install xclip, xsel, or wl-clipboard).");
}
export async function writeLinuxClipboard(text) {
    const isWayland = Boolean(process.env.WAYLAND_DISPLAY);
    if (isWayland && (await commandExists("wl-copy"))) {
        await pipeStdin("wl-copy", [], text);
        return;
    }
    if (await commandExists("xclip")) {
        await pipeStdin("xclip", ["-selection", "clipboard", "-i"], text);
        return;
    }
    if (await commandExists("xsel")) {
        await pipeStdin("xsel", ["--clipboard", "--input"], text);
        return;
    }
    if (await commandExists("wl-copy")) {
        await pipeStdin("wl-copy", [], text);
        return;
    }
    throw new Error("No Linux clipboard utility found (install xclip, xsel, or wl-clipboard).");
}
export class LinuxCliBackend {
    name = "linux-cli";
    platform = "linux";
    screenshotTool = null;
    inputTool = null;
    wtypeAvailable = false;
    wmctrlAvailable = false;
    lastKnownMouse = { x: 0, y: 0 };
    cachedScreenSize = null;
    initialized = false;
    initPromise = null;
    async init() {
        return this.ensureReady();
    }
    async ensureReady() {
        if (this.initialized)
            return;
        if (this.initPromise)
            return this.initPromise;
        const p = this.doInit().finally(() => {
            if (this.initPromise === p) {
                this.initPromise = null;
            }
        });
        this.initPromise = p;
        return p;
    }
    async doInit() {
        const isWayland = Boolean(process.env.WAYLAND_DISPLAY);
        const screenshotCandidates = isWayland
            ? ["grim", "gnome-screenshot", "maim", "scrot", "import"]
            : ["maim", "scrot", "import", "gnome-screenshot", "grim"];
        this.screenshotTool = null;
        for (const candidate of screenshotCandidates) {
            if (await commandExists(candidate)) {
                this.screenshotTool = candidate;
                break;
            }
        }
        this.inputTool = null;
        const inputCandidates = isWayland ? ["ydotool", "xdotool"] : ["xdotool", "ydotool"];
        for (const candidate of inputCandidates) {
            if (await commandExists(candidate)) {
                this.inputTool = candidate;
                break;
            }
        }
        this.wtypeAvailable = await commandExists("wtype");
        this.wmctrlAvailable = await commandExists("wmctrl");
        this.initialized = true;
    }
    async close() { }
    async getDisplays() {
        await this.ensureReady();
        if (!this.cachedScreenSize) {
            try {
                const frame = await this.captureScreen();
                this.cachedScreenSize = { width: frame.width, height: frame.height };
            }
            catch {
                this.cachedScreenSize = { width: 1920, height: 1080 };
            }
        }
        return [
            {
                id: 0,
                name: process.env.WAYLAND_DISPLAY ? `Wayland (${process.env.WAYLAND_DISPLAY})` : "Linux Display",
                x: 0,
                y: 0,
                width: this.cachedScreenSize.width,
                height: this.cachedScreenSize.height,
                scaleFactor: 1,
                primary: true,
            },
        ];
    }
    async listWindows() {
        await this.ensureReady();
        if (this.wmctrlAvailable) {
            try {
                const { stdout } = await execFileAsync("wmctrl", ["-lG"], { timeout: 3000 });
                let activeHex = "";
                if (this.inputTool === "xdotool") {
                    try {
                        const { stdout: actOut } = await execFileAsync("xdotool", ["getactivewindow"], { timeout: 2000 });
                        const idNum = Number(actOut.trim());
                        if (Number.isFinite(idNum))
                            activeHex = idNum.toString(16);
                    }
                    catch {
                        // ignore
                    }
                }
                const results = [];
                for (const line of stdout.split("\n")) {
                    const m = /^(0x[0-9a-fA-F]+)\s+\S+\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+\S+\s+(.*)$/.exec(line.trim());
                    if (!m)
                        continue;
                    const idHex = m[1];
                    const focused = activeHex ? Number.parseInt(idHex, 16) === Number.parseInt(activeHex, 16) : false;
                    results.push({
                        id: idHex,
                        title: m[6].trim(),
                        bounds: {
                            x: Number(m[2]),
                            y: Number(m[3]),
                            width: Math.max(1, Number(m[4])),
                            height: Math.max(1, Number(m[5])),
                        },
                        focused,
                    });
                }
                return results;
            }
            catch {
                // fall through
            }
        }
        const active = await this.getActiveWindow();
        return active ? [active] : [];
    }
    async getActiveWindow() {
        await this.ensureReady();
        if (this.inputTool === "xdotool") {
            try {
                const { stdout: idOut } = await execFileAsync("xdotool", ["getactivewindow"], { timeout: 2000 });
                const winId = idOut.trim();
                if (!winId)
                    return null;
                const { stdout: nameOut } = await execFileAsync("xdotool", ["getwindowname", winId], { timeout: 2000 });
                const { stdout: geomOut } = await execFileAsync("xdotool", ["getwindowgeometry", "--shell", winId], {
                    timeout: 2000,
                });
                const xm = /^X=(-?\d+)/m.exec(geomOut);
                const ym = /^Y=(-?\d+)/m.exec(geomOut);
                const wm = /^WIDTH=(\d+)/m.exec(geomOut);
                const hm = /^HEIGHT=(\d+)/m.exec(geomOut);
                return {
                    id: Number(winId) || winId,
                    title: nameOut.trim(),
                    bounds: xm && ym && wm && hm
                        ? {
                            x: Number(xm[1]),
                            y: Number(ym[1]),
                            width: Math.max(1, Number(wm[1])),
                            height: Math.max(1, Number(hm[1])),
                        }
                        : undefined,
                    focused: true,
                };
            }
            catch {
                return null;
            }
        }
        return null;
    }
    async focusWindow(query) {
        await this.ensureReady();
        if (query.id !== undefined) {
            if (this.inputTool === "xdotool") {
                try {
                    await execFileAsync("xdotool", ["windowactivate", "--sync", String(query.id)], { timeout: 3000 });
                    return true;
                }
                catch {
                    // try wmctrl -i -a
                }
            }
            if (this.wmctrlAvailable) {
                try {
                    await execFileAsync("wmctrl", ["-i", "-a", String(query.id)], { timeout: 3000 });
                    return true;
                }
                catch {
                    return false;
                }
            }
            return false;
        }
        const needle = query.title ?? query.app;
        if (!needle)
            return false;
        if (this.wmctrlAvailable) {
            try {
                await execFileAsync("wmctrl", ["-a", needle], { timeout: 3000 });
                return true;
            }
            catch {
                // continue
            }
        }
        if (this.inputTool === "xdotool") {
            try {
                await execFileAsync("xdotool", ["search", "--name", needle, "windowactivate"], { timeout: 3000 });
                return true;
            }
            catch {
                return false;
            }
        }
        return false;
    }
    async getClipboardText() {
        return readLinuxClipboard();
    }
    async setClipboardText(text) {
        await writeLinuxClipboard(text);
    }
    async getMousePosition() {
        await this.ensureReady();
        if (this.inputTool === "xdotool") {
            const { stdout } = await execFileAsync("xdotool", ["getmouselocation", "--shell"], { timeout: 3000 });
            const xm = /^X=(-?\d+)/m.exec(stdout);
            const ym = /^Y=(-?\d+)/m.exec(stdout);
            if (xm && ym) {
                this.lastKnownMouse = { x: Number(xm[1]), y: Number(ym[1]) };
            }
        }
        return { ...this.lastKnownMouse };
    }
    async moveMouse(x, y) {
        await this.ensureReady();
        const rx = Math.round(x);
        const ry = Math.round(y);
        if (this.inputTool === "xdotool") {
            await execFileAsync("xdotool", ["mousemove", "--", String(rx), String(ry)], { timeout: 3000 });
        }
        else if (this.inputTool === "ydotool") {
            await execFileAsync("ydotool", ["mousemove", "--absolute", "-x", String(rx), "-y", String(ry)], {
                timeout: 3000,
            });
        }
        else {
            throw new Error("No Linux input tool found (install xdotool for X11 or ydotool for Wayland).");
        }
        this.lastKnownMouse = { x: rx, y: ry };
    }
    buttonNum(button) {
        if (this.inputTool === "ydotool") {
            return button === "left" ? "0x00" : button === "right" ? "0x01" : "0x02";
        }
        return button === "left" ? "1" : button === "middle" ? "2" : "3";
    }
    async mouseDown(button) {
        await this.ensureReady();
        if (this.inputTool === "xdotool") {
            await execFileAsync("xdotool", ["mousedown", this.buttonNum(button)], { timeout: 3000 });
        }
        else if (this.inputTool === "ydotool") {
            const code = button === "left" ? "0x40" : button === "right" ? "0x41" : "0x42";
            await execFileAsync("ydotool", ["click", code], { timeout: 3000 });
        }
        else {
            throw new Error("No Linux input tool found.");
        }
    }
    async mouseUp(button) {
        await this.ensureReady();
        if (this.inputTool === "xdotool") {
            await execFileAsync("xdotool", ["mouseup", this.buttonNum(button)], { timeout: 3000 });
        }
        else if (this.inputTool === "ydotool") {
            const code = button === "left" ? "0x80" : button === "right" ? "0x81" : "0x82";
            await execFileAsync("ydotool", ["click", code], { timeout: 3000 });
        }
        else {
            throw new Error("No Linux input tool found.");
        }
    }
    async scroll(deltaX, deltaY) {
        await this.ensureReady();
        if (this.inputTool === "xdotool") {
            const vSteps = Math.round(Math.abs(deltaY));
            if (vSteps > 0) {
                await execFileAsync("xdotool", ["click", "--repeat", String(vSteps), deltaY < 0 ? "4" : "5"], {
                    timeout: 3000,
                });
            }
            const hSteps = Math.round(Math.abs(deltaX));
            if (hSteps > 0) {
                await execFileAsync("xdotool", ["click", "--repeat", String(hSteps), deltaX < 0 ? "6" : "7"], {
                    timeout: 3000,
                });
            }
        }
        else if (this.inputTool === "ydotool") {
            await execFileAsync("ydotool", ["mousemove", "--wheel", "-x", String(Math.round(deltaX)), "-y", String(Math.round(-deltaY))], { timeout: 3000 });
        }
        else {
            throw new Error("No Linux input tool found.");
        }
    }
    async keyDown(key) {
        await this.ensureReady();
        const parsed = parseKeyChord(key, [], "linux");
        if (this.inputTool === "xdotool") {
            await execFileAsync("xdotool", ["keydown", toXdotoolKey(parsed.key)], { timeout: 3000 });
            return;
        }
        throw new Error("keyDown requires xdotool or native X11 backend.");
    }
    async keyUp(key) {
        await this.ensureReady();
        const parsed = parseKeyChord(key, [], "linux");
        if (this.inputTool === "xdotool") {
            await execFileAsync("xdotool", ["keyup", toXdotoolKey(parsed.key)], { timeout: 3000 });
            return;
        }
        throw new Error("keyUp requires xdotool or native X11 backend.");
    }
    async keyTap(key, modifiers = []) {
        await this.ensureReady();
        const xdoKey = [...modifiers.map((m) => toXdotoolKey(m)), toXdotoolKey(key)].join("+");
        if (this.inputTool === "xdotool") {
            await execFileAsync("xdotool", ["key", "--clearmodifiers", xdoKey], { timeout: 3000 });
            return;
        }
        if (this.wtypeAvailable) {
            const args = [];
            for (const m of modifiers) {
                args.push("-M", m === "meta" ? "logo" : m);
            }
            args.push("-k", toXdotoolKey(key));
            for (const m of [...modifiers].reverse()) {
                args.push("-m", m === "meta" ? "logo" : m);
            }
            await execFileAsync("wtype", args, { timeout: 3000 });
            return;
        }
        throw new Error("No Linux keyboard tool found (install xdotool or wtype).");
    }
    async typeText(text) {
        await this.ensureReady();
        if (this.inputTool === "xdotool") {
            await execFileAsync("xdotool", ["type", "--clearmodifiers", "--delay", "8", "--", text], { timeout: 10000 });
            return;
        }
        if (this.wtypeAvailable) {
            await execFileAsync("wtype", ["--", text], { timeout: 10000 });
            return;
        }
        if (this.inputTool === "ydotool") {
            await execFileAsync("ydotool", ["type", "--", text], { timeout: 10000 });
            return;
        }
        throw new Error("No Linux typing tool found (install xdotool, wtype, or ydotool).");
    }
    async captureScreen(options = {}) {
        await this.ensureReady();
        if (!this.screenshotTool) {
            throw new Error("No Linux screenshot utility found (grim, maim, scrot, import, or gnome-screenshot).");
        }
        let pngBytes = null;
        let alreadyCropped = false;
        // Fast path: capture PNG directly to stdout in memory (zero temp file I/O)
        if (this.screenshotTool === "grim") {
            const args = options.region
                ? ["-g", `${options.region.x},${options.region.y} ${options.region.width}x${options.region.height}`, "-t", "png", "-"]
                : ["-t", "png", "-"];
            const { stdout } = await execFileAsync("grim", args, {
                encoding: "buffer",
                maxBuffer: 64 * 1024 * 1024,
                timeout: 5000,
            });
            pngBytes = stdout;
            alreadyCropped = Boolean(options.region);
        }
        else if (this.screenshotTool === "maim") {
            const args = options.region
                ? ["-g", `${options.region.width}x${options.region.height}+${options.region.x}+${options.region.y}`, "--format=png"]
                : ["--format=png"];
            const { stdout } = await execFileAsync("maim", args, {
                encoding: "buffer",
                maxBuffer: 64 * 1024 * 1024,
                timeout: 5000,
            });
            pngBytes = stdout;
            alreadyCropped = Boolean(options.region);
        }
        else if (this.screenshotTool === "import") {
            const { stdout } = await execFileAsync("import", ["-window", "root", "png:-"], {
                encoding: "buffer",
                maxBuffer: 64 * 1024 * 1024,
                timeout: 5000,
            });
            pngBytes = stdout;
        }
        if (!pngBytes) {
            const dir = mkdtempSync(join(tmpdir(), "handy-shot-"));
            const outPath = join(dir, "screen.png");
            try {
                if (this.screenshotTool === "scrot") {
                    await execFileAsync("scrot", ["--overwrite", outPath], { timeout: 5000 });
                }
                else {
                    await execFileAsync("gnome-screenshot", ["-f", outPath], { timeout: 5000 });
                }
                pngBytes = readFileSync(outPath);
            }
            finally {
                rmSync(dir, { recursive: true, force: true });
            }
        }
        const decoded = decodePng(pngBytes);
        if (!alreadyCropped) {
            this.cachedScreenSize = { width: decoded.width, height: decoded.height };
        }
        if (options.region && !alreadyCropped) {
            const cropped = cropRgba(decoded.data, decoded.width, decoded.height, options.region.x, options.region.y, options.region.width, options.region.height);
            return {
                width: cropped.width,
                height: cropped.height,
                data: cropped.data,
                originX: cropped.x,
                originY: cropped.y,
                logicalWidth: cropped.width,
                logicalHeight: cropped.height,
                scaleFactor: 1,
                displayId: 0,
            };
        }
        return {
            width: decoded.width,
            height: decoded.height,
            data: decoded.data,
            originX: options.region?.x ?? 0,
            originY: options.region?.y ?? 0,
            logicalWidth: decoded.width,
            logicalHeight: decoded.height,
            scaleFactor: 1,
            displayId: 0,
        };
    }
    async doctor() {
        this.initialized = false;
        await this.ensureReady();
        return [
            {
                name: "Linux Screenshot Tool",
                ok: this.screenshotTool !== null,
                detail: this.screenshotTool ? `Using ${this.screenshotTool}` : "Missing (install grim, maim, or scrot)",
            },
            {
                name: "Linux Input Tool",
                ok: this.inputTool !== null || this.wtypeAvailable,
                detail: this.inputTool || this.wtypeAvailable
                    ? `Using ${[this.inputTool, this.wtypeAvailable ? "wtype" : null].filter(Boolean).join(", ")}`
                    : "Missing (install xdotool or ydotool/wtype)",
            },
        ];
    }
}
