import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseKeyChord, toXdotoolKey, type ConcreteModifier } from "../keys.js";
import { cropRgba, decodePng } from "../png.js";
import type {
  DesktopBackend,
  DisplayInfo,
  DoctorCheck,
  MouseButton,
  Point,
  RawFrame,
  Region,
  WindowInfo,
} from "../types.js";

const execFileAsync = promisify(execFile);

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFileAsync("which", [cmd], { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

function pipeStdin(cmd: string, args: string[], input: string, timeoutMs = 4000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${cmd} exited with code ${code}`));
    });

    child.stdin.write(input, "utf8");
    child.stdin.end();
  });
}

export async function readLinuxClipboard(): Promise<string> {
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

export async function writeLinuxClipboard(text: string): Promise<void> {
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

export class LinuxCliBackend implements DesktopBackend {
  readonly name = "linux-cli";
  readonly platform = "linux" as const;

  private screenshotTool: "grim" | "maim" | "scrot" | "import" | "gnome-screenshot" | null = null;
  private inputTool: "xdotool" | "ydotool" | null = null;
  private wtypeAvailable = false;
  private wmctrlAvailable = false;
  private lastKnownMouse: Point = { x: 0, y: 0 };
  private cachedScreenSize: { width: number; height: number } | null = null;

  async init(): Promise<void> {
    const isWayland = Boolean(process.env.WAYLAND_DISPLAY);
    const screenshotCandidates: Array<"grim" | "maim" | "scrot" | "import" | "gnome-screenshot"> = isWayland
      ? ["grim", "gnome-screenshot", "maim", "scrot", "import"]
      : ["maim", "scrot", "import", "gnome-screenshot", "grim"];

    for (const candidate of screenshotCandidates) {
      if (await commandExists(candidate)) {
        this.screenshotTool = candidate;
        break;
      }
    }

    const inputCandidates: Array<"xdotool" | "ydotool"> = isWayland ? ["ydotool", "xdotool"] : ["xdotool", "ydotool"];
    for (const candidate of inputCandidates) {
      if (await commandExists(candidate)) {
        this.inputTool = candidate;
        break;
      }
    }
    this.wtypeAvailable = await commandExists("wtype");
    this.wmctrlAvailable = await commandExists("wmctrl");
  }

  async close(): Promise<void> {}

  async getDisplays(): Promise<DisplayInfo[]> {
    if (!this.cachedScreenSize) {
      try {
        const frame = await this.captureScreen();
        this.cachedScreenSize = { width: frame.width, height: frame.height };
      } catch {
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

  async listWindows(): Promise<WindowInfo[]> {
    if (this.wmctrlAvailable) {
      try {
        const { stdout } = await execFileAsync("wmctrl", ["-lG"], { timeout: 3000 });
        let activeHex = "";
        if (this.inputTool === "xdotool") {
          try {
            const { stdout: actOut } = await execFileAsync("xdotool", ["getactivewindow"], { timeout: 2000 });
            const idNum = Number(actOut.trim());
            if (Number.isFinite(idNum)) activeHex = idNum.toString(16);
          } catch {
            // ignore
          }
        }
        const results: WindowInfo[] = [];
        for (const line of stdout.split("\n")) {
          const m = /^(0x[0-9a-fA-F]+)\s+\S+\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+\S+\s+(.*)$/.exec(line.trim());
          if (!m) continue;
          const idHex = m[1]!;
          const focused = activeHex ? Number.parseInt(idHex, 16) === Number.parseInt(activeHex, 16) : false;
          results.push({
            id: idHex,
            title: m[6]!.trim(),
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
      } catch {
        // fall through
      }
    }
    const active = await this.getActiveWindow();
    return active ? [active] : [];
  }

  async getActiveWindow(): Promise<WindowInfo | null> {
    if (this.inputTool === "xdotool") {
      try {
        const { stdout: idOut } = await execFileAsync("xdotool", ["getactivewindow"], { timeout: 2000 });
        const winId = idOut.trim();
        if (!winId) return null;
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
          bounds:
            xm && ym && wm && hm
              ? {
                  x: Number(xm[1]),
                  y: Number(ym[1]),
                  width: Math.max(1, Number(wm[1])),
                  height: Math.max(1, Number(hm[1])),
                }
              : undefined,
          focused: true,
        };
      } catch {
        return null;
      }
    }
    return null;
  }

  async focusWindow(query: { title?: string; app?: string; id?: string | number }): Promise<boolean> {
    if (query.id !== undefined && this.inputTool === "xdotool") {
      try {
        await execFileAsync("xdotool", ["windowactivate", "--sync", String(query.id)], { timeout: 3000 });
        return true;
      } catch {
        // continue
      }
    }
    const needle = query.title ?? query.app;
    if (!needle) return false;
    if (this.wmctrlAvailable) {
      try {
        await execFileAsync("wmctrl", ["-a", needle], { timeout: 3000 });
        return true;
      } catch {
        // continue
      }
    }
    if (this.inputTool === "xdotool") {
      try {
        await execFileAsync("xdotool", ["search", "--name", needle, "windowactivate"], { timeout: 3000 });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  async getClipboardText(): Promise<string> {
    return readLinuxClipboard();
  }

  async setClipboardText(text: string): Promise<void> {
    await writeLinuxClipboard(text);
  }

  async getMousePosition(): Promise<Point> {
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

  async moveMouse(x: number, y: number): Promise<void> {
    const rx = Math.round(x);
    const ry = Math.round(y);
    if (this.inputTool === "xdotool") {
      await execFileAsync("xdotool", ["mousemove", "--", String(rx), String(ry)], { timeout: 3000 });
    } else if (this.inputTool === "ydotool") {
      await execFileAsync("ydotool", ["mousemove", "--absolute", "-x", String(rx), "-y", String(ry)], {
        timeout: 3000,
      });
    } else {
      throw new Error("No Linux input tool found (install xdotool for X11 or ydotool for Wayland).");
    }
    this.lastKnownMouse = { x: rx, y: ry };
  }

  private buttonNum(button: MouseButton): string {
    if (this.inputTool === "ydotool") {
      return button === "left" ? "0x00" : button === "right" ? "0x01" : "0x02";
    }
    return button === "left" ? "1" : button === "middle" ? "2" : "3";
  }

  async mouseDown(button: MouseButton): Promise<void> {
    if (this.inputTool === "xdotool") {
      await execFileAsync("xdotool", ["mousedown", this.buttonNum(button)], { timeout: 3000 });
    } else if (this.inputTool === "ydotool") {
      const code = button === "left" ? "0x40" : button === "right" ? "0x41" : "0x42";
      await execFileAsync("ydotool", ["click", code], { timeout: 3000 });
    } else {
      throw new Error("No Linux input tool found.");
    }
  }

  async mouseUp(button: MouseButton): Promise<void> {
    if (this.inputTool === "xdotool") {
      await execFileAsync("xdotool", ["mouseup", this.buttonNum(button)], { timeout: 3000 });
    } else if (this.inputTool === "ydotool") {
      const code = button === "left" ? "0x80" : button === "right" ? "0x81" : "0x82";
      await execFileAsync("ydotool", ["click", code], { timeout: 3000 });
    } else {
      throw new Error("No Linux input tool found.");
    }
  }

  async scroll(deltaX: number, deltaY: number): Promise<void> {
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
    } else if (this.inputTool === "ydotool") {
      await execFileAsync(
        "ydotool",
        ["mousemove", "--wheel", "-x", String(Math.round(deltaX)), "-y", String(Math.round(-deltaY))],
        { timeout: 3000 },
      );
    } else {
      throw new Error("No Linux input tool found.");
    }
  }

  async keyDown(key: string): Promise<void> {
    const parsed = parseKeyChord(key, [], "linux");
    if (this.inputTool === "xdotool") {
      await execFileAsync("xdotool", ["keydown", toXdotoolKey(parsed.key)], { timeout: 3000 });
      return;
    }
    throw new Error("keyDown requires xdotool or native X11 backend.");
  }

  async keyUp(key: string): Promise<void> {
    const parsed = parseKeyChord(key, [], "linux");
    if (this.inputTool === "xdotool") {
      await execFileAsync("xdotool", ["keyup", toXdotoolKey(parsed.key)], { timeout: 3000 });
      return;
    }
    throw new Error("keyUp requires xdotool or native X11 backend.");
  }

  async keyTap(key: string, modifiers: ConcreteModifier[] = []): Promise<void> {
    const xdoKey = [...modifiers.map((m) => toXdotoolKey(m)), toXdotoolKey(key)].join("+");
    if (this.inputTool === "xdotool") {
      await execFileAsync("xdotool", ["key", "--clearmodifiers", xdoKey], { timeout: 3000 });
      return;
    }
    if (this.wtypeAvailable) {
      const args: string[] = [];
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

  async typeText(text: string): Promise<void> {
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

  async captureScreen(options: { display?: number; region?: Region } = {}): Promise<RawFrame> {
    if (!this.screenshotTool) {
      throw new Error("No Linux screenshot utility found (grim, maim, scrot, import, or gnome-screenshot).");
    }

    let pngBytes: Buffer | null = null;
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
    } else if (this.screenshotTool === "maim") {
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
    } else if (this.screenshotTool === "import") {
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
        } else {
          await execFileAsync("gnome-screenshot", ["-f", outPath], { timeout: 5000 });
        }
        pngBytes = readFileSync(outPath);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    const decoded = decodePng(pngBytes);
    if (!alreadyCropped) {
      this.cachedScreenSize = { width: decoded.width, height: decoded.height };
    }

    if (options.region && !alreadyCropped) {
      const cropped = cropRgba(
        decoded.data,
        decoded.width,
        decoded.height,
        options.region.x,
        options.region.y,
        options.region.width,
        options.region.height,
      );
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

  async doctor(): Promise<DoctorCheck[]> {
    await this.init();
    return [
      {
        name: "Linux Screenshot Tool",
        ok: this.screenshotTool !== null,
        detail: this.screenshotTool ? `Using ${this.screenshotTool}` : "Missing (install grim, maim, or scrot)",
      },
      {
        name: "Linux Input Tool",
        ok: this.inputTool !== null || this.wtypeAvailable,
        detail:
          this.inputTool || this.wtypeAvailable
            ? `Using ${[this.inputTool, this.wtypeAvailable ? "wtype" : null].filter(Boolean).join(", ")}`
            : "Missing (install xdotool or ydotool/wtype)",
      },
    ];
  }
}
