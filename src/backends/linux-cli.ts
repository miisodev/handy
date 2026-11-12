import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseKeyChord, toXdotoolKey, type ConcreteModifier } from "../keys.js";
import { cropRgba, decodePng } from "../png.js";
import type { DesktopBackend, DisplayInfo, DoctorCheck, MouseButton, Point, RawFrame, Region } from "../types.js";

const execFileAsync = promisify(execFile);

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFileAsync("which", [cmd], { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

export class LinuxCliBackend implements DesktopBackend {
  readonly name = "linux-cli";
  readonly platform = "linux" as const;

  private screenshotTool: "grim" | "scrot" | "import" | "gnome-screenshot" | null = null;
  private inputTool: "xdotool" | "ydotool" | null = null;
  private wtypeAvailable = false;
  private lastKnownMouse: Point = { x: 0, y: 0 };
  private cachedScreenSize: { width: number; height: number } | null = null;

  async init(): Promise<void> {
    const isWayland = Boolean(process.env.WAYLAND_DISPLAY);
    const screenshotCandidates: Array<"grim" | "scrot" | "import" | "gnome-screenshot"> = isWayland
      ? ["grim", "gnome-screenshot", "scrot", "import"]
      : ["scrot", "import", "gnome-screenshot", "grim"];

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
      // ydotool mouse codes: 0x00 left, 0x01 right, 0x02 middle
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
      await execFileAsync("ydotool", ["mousemove", "--wheel", "-x", String(Math.round(deltaX)), "-y", String(Math.round(-deltaY))], {
        timeout: 3000,
      });
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
      throw new Error("No Linux screenshot utility found (grim, scrot, import, or gnome-screenshot).");
    }

    const dir = mkdtempSync(join(tmpdir(), "handy-shot-"));
    const outPath = join(dir, "screen.png");

    try {
      if (this.screenshotTool === "grim") {
        const args = options.region
          ? ["-g", `${options.region.x},${options.region.y} ${options.region.width}x${options.region.height}`, outPath]
          : [outPath];
        await execFileAsync("grim", args, { timeout: 5000 });
      } else if (this.screenshotTool === "scrot") {
        await execFileAsync("scrot", ["--overwrite", outPath], { timeout: 5000 });
      } else if (this.screenshotTool === "import") {
        await execFileAsync("import", ["-window", "root", outPath], { timeout: 5000 });
      } else {
        await execFileAsync("gnome-screenshot", ["-f", outPath], { timeout: 5000 });
      }

      const decoded = decodePng(readFileSync(outPath));
      this.cachedScreenSize = { width: decoded.width, height: decoded.height };

      if (options.region && this.screenshotTool !== "grim") {
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
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async doctor(): Promise<DoctorCheck[]> {
    await this.init();
    return [
      {
        name: "Linux Screenshot Tool",
        ok: this.screenshotTool !== null,
        detail: this.screenshotTool ? `Using ${this.screenshotTool}` : "Missing (install grim or scrot)",
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
