import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DARWIN_KEYCODES, parseKeyChord } from "../keys.js";
import { decodePng } from "../png.js";
import { JsonlWorker } from "./jsonl-worker.js";
const execFileAsync = promisify(execFile);
/**
 * Persistent macOS JXA (JavaScript for Automation) CoreGraphics worker.
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
      // Convert Cocoa bottom-left origin to CoreGraphics top-left origin
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
      // Batch up to 16 UTF-16 code units per CGEventKeyboardSetUnicodeString call
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
export class DarwinBackend {
    name = "darwin-coregraphics";
    platform = "darwin";
    worker;
    customCapturePng;
    constructor(options = {}) {
        this.worker = new JsonlWorker(options.workerOptions ?? {
            command: "/usr/bin/osascript",
            args: ["-l", "JavaScript", "-e", DARWIN_JXA_SCRIPT],
        });
        this.customCapturePng = options.capturePng;
    }
    async init() {
        await this.worker.start();
    }
    async close() {
        await this.worker.stop();
    }
    async getDisplays() {
        const res = await this.worker.request({ op: "displays" });
        const list = Array.isArray(res.displays) ? res.displays : [];
        if (list.length > 0)
            return list;
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
    async getMousePosition() {
        const res = await this.worker.request({ op: "mouse_pos" });
        return { x: Number(res.x ?? 0), y: Number(res.y ?? 0) };
    }
    async moveMouse(x, y) {
        await this.worker.request({ op: "move", x: Math.round(x), y: Math.round(y) });
    }
    async mouseDown(button, clickCount = 1, modifiers = []) {
        await this.worker.request({ op: "mouse_down", button, clickCount, modifiers });
    }
    async mouseUp(button, clickCount = 1, modifiers = []) {
        await this.worker.request({ op: "mouse_up", button, clickCount, modifiers });
    }
    async scroll(deltaX, deltaY) {
        await this.worker.request({ op: "scroll", dx: deltaX, dy: deltaY });
    }
    async keyDown(key) {
        const parsed = parseKeyChord(key, [], "darwin");
        const entry = DARWIN_KEYCODES[parsed.key];
        if (!entry) {
            throw new Error(`Unsupported macOS keyDown key "${key}".`);
        }
        if (entry.shift) {
            await this.worker.request({ op: "key_event", code: DARWIN_KEYCODES.shift.code, down: true });
        }
        await this.worker.request({ op: "key_event", code: entry.code, down: true });
    }
    async keyUp(key) {
        const parsed = parseKeyChord(key, [], "darwin");
        const entry = DARWIN_KEYCODES[parsed.key];
        if (!entry) {
            throw new Error(`Unsupported macOS keyUp key "${key}".`);
        }
        await this.worker.request({ op: "key_event", code: entry.code, down: false });
        if (entry.shift) {
            await this.worker.request({ op: "key_event", code: DARWIN_KEYCODES.shift.code, down: false });
        }
    }
    async keyTap(key, modifiers = []) {
        const entry = DARWIN_KEYCODES[key];
        if (!entry) {
            // Fallback to Unicode character typing when no modifier is held
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
            await this.worker.request({ op: "key_event", code: DARWIN_KEYCODES[m].code, down: true, modifiers: activeMods });
        }
        await this.worker.request({ op: "key_event", code: entry.code, down: true, modifiers: activeMods });
        await this.worker.request({ op: "key_event", code: entry.code, down: false, modifiers: activeMods });
        for (const m of [...activeMods].reverse()) {
            await this.worker.request({ op: "key_event", code: DARWIN_KEYCODES[m].code, down: false, modifiers: [] });
        }
    }
    async typeText(text) {
        let chunk = "";
        const flush = async () => {
            if (chunk.length > 0) {
                await this.worker.request({ op: "type_text", text: chunk });
                chunk = "";
            }
        };
        for (const ch of text) {
            if (ch === "\r")
                continue;
            if (ch === "\n") {
                await flush();
                await this.keyTap("enter");
            }
            else if (ch === "\t") {
                await flush();
                await this.keyTap("tab");
            }
            else {
                chunk += ch;
            }
        }
        await flush();
    }
    async captureScreen(options = {}) {
        const displays = await this.getDisplays();
        const disp = displays.find((d) => d.id === (options.display ?? 0)) ?? displays[0];
        let pngBytes;
        if (this.customCapturePng) {
            pngBytes = await this.customCapturePng({ display: disp, region: options.region });
        }
        else {
            const dir = mkdtempSync(join(tmpdir(), "handy-mac-"));
            const outPath = join(dir, "screen.png");
            try {
                // -x suppresses shutter sound; -t png forces PNG
                const args = ["-x", "-t", "png"];
                if (options.region) {
                    args.push("-R", `${Math.round(options.region.x)},${Math.round(options.region.y)},${Math.round(options.region.width)},${Math.round(options.region.height)}`);
                }
                else {
                    // screencapture -D is 1-indexed
                    args.push("-D", String(disp.id + 1));
                }
                args.push(outPath);
                await execFileAsync("/usr/sbin/screencapture", args, { timeout: 6000 });
                pngBytes = readFileSync(outPath);
            }
            finally {
                rmSync(dir, { recursive: true, force: true });
            }
        }
        const decoded = decodePng(pngBytes);
        const logicalWidth = options.region ? Math.round(options.region.width) : disp.width;
        const logicalHeight = options.region ? Math.round(options.region.height) : disp.height;
        const originX = options.region ? Math.round(options.region.x) : disp.x;
        const originY = options.region ? Math.round(options.region.y) : disp.y;
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
    async doctor() {
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
        }
        catch (err) {
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
