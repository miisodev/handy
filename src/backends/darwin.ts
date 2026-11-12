import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DARWIN_KEYCODES, parseKeyChord, type ConcreteModifier } from "../keys.js";
import { decodePng } from "../png.js";
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
import { JsonlWorker, type JsonlWorkerOptions } from "./jsonl-worker.js";

const execFileAsync = promisify(execFile);

/**
 * Persistent macOS JXA (JavaScript for Automation) CoreGraphics + AppKit worker.
 * Runs on every Mac out of the box via /usr/bin/osascript without requiring Xcode CLT.
 */
export const DARWIN_JXA_SCRIPT = `
ObjC.import("Foundation");
ObjC.import("CoreGraphics");
ObjC.import("AppKit");
ObjC.import("ApplicationServices");

const stdin = $.NSFileHandle.fileHandleWithStandardInput;
const stdout = $.NSFileHandle.fileHandleWithStandardOutput;

function writeJson(obj) {
  const str = JSON.stringify(obj) + "\\n";
  const ns = $(str);
  const data = ns.dataUsingEncoding($.NSUTF8StringEncoding);
  stdout.writeData(data);
}

function getMousePos() {
  const ev = $.CGEventCreate($());
  const loc = $.CGEventGetLocation(ev);
  return { x: Math.round(loc.x), y: Math.round(loc.y) };
}

function flagsForMods(mods) {
  let flags = 0;
  if (!mods) return 0;
  for (let i = 0; i < mods.length; i++) {
    const m = mods[i];
    if (m === "meta") flags |= (1 << 20);
    else if (m === "shift") flags |= (1 << 17);
    else if (m === "alt") flags |= (1 << 19);
    else if (m === "ctrl") flags |= (1 << 18);
  }
  return flags;
}

function collectWindows() {
  const ws = $.NSWorkspace.sharedWorkspace;
  const frontApp = ws.frontmostApplication;
  const frontPid = frontApp ? Number(frontApp.processIdentifier) : -1;
  const opts = $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements;
  const raw = ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(opts, 0)) || [];
  const list = [];
  let markedFocused = false;
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i];
    if (!w || Number(w.kCGWindowLayer) !== 0) continue;
    const owner = String(w.kCGWindowOwnerName || "");
    const name = String(w.kCGWindowName || "");
    if (!owner && !name) continue;
    const pid = Number(w.kCGWindowOwnerPID || 0);
    const b = w.kCGWindowBounds;
    const bounds = b && Number(b.Width) > 0 && Number(b.Height) > 0
      ? {
          x: Math.round(Number(b.X) || 0),
          y: Math.round(Number(b.Y) || 0),
          width: Math.round(Number(b.Width)),
          height: Math.round(Number(b.Height))
        }
      : undefined;
    const isFront = !markedFocused && pid === frontPid;
    if (isFront) markedFocused = true;
    list.push({
      id: Number(w.kCGWindowNumber || i),
      title: name || owner,
      app: owner || undefined,
      pid: pid || undefined,
      bounds: bounds,
      focused: isFront
    });
  }
  return list;
}

let heldLeft = false;
let lastClickCount = 1;

function handleCmd(cmd) {
  const op = cmd.op;
  if (op === "doctor") {
    let ax = true;
    let screen = true;
    try { ax = Boolean($.AXIsProcessTrusted()); } catch (_) {}
    try { screen = Boolean($.CGPreflightScreenCaptureAccess()); } catch (_) {}
    return { id: cmd.id, ok: true, accessibility: ax, screenRecording: screen };
  }
  if (op === "displays") {
    const screens = $.NSScreen.screens;
    const count = screens.count;
    const primaryH = count > 0 ? screens.objectAtIndex(0).frame.size.height : 0;
    const list = [];
    for (let i = 0; i < count; i++) {
      const s = screens.objectAtIndex(i);
      const f = s.frame;
      const scale = Number(s.backingScaleFactor) || 1;
      const cgY = primaryH - (f.origin.y + f.size.height);
      list.push({
        id: i,
        name: "macOS Display " + (i + 1),
        x: Math.round(f.origin.x),
        y: Math.round(cgY),
        width: Math.round(f.size.width),
        height: Math.round(f.size.height),
        scaleFactor: scale,
        primary: i === 0
      });
    }
    return { id: cmd.id, ok: true, displays: list };
  }
  if (op === "capture") {
    try {
      const rect = {
        origin: { x: Number(cmd.x) || 0, y: Number(cmd.y) || 0 },
        size: { width: Math.max(1, Number(cmd.width) || 1), height: Math.max(1, Number(cmd.height) || 1) }
      };
      const cgImg = $.CGWindowListCreateImage(rect, $.kCGWindowListOptionOnScreenOnly, 0, $.kCGWindowImageDefault);
      if (!cgImg) return { id: cmd.id, ok: false, error: "CGWindowListCreateImage returned null" };
      const rep = $.NSBitmapImageRep.alloc.initWithCGImage(cgImg);
      const pngData = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
      if (!pngData) return { id: cmd.id, ok: false, error: "PNG encoding failed" };
      const b64 = ObjC.unwrap(pngData.base64EncodedStringWithOptions(0));
      return { id: cmd.id, ok: true, pngBase64: b64 };
    } catch (e) {
      return { id: cmd.id, ok: false, error: String(e) };
    }
  }
  if (op === "windows") {
    return { id: cmd.id, ok: true, windows: collectWindows() };
  }
  if (op === "focus_window") {
    const wins = collectWindows();
    const tNeedle = cmd.title ? String(cmd.title).toLowerCase() : "";
    const aNeedle = cmd.app ? String(cmd.app).toLowerCase() : "";
    const targetId = cmd.windowId !== undefined ? String(cmd.windowId) : "";
    let pid = 0;
    for (let i = 0; i < wins.length; i++) {
      const w = wins[i];
      if (targetId && String(w.id) === targetId) { pid = w.pid || 0; break; }
      if (tNeedle && String(w.title || "").toLowerCase().indexOf(tNeedle) !== -1) { pid = w.pid || 0; break; }
      if (aNeedle && String(w.app || "").toLowerCase().indexOf(aNeedle) !== -1) { pid = w.pid || 0; break; }
    }
    if (pid > 0) {
      const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
      if (app) {
        const ok = Boolean(app.activateWithOptions(1 << 1));
        return { id: cmd.id, ok: true, focused: ok };
      }
    }
    if (aNeedle || tNeedle) {
      const needle = aNeedle || tNeedle;
      const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
      for (let j = 0; j < apps.count; j++) {
        const a = apps.objectAtIndex(j);
        const lname = a.localizedName ? ObjC.unwrap(a.localizedName).toLowerCase() : "";
        if (lname && lname.indexOf(needle) !== -1) {
          const ok = Boolean(a.activateWithOptions(1 << 1));
          return { id: cmd.id, ok: true, focused: ok };
        }
      }
    }
    return { id: cmd.id, ok: true, focused: false };
  }
  if (op === "clipboard_get") {
    const pb = $.NSPasteboard.generalPasteboard;
    const s = pb.stringForType($.NSPasteboardTypeString);
    return { id: cmd.id, ok: true, text: s ? String(ObjC.unwrap(s)) : "" };
  }
  if (op === "clipboard_set") {
    const pb = $.NSPasteboard.generalPasteboard;
    pb.clearContents;
    pb.setStringForType($(String(cmd.text !== undefined ? cmd.text : "")), $.NSPasteboardTypeString);
    return { id: cmd.id, ok: true };
  }
  if (op === "mouse_pos") {
    const p = getMousePos();
    return { id: cmd.id, ok: true, x: p.x, y: p.y };
  }
  if (op === "move") {
    const pt = { x: cmd.x, y: cmd.y };
    const evType = heldLeft ? $.kCGEventLeftMouseDragged : $.kCGEventMouseMoved;
    const ev = $.CGEventCreateMouseEvent($(), evType, pt, $.kCGMouseButtonLeft);
    $.CGEventPost($.kCGHIDEventTap, ev);
    return { id: cmd.id, ok: true };
  }
  if (op === "mouse_down" || op === "mouse_up") {
    const p = getMousePos();
    const isDown = op === "mouse_down";
    const btn = cmd.button || "left";
    let evType = isDown ? $.kCGEventLeftMouseDown : $.kCGEventLeftMouseUp;
    let cgBtn = $.kCGMouseButtonLeft;
    if (btn === "right") {
      evType = isDown ? $.kCGEventRightMouseDown : $.kCGEventRightMouseUp;
      cgBtn = $.kCGMouseButtonRight;
    } else if (btn === "middle") {
      evType = isDown ? $.kCGEventOtherMouseDown : $.kCGEventOtherMouseUp;
      cgBtn = $.kCGMouseButtonCenter;
    } else {
      heldLeft = isDown;
    }
    const ev = $.CGEventCreateMouseEvent($(), evType, p, cgBtn);
    const clickState = cmd.clickCount || lastClickCount || 1;
    lastClickCount = isDown ? clickState : 1;
    $.CGEventSetIntegerValueField(ev, $.kCGMouseEventClickState, clickState);
    if (cmd.modifiers && cmd.modifiers.length) {
      $.CGEventSetFlags(ev, flagsForMods(cmd.modifiers));
    }
    $.CGEventPost($.kCGHIDEventTap, ev);
    return { id: cmd.id, ok: true };
  }
  if (op === "scroll") {
    const ev = $.CGEventCreateScrollWheelEvent($(), $.kCGScrollEventUnitLine, 2, -Math.round(cmd.dy || 0), -Math.round(cmd.dx || 0));
    $.CGEventPost($.kCGHIDEventTap, ev);
    return { id: cmd.id, ok: true };
  }
  if (op === "key_event") {
    const ev = $.CGEventCreateKeyboardEvent($(), cmd.code, Boolean(cmd.down));
    if (cmd.modifiers && cmd.modifiers.length) {
      $.CGEventSetFlags(ev, flagsForMods(cmd.modifiers));
    }
    $.CGEventPost($.kCGHIDEventTap, ev);
    return { id: cmd.id, ok: true };
  }
  if (op === "type_text" || op === "type_char") {
    const str = String(cmd.text !== undefined ? cmd.text : (cmd.char || ""));
    let i = 0;
    while (i < str.length) {
      const end = Math.min(str.length, i + 16);
      const codes = [];
      for (let j = i; j < end; j++) codes.push(str.charCodeAt(j));
      const down = $.CGEventCreateKeyboardEvent($(), 0, true);
      const up = $.CGEventCreateKeyboardEvent($(), 0, false);
      $.CGEventKeyboardSetUnicodeString(down, codes.length, codes);
      $.CGEventKeyboardSetUnicodeString(up, codes.length, codes);
      $.CGEventPost($.kCGHIDEventTap, down);
      $.CGEventPost($.kCGHIDEventTap, up);
      i = end;
    }
    return { id: cmd.id, ok: true };
  }
  return { id: cmd.id, ok: false, error: "Unknown op: " + op };
}

let buffer = "";
while (true) {
  const data = stdin.availableData;
  if (!data || data.length === 0) break;
  const chunk = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)) || "";
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      const cmd = JSON.parse(line);
      writeJson(handleCmd(cmd));
    } catch (err) {
      writeJson({ id: -1, ok: false, error: String(err) });
    }
  }
}
`;

export interface DarwinBackendOptions {
  workerOptions?: JsonlWorkerOptions;
  capturePng?: (args: { display: DisplayInfo; region?: Region }) => Promise<Buffer>;
}

export class DarwinBackend implements DesktopBackend {
  readonly name = "darwin-coregraphics";
  readonly platform = "darwin" as const;

  private readonly worker: JsonlWorker;
  private readonly customCapturePng?: (args: { display: DisplayInfo; region?: Region }) => Promise<Buffer>;

  constructor(options: DarwinBackendOptions = {}) {
    this.worker = new JsonlWorker(
      options.workerOptions ?? {
        command: "/usr/bin/osascript",
        args: ["-l", "JavaScript", "-e", DARWIN_JXA_SCRIPT],
      },
    );
    this.customCapturePng = options.capturePng;
  }

  async init(): Promise<void> {
    await this.worker.start();
  }

  async close(): Promise<void> {
    await this.worker.stop();
  }

  async getDisplays(): Promise<DisplayInfo[]> {
    const res = await this.worker.request({ op: "displays" });
    const list = Array.isArray(res.displays) ? (res.displays as DisplayInfo[]) : [];
    if (list.length > 0) return list;
    return [
      {
        id: 0,
        name: "macOS Primary Display",
        x: 0,
        y: 0,
        width: 1440,
        height: 900,
        scaleFactor: 2,
        primary: true,
      },
    ];
  }

  async listWindows(): Promise<WindowInfo[]> {
    const res = await this.worker.request({ op: "windows" });
    return Array.isArray(res.windows) ? (res.windows as WindowInfo[]) : [];
  }

  async getActiveWindow(): Promise<WindowInfo | null> {
    const windows = await this.listWindows();
    return windows.find((w) => w.focused) ?? windows[0] ?? null;
  }

  async focusWindow(query: { title?: string; app?: string; id?: string | number }): Promise<boolean> {
    const res = await this.worker.request({
      op: "focus_window",
      title: query.title,
      app: query.app,
      windowId: query.id,
    });
    return Boolean(res.focused);
  }

  async getClipboardText(): Promise<string> {
    const res = await this.worker.request({ op: "clipboard_get" });
    return typeof res.text === "string" ? res.text : "";
  }

  async setClipboardText(text: string): Promise<void> {
    await this.worker.request({ op: "clipboard_set", text });
  }

  async getMousePosition(): Promise<Point> {
    const res = await this.worker.request({ op: "mouse_pos" });
    return { x: Number(res.x ?? 0), y: Number(res.y ?? 0) };
  }

  async moveMouse(x: number, y: number): Promise<void> {
    await this.worker.request({ op: "move", x: Math.round(x), y: Math.round(y) });
  }

  async mouseDown(button: MouseButton, clickCount = 1, modifiers: ConcreteModifier[] = []): Promise<void> {
    await this.worker.request({ op: "mouse_down", button, clickCount, modifiers });
  }

  async mouseUp(button: MouseButton, clickCount = 1, modifiers: ConcreteModifier[] = []): Promise<void> {
    await this.worker.request({ op: "mouse_up", button, clickCount, modifiers });
  }

  async scroll(deltaX: number, deltaY: number): Promise<void> {
    await this.worker.request({ op: "scroll", dx: deltaX, dy: deltaY });
  }

  async keyDown(key: string): Promise<void> {
    const parsed = parseKeyChord(key, [], "darwin");
    const entry = DARWIN_KEYCODES[parsed.key];
    if (!entry) {
      throw new Error(`Unsupported macOS keyDown key "${key}".`);
    }
    if (entry.shift) {
      await this.worker.request({ op: "key_event", code: DARWIN_KEYCODES.shift!.code, down: true });
    }
    await this.worker.request({ op: "key_event", code: entry.code, down: true });
  }

  async keyUp(key: string): Promise<void> {
    const parsed = parseKeyChord(key, [], "darwin");
    const entry = DARWIN_KEYCODES[parsed.key];
    if (!entry) {
      throw new Error(`Unsupported macOS keyUp key "${key}".`);
    }
    await this.worker.request({ op: "key_event", code: entry.code, down: false });
    if (entry.shift) {
      await this.worker.request({ op: "key_event", code: DARWIN_KEYCODES.shift!.code, down: false });
    }
  }

  async keyTap(key: string, modifiers: ConcreteModifier[] = []): Promise<void> {
    const entry = DARWIN_KEYCODES[key];
    if (!entry) {
      if (modifiers.length === 0 && Array.from(key).length === 1) {
        await this.typeText(key);
        return;
      }
      throw new Error(`Unsupported macOS key "${key}".`);
    }

    const activeMods = [...modifiers];
    if (entry.shift && !activeMods.includes("shift")) {
      activeMods.push("shift");
    }

    for (const m of activeMods) {
      await this.worker.request({ op: "key_event", code: DARWIN_KEYCODES[m]!.code, down: true, modifiers: activeMods });
    }
    await this.worker.request({ op: "key_event", code: entry.code, down: true, modifiers: activeMods });
    await this.worker.request({ op: "key_event", code: entry.code, down: false, modifiers: activeMods });
    for (const m of [...activeMods].reverse()) {
      await this.worker.request({ op: "key_event", code: DARWIN_KEYCODES[m]!.code, down: false, modifiers: [] });
    }
  }

  async typeText(text: string): Promise<void> {
    let chunk = "";
    const flush = async () => {
      if (chunk.length > 0) {
        await this.worker.request({ op: "type_text", text: chunk });
        chunk = "";
      }
    };

    for (const ch of text) {
      if (ch === "\r") continue;
      if (ch === "\n") {
        await flush();
        await this.keyTap("enter");
      } else if (ch === "\t") {
        await flush();
        await this.keyTap("tab");
      } else {
        chunk += ch;
      }
    }
    await flush();
  }

  async captureScreen(options: { display?: number; region?: Region } = {}): Promise<RawFrame> {
    const displays = await this.getDisplays();
    const disp = displays.find((d) => d.id === (options.display ?? 0)) ?? displays[0]!;

    const logicalWidth = options.region ? Math.round(options.region.width) : disp.width;
    const logicalHeight = options.region ? Math.round(options.region.height) : disp.height;
    const originX = options.region ? Math.round(options.region.x) : disp.x;
    const originY = options.region ? Math.round(options.region.y) : disp.y;

    let pngBytes: Buffer | null = null;
    if (this.customCapturePng) {
      pngBytes = await this.customCapturePng({ display: disp, region: options.region });
    } else {
      // Fast path: in-memory CoreGraphics capture through the persistent JXA worker (zero temp file I/O)
      try {
        const res = await this.worker.request(
          {
            op: "capture",
            x: originX,
            y: originY,
            width: logicalWidth,
            height: logicalHeight,
          },
          8000,
        );
        if (typeof res.pngBase64 === "string" && res.pngBase64.length > 0) {
          pngBytes = Buffer.from(res.pngBase64, "base64");
        }
      } catch {
        // Fallback to /usr/sbin/screencapture below
      }

      if (!pngBytes) {
        const dir = mkdtempSync(join(tmpdir(), "handy-mac-"));
        const outPath = join(dir, "screen.png");
        try {
          const args = ["-x", "-t", "png"];
          if (options.region) {
            args.push(
              "-R",
              `${originX},${originY},${logicalWidth},${logicalHeight}`,
            );
          } else {
            args.push("-D", String(disp.id + 1));
          }
          args.push(outPath);
          await execFileAsync("/usr/sbin/screencapture", args, { timeout: 6000 });
          pngBytes = readFileSync(outPath);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }

    const decoded = decodePng(pngBytes);
    return {
      width: decoded.width,
      height: decoded.height,
      data: decoded.data,
      originX,
      originY,
      logicalWidth,
      logicalHeight,
      scaleFactor: disp.scaleFactor || decoded.width / Math.max(1, logicalWidth),
      displayId: disp.id,
    };
  }

  async doctor(): Promise<DoctorCheck[]> {
    try {
      const res = await this.worker.request({ op: "doctor" });
      const ax = Boolean(res.accessibility);
      const sr = Boolean(res.screenRecording);
      return [
        {
          name: "macOS Accessibility Permission",
          ok: ax,
          detail: ax
            ? "Granted (CoreGraphics HID events enabled)"
            : "Not granted — enable your terminal/MCP host in System Settings -> Privacy & Security -> Accessibility",
        },
        {
          name: "macOS Screen Recording Permission",
          ok: sr,
          detail: sr
            ? "Granted (Screen capture enabled)"
            : "Not granted — enable your terminal/MCP host in System Settings -> Privacy & Security -> Screen Recording",
        },
      ];
    } catch (err) {
      return [
        {
          name: "macOS CoreGraphics Bridge",
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        },
      ];
    }
  }
}
