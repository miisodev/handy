import { existsSync, readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { parseKeyChord, toX11Keysym, X11_KEYSYMS, type ConcreteModifier } from "../keys.js";
import type { DesktopBackend, DisplayInfo, DoctorCheck, MouseButton, Point, RawFrame, Region } from "../types.js";
import { LinuxCliBackend } from "./linux-cli.js";

function pad4(n: number): number {
  return (n + 3) & ~3;
}

export interface X11DisplayTarget {
  socketPath?: string;
  host?: string;
  port?: number;
  displayNum: number;
  screenNum: number;
}

export function parseX11Display(displayEnv: string): X11DisplayTarget {
  // Support custom explicit unix path or tcp host:port for isolated testing
  if (displayEnv.startsWith("unix:/") && !/^unix:\d/.test(displayEnv)) {
    return {
      socketPath: displayEnv.slice("unix:".length),
      displayNum: 0,
      screenNum: 0,
    };
  }
  const tcpMatch = /^tcp:([^:]+):(\d+)$/.exec(displayEnv.trim());
  if (tcpMatch) {
    return {
      host: tcpMatch[1]!,
      port: Number(tcpMatch[2]),
      displayNum: 0,
      screenNum: 0,
    };
  }

  const match = /^([a-zA-Z0-9._-]*):(\d+)(?:\.(\d+))?$/.exec(displayEnv.trim());
  if (!match) {
    throw new Error(`Invalid X11 DISPLAY "${displayEnv}". Expected format like ":0" or "127.0.0.1:0".`);
  }
  const hostPart = match[1] ?? "";
  const displayNum = Number(match[2]);
  const screenNum = match[3] ? Number(match[3]) : 0;

  if (hostPart === "" || hostPart === "unix") {
    return {
      socketPath: `/tmp/.X11-unix/X${displayNum}`,
      displayNum,
      screenNum,
    };
  }

  return {
    host: hostPart,
    port: 6000 + displayNum,
    displayNum,
    screenNum,
  };
}

function readXauthorityCookie(displayNum: number): { name: string; data: Buffer } | null {
  const xauthPath = process.env.XAUTHORITY?.trim() || join(homedir(), ".Xauthority");
  if (!existsSync(xauthPath)) return null;

  try {
    const buf = readFileSync(xauthPath);
    let offset = 0;
    const localHost = hostname();
    const dispStr = String(displayNum);
    let fallback: { name: string; data: Buffer } | null = null;

    const readChunk = (): Buffer | null => {
      if (offset + 2 > buf.length) return null;
      const len = buf.readUInt16BE(offset);
      offset += 2;
      if (offset + len > buf.length) return null;
      const slice = buf.subarray(offset, offset + len);
      offset += len;
      return slice;
    };

    while (offset + 2 <= buf.length) {
      const family = buf.readUInt16BE(offset);
      offset += 2;
      const addr = readChunk();
      const num = readChunk();
      const name = readChunk();
      const data = readChunk();
      if (!addr || !num || !name || !data) break;

      const numText = num.toString("utf8");
      const nameText = name.toString("ascii");
      if (numText !== "" && numText !== dispStr) continue;
      if (nameText !== "MIT-MAGIC-COOKIE-1") continue;

      // FamilyLocal (256) or FamilyWild (65535)
      if (family === 65535 || (family === 256 && addr.toString("utf8") === localHost)) {
        return { name: nameText, data: Buffer.from(data) };
      }
      if (!fallback) {
        fallback = { name: nameText, data: Buffer.from(data) };
      }
    }
    return fallback;
  } catch {
    return null;
  }
}

interface PendingReply {
  resolve: (packet: Buffer) => void;
  reject: (err: Error) => void;
}

interface X11ScreenInfo {
  root: number;
  width: number;
  height: number;
  rootDepth: number;
  rootVisual: number;
  bitsPerPixel: number;
  scanlinePad: number;
  imageByteOrder: number;
  redMask: number;
  greenMask: number;
  blueMask: number;
}

function maskShift(mask: number): number {
  if (mask === 0) return 0;
  let s = 0;
  let m = mask >>> 0;
  while ((m & 1) === 0 && s < 32) {
    m >>>= 1;
    s++;
  }
  return s;
}

export class LinuxX11Backend implements DesktopBackend {
  readonly name = "linux-x11";
  readonly platform = "linux" as const;

  private readonly displayStr: string;
  private socket: Socket | null = null;
  private rxBuf: Buffer = Buffer.alloc(0);
  private seq = 0;
  private pending = new Map<number, PendingReply>();

  private screenInfo: X11ScreenInfo | null = null;
  private minKeycode = 8;
  private maxKeycode = 255;
  private xtestOpcode: number | null = null;
  private randrOpcode: number | null = null;

  private keysymMap = new Map<number, { keycode: number; shift: boolean }>();
  private modifierKeycodes: Record<ConcreteModifier, number> = {
    shift: 50,
    ctrl: 37,
    alt: 64,
    meta: 133,
  };
  private scratchKeycode = 254;
  private initialized = false;

  constructor(options: { display?: string } = {}) {
    this.displayStr = options.display ?? process.env.DISPLAY ?? ":0";
  }

  async init(): Promise<void> {
    if (this.initialized && this.socket && !this.socket.destroyed) return;

    const target = parseX11Display(this.displayStr);
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = target.socketPath
        ? createConnection({ path: target.socketPath })
        : createConnection({ host: target.host ?? "127.0.0.1", port: target.port ?? 6000 });
      const onErr = (err: Error) => {
        s.removeListener("connect", onConnect);
        reject(err);
      };
      const onConnect = () => {
        s.removeListener("error", onErr);
        s.setNoDelay(true);
        resolve(s);
      };
      s.once("error", onErr);
      s.once("connect", onConnect);
    });

    this.socket = socket;
    this.seq = 0;
    this.rxBuf = Buffer.alloc(0);
    this.pending.clear();

    // Perform X11 connection setup handshake before switching to framed reply loop
    const auth = readXauthorityCookie(target.displayNum);
    const authName = auth ? Buffer.from(auth.name, "ascii") : Buffer.alloc(0);
    const authData = auth ? auth.data : Buffer.alloc(0);

    const setupReq = Buffer.alloc(12 + pad4(authName.length) + pad4(authData.length));
    setupReq[0] = 0x6c; // 'l' little-endian
    setupReq[1] = 0;
    setupReq.writeUInt16LE(11, 2);
    setupReq.writeUInt16LE(0, 4);
    setupReq.writeUInt16LE(authName.length, 6);
    setupReq.writeUInt16LE(authData.length, 8);
    authName.copy(setupReq, 12);
    authData.copy(setupReq, 12 + pad4(authName.length));

    const setupReply = await new Promise<Buffer>((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length < 8) return;
        const additionalWords = buf.readUInt16LE(6);
        const totalBytes = 8 + additionalWords * 4;
        if (buf.length < totalBytes) return;
        cleanup();
        const packet = buf.subarray(0, totalBytes);
        this.rxBuf = buf.subarray(totalBytes);
        resolve(packet);
      };
      const onErr = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onClose = () => {
        cleanup();
        reject(new Error("X11 socket closed during setup handshake."));
      };
      const cleanup = () => {
        socket.off("data", onData);
        socket.off("error", onErr);
        socket.off("close", onClose);
      };
      socket.on("data", onData);
      socket.on("error", onErr);
      socket.on("close", onClose);
      socket.write(setupReq);
    });

    const status = setupReply[0]!;
    if (status !== 1) {
      const reasonLen = setupReply[1] ?? 0;
      const reason = setupReply.subarray(8, 8 + reasonLen).toString("utf8");
      socket.destroy();
      throw new Error(`X11 authentication/setup failed (status=${status}): ${reason || "access denied"}`);
    }

    this.parseSetupBody(setupReply.subarray(8), target.screenNum);

    // Attach ongoing reply/error frame demuxer
    socket.on("data", (chunk: Buffer) => {
      this.rxBuf = this.rxBuf.length === 0 ? chunk : Buffer.concat([this.rxBuf, chunk]);
      this.drainIncoming();
    });
    socket.on("error", (err: Error) => {
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
    socket.on("close", () => {
      this.initialized = false;
      const err = new Error("X11 connection closed.");
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });

    // Enable BIG-REQUESTS if supported
    const bigReq = await this.queryExtension("BIG-REQUESTS");
    if (bigReq.present) {
      const enableReq = Buffer.from([bigReq.majorOpcode, 0, 1, 0]);
      await this.sendRequestWithReply(enableReq);
    }

    // Query XTEST for hardware-level synthetic input injection
    const xtest = await this.queryExtension("XTEST");
    this.xtestOpcode = xtest.present ? xtest.majorOpcode : null;

    // Query RANDR for multi-monitor layout
    const randr = await this.queryExtension("RANDR");
    this.randrOpcode = randr.present ? randr.majorOpcode : null;

    // Load keyboard mapping table
    await this.loadKeyboardMapping();

    this.initialized = true;
    // Drain any initial leftover bytes
    if (this.rxBuf.length > 0) this.drainIncoming();
  }

  private parseSetupBody(body: Buffer, screenIndex: number): void {
    const vendorLen = body.readUInt16LE(16);
    const numScreens = body[20]!;
    const numFormats = body[21]!;
    const imageByteOrder = body[22]!;
    this.minKeycode = body[26]!;
    this.maxKeycode = body[27]!;

    let offset = 32 + pad4(vendorLen);

    const formats = new Map<number, { bpp: number; scanlinePad: number }>();
    for (let i = 0; i < numFormats; i++) {
      const depth = body[offset]!;
      const bpp = body[offset + 1]!;
      const scanlinePad = body[offset + 2]!;
      formats.set(depth, { bpp, scanlinePad });
      offset += 8;
    }

    let chosenScreen: X11ScreenInfo | null = null;
    for (let s = 0; s < numScreens; s++) {
      const root = body.readUInt32LE(offset);
      const width = body.readUInt16LE(offset + 20);
      const height = body.readUInt16LE(offset + 22);
      const rootVisual = body.readUInt32LE(offset + 32);
      const rootDepth = body[offset + 38]!;
      const numDepths = body[offset + 39]!;
      offset += 40;

      let redMask = 0x00ff0000;
      let greenMask = 0x0000ff00;
      let blueMask = 0x000000ff;

      for (let d = 0; d < numDepths; d++) {
        const numVisuals = body.readUInt16LE(offset + 2);
        offset += 8;
        for (let v = 0; v < numVisuals; v++) {
          const visualId = body.readUInt32LE(offset);
          if (visualId === rootVisual) {
            redMask = body.readUInt32LE(offset + 8);
            greenMask = body.readUInt32LE(offset + 12);
            blueMask = body.readUInt32LE(offset + 16);
          }
          offset += 24;
        }
      }

      const fmt = formats.get(rootDepth) ?? { bpp: 32, scanlinePad: 32 };
      const info: X11ScreenInfo = {
        root,
        width,
        height,
        rootDepth,
        rootVisual,
        bitsPerPixel: fmt.bpp,
        scanlinePad: fmt.scanlinePad,
        imageByteOrder,
        redMask,
        greenMask,
        blueMask,
      };
      if (s === screenIndex || !chosenScreen) {
        chosenScreen = info;
      }
    }

    if (!chosenScreen) {
      throw new Error("X11 server reported zero screens.");
    }
    this.screenInfo = chosenScreen;
  }

  private drainIncoming(): void {
    while (this.rxBuf.length >= 32) {
      const packetType = this.rxBuf[0]!;
      if (packetType === 1) {
        // Reply packet: 32 bytes + replyLength * 4 bytes
        const extraWords = this.rxBuf.readUInt32LE(4);
        const totalLen = 32 + extraWords * 4;
        if (this.rxBuf.length < totalLen) return;
        const seq = this.rxBuf.readUInt16LE(2);
        const packet = this.rxBuf.subarray(0, totalLen);
        this.rxBuf = this.rxBuf.subarray(totalLen);
        const waiter = this.pending.get(seq);
        if (waiter) {
          this.pending.delete(seq);
          waiter.resolve(packet);
        }
      } else if (packetType === 0) {
        // Error packet: 32 bytes
        const errCode = this.rxBuf[1]!;
        const seq = this.rxBuf.readUInt16LE(2);
        const majorOp = this.rxBuf[10]!;
        const minorOp = this.rxBuf.readUInt16LE(8);
        this.rxBuf = this.rxBuf.subarray(32);
        const waiter = this.pending.get(seq);
        if (waiter) {
          this.pending.delete(seq);
          waiter.reject(new Error(`X11 protocol error code=${errCode} opcode=${majorOp}:${minorOp} seq=${seq}`));
        }
      } else {
        // Asynchronous event: 32 bytes (ignore)
        this.rxBuf = this.rxBuf.subarray(32);
      }
    }
  }

  private nextSeq(): number {
    this.seq = (this.seq + 1) & 0xffff;
    return this.seq;
  }

  private sendOneWay(req: Buffer): void {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("X11 socket is not connected.");
    }
    this.nextSeq();
    this.socket.write(req);
  }

  private sendRequestWithReply(req: Buffer): Promise<Buffer> {
    if (!this.socket || this.socket.destroyed) {
      return Promise.reject(new Error("X11 socket is not connected."));
    }
    const seq = this.nextSeq();
    return new Promise<Buffer>((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });
      this.socket!.write(req);
    });
  }

  private async sync(): Promise<void> {
    // GetInputFocus (opcode 43) acts as XSync(dpy, False) round-trip barrier
    const req = Buffer.from([43, 0, 1, 0]);
    await this.sendRequestWithReply(req);
  }

  private async queryExtension(name: string): Promise<{ present: boolean; majorOpcode: number }> {
    const nameBytes = Buffer.from(name, "ascii");
    const padded = pad4(nameBytes.length);
    const req = Buffer.alloc(8 + padded);
    req[0] = 98; // QueryExtension
    req[1] = 0;
    req.writeUInt16LE((8 + padded) / 4, 2);
    req.writeUInt16LE(nameBytes.length, 4);
    nameBytes.copy(req, 8);
    const reply = await this.sendRequestWithReply(req);
    return {
      present: reply[8] === 1,
      majorOpcode: reply[9]!,
    };
  }

  private async loadKeyboardMapping(): Promise<void> {
    const count = this.maxKeycode - this.minKeycode + 1;
    const req = Buffer.alloc(8);
    req[0] = 101; // GetKeyboardMapping
    req[1] = 0;
    req.writeUInt16LE(2, 2);
    req[4] = this.minKeycode;
    req[5] = count;
    const reply = await this.sendRequestWithReply(req);
    const keysymsPerKeycode = reply[1]!;
    if (keysymsPerKeycode === 0) return;

    this.keysymMap.clear();
    let unusedCandidate = this.maxKeycode;

    for (let i = 0; i < count; i++) {
      const keycode = this.minKeycode + i;
      const baseOffset = 32 + i * keysymsPerKeycode * 4;
      let allZero = true;

      for (let col = 0; col < Math.min(2, keysymsPerKeycode); col++) {
        const symOffset = baseOffset + col * 4;
        if (symOffset + 4 > reply.length) break;
        const sym = reply.readUInt32LE(symOffset);
        if (sym !== 0) {
          allZero = false;
          if (!this.keysymMap.has(sym)) {
            this.keysymMap.set(sym, { keycode, shift: col === 1 });
          }
        }
      }

      if (allZero && keycode >= 96) {
        unusedCandidate = keycode;
      }
    }

    this.scratchKeycode = unusedCandidate;
    this.modifierKeycodes = {
      shift: this.keysymMap.get(X11_KEYSYMS.shift!)?.keycode ?? 50,
      ctrl: this.keysymMap.get(X11_KEYSYMS.ctrl!)?.keycode ?? 37,
      alt: this.keysymMap.get(X11_KEYSYMS.alt!)?.keycode ?? 64,
      meta: this.keysymMap.get(X11_KEYSYMS.meta!)?.keycode ?? 133,
    };
  }

  private sendXTestEvent(type: number, detail: number, x = 0, y = 0): void {
    if (this.xtestOpcode === null) {
      throw new Error(
        "X11 server does not advertise the XTEST extension needed for synthetic keyboard/mouse button injection.",
      );
    }
    const req = Buffer.alloc(36);
    req[0] = this.xtestOpcode;
    req[1] = 2; // X_XTestFakeInput
    req.writeUInt16LE(9, 2); // 36 / 4 = 9 words
    req[4] = type;
    req[5] = detail & 0xff;
    req.writeUInt32LE(0, 8); // CurrentTime
    req.writeUInt32LE(this.screenInfo?.root ?? 0, 12);
    req.writeInt16LE(Math.round(x), 24);
    req.writeInt16LE(Math.round(y), 26);
    this.sendOneWay(req);
  }

  private async resolveKeycodeForKeysym(keysym: number): Promise<{ keycode: number; shift: boolean }> {
    const existing = this.keysymMap.get(keysym);
    if (existing) return existing;

    // Evict any cached keysym previously bound to scratchKeycode
    for (const [sym, entry] of this.keysymMap.entries()) {
      if (entry.keycode === this.scratchKeycode) {
        this.keysymMap.delete(sym);
      }
    }

    // Dynamically bind scratchKeycode via ChangeKeyboardMapping (opcode 100)
    const req = Buffer.alloc(12);
    req[0] = 100; // ChangeKeyboardMapping
    req[1] = 1; // keycode-count = 1
    req.writeUInt16LE(3, 2); // 2 + 1*1 = 3 words
    req[4] = this.scratchKeycode;
    req[5] = 1; // keysyms-per-keycode = 1
    req.writeUInt32LE(keysym >>> 0, 8);
    this.sendOneWay(req);
    await this.sync();
    const mapped = { keycode: this.scratchKeycode, shift: false };
    this.keysymMap.set(keysym, mapped);
    return mapped;
  }

  async close(): Promise<void> {
    this.initialized = false;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.pending.clear();
  }

  private async ensureReady(): Promise<X11ScreenInfo> {
    if (!this.initialized || !this.screenInfo || !this.socket || this.socket.destroyed) {
      await this.init();
    }
    return this.screenInfo!;
  }

  async getDisplays(): Promise<DisplayInfo[]> {
    const screen = await this.ensureReady();
    if (this.randrOpcode !== null) {
      try {
        // Check RANDR version first (RRQueryVersion = minor 0)
        const verReq = Buffer.alloc(12);
        verReq[0] = this.randrOpcode;
        verReq[1] = 0;
        verReq.writeUInt16LE(3, 2);
        verReq.writeUInt32LE(1, 4);
        verReq.writeUInt32LE(5, 8);
        const verRep = await this.sendRequestWithReply(verReq);
        const maj = verRep.readUInt32LE(8);
        const min = verRep.readUInt32LE(12);
        if (maj > 1 || (maj === 1 && min >= 5)) {
          // RRGetMonitors = minor 42
          const monReq = Buffer.alloc(12);
          monReq[0] = this.randrOpcode;
          monReq[1] = 42;
          monReq.writeUInt16LE(3, 2);
          monReq.writeUInt32LE(screen.root, 4);
          monReq[8] = 1; // get-active
          const monRep = await this.sendRequestWithReply(monReq);
          const nMonitors = monRep.readUInt32LE(12);
          if (nMonitors > 0) {
            const displays: DisplayInfo[] = [];
            let off = 32;
            for (let i = 0; i < nMonitors && off + 24 <= monRep.length; i++) {
              const primary = monRep[off + 4] === 1;
              const nOutput = monRep.readUInt16LE(off + 6);
              const mx = monRep.readInt16LE(off + 8);
              const my = monRep.readInt16LE(off + 10);
              const mw = monRep.readUInt16LE(off + 12);
              const mh = monRep.readUInt16LE(off + 14);
              displays.push({
                id: i,
                name: `X11 Monitor ${i}`,
                x: mx,
                y: my,
                width: mw,
                height: mh,
                scaleFactor: 1,
                primary: primary || i === 0,
              });
              off += 24 + nOutput * 4;
            }
            if (displays.length > 0) return displays;
          }
        }
      } catch {
        // Fallback to root screen dimensions
      }
    }

    return [
      {
        id: 0,
        name: `X11 Screen (${this.displayStr})`,
        x: 0,
        y: 0,
        width: screen.width,
        height: screen.height,
        scaleFactor: 1,
        primary: true,
      },
    ];
  }

  async getMousePosition(): Promise<Point> {
    const screen = await this.ensureReady();
    const req = Buffer.alloc(8);
    req[0] = 38; // QueryPointer
    req[1] = 0;
    req.writeUInt16LE(2, 2);
    req.writeUInt32LE(screen.root, 4);
    const reply = await this.sendRequestWithReply(req);
    return {
      x: reply.readInt16LE(16),
      y: reply.readInt16LE(18),
    };
  }

  async moveMouse(x: number, y: number): Promise<void> {
    const screen = await this.ensureReady();
    const cx = Math.max(0, Math.min(screen.width - 1, Math.round(x)));
    const cy = Math.max(0, Math.min(screen.height - 1, Math.round(y)));

    if (this.xtestOpcode !== null) {
      this.sendXTestEvent(6, 0, cx, cy); // MotionNotify (6), absolute (0)
    } else {
      const req = Buffer.alloc(24);
      req[0] = 41; // WarpPointer
      req[1] = 0;
      req.writeUInt16LE(6, 2);
      req.writeUInt32LE(0, 4);
      req.writeUInt32LE(screen.root, 8);
      req.writeInt16LE(cx, 20);
      req.writeInt16LE(cy, 22);
      this.sendOneWay(req);
    }
    await this.sync();
  }

  private buttonCode(button: MouseButton): number {
    switch (button) {
      case "left":
        return 1;
      case "middle":
        return 2;
      case "right":
        return 3;
    }
  }

  async mouseDown(button: MouseButton): Promise<void> {
    await this.ensureReady();
    this.sendXTestEvent(4, this.buttonCode(button)); // ButtonPress (4)
    await this.sync();
  }

  async mouseUp(button: MouseButton): Promise<void> {
    await this.ensureReady();
    this.sendXTestEvent(5, this.buttonCode(button)); // ButtonRelease (5)
    await this.sync();
  }

  async scroll(deltaX: number, deltaY: number): Promise<void> {
    await this.ensureReady();
    const vSteps = Math.round(Math.abs(deltaY));
    const vButton = deltaY < 0 ? 4 : 5; // 4 = wheel up, 5 = wheel down
    for (let i = 0; i < vSteps; i++) {
      this.sendXTestEvent(4, vButton);
      this.sendXTestEvent(5, vButton);
    }

    const hSteps = Math.round(Math.abs(deltaX));
    const hButton = deltaX < 0 ? 6 : 7; // 6 = wheel left, 7 = wheel right
    for (let i = 0; i < hSteps; i++) {
      this.sendXTestEvent(4, hButton);
      this.sendXTestEvent(5, hButton);
    }
    await this.sync();
  }

  async keyDown(key: string): Promise<void> {
    await this.ensureReady();
    const parsed = parseKeyChord(key, [], "linux");
    const sym = toX11Keysym(parsed.key);
    const resolved = await this.resolveKeycodeForKeysym(sym);
    if (resolved.shift) {
      this.sendXTestEvent(2, this.modifierKeycodes.shift);
    }
    this.sendXTestEvent(2, resolved.keycode); // KeyPress (2)
    await this.sync();
  }

  async keyUp(key: string): Promise<void> {
    await this.ensureReady();
    const parsed = parseKeyChord(key, [], "linux");
    const sym = toX11Keysym(parsed.key);
    const resolved = await this.resolveKeycodeForKeysym(sym);
    this.sendXTestEvent(3, resolved.keycode); // KeyRelease (3)
    if (resolved.shift) {
      this.sendXTestEvent(3, this.modifierKeycodes.shift);
    }
    await this.sync();
  }

  async keyTap(key: string, modifiers: ConcreteModifier[] = []): Promise<void> {
    await this.ensureReady();
    const sym = toX11Keysym(key);
    const resolved = await this.resolveKeycodeForKeysym(sym);

    const activeMods = [...modifiers];
    if (resolved.shift && !activeMods.includes("shift")) {
      activeMods.push("shift");
    }

    for (const m of activeMods) {
      this.sendXTestEvent(2, this.modifierKeycodes[m]);
    }
    this.sendXTestEvent(2, resolved.keycode);
    this.sendXTestEvent(3, resolved.keycode);
    for (let i = activeMods.length - 1; i >= 0; i--) {
      this.sendXTestEvent(3, this.modifierKeycodes[activeMods[i]!]);
    }
    await this.sync();
  }

  async typeText(text: string): Promise<void> {
    await this.ensureReady();
    for (const ch of Array.from(text)) {
      if (ch === "\r") continue;
      if (ch === "\n") {
        await this.keyTap("enter");
        continue;
      }
      if (ch === "\t") {
        await this.keyTap("tab");
        continue;
      }
      const cp = ch.codePointAt(0)!;
      const sym = cp >= 0x20 && cp <= 0xff ? cp : 0x01000000 | cp;
      const resolved = await this.resolveKeycodeForKeysym(sym);
      if (resolved.shift) {
        this.sendXTestEvent(2, this.modifierKeycodes.shift);
      }
      this.sendXTestEvent(2, resolved.keycode);
      this.sendXTestEvent(3, resolved.keycode);
      if (resolved.shift) {
        this.sendXTestEvent(3, this.modifierKeycodes.shift);
      }
      await this.sync();
    }
  }

  async captureScreen(options: { display?: number; region?: Region } = {}): Promise<RawFrame> {
    const screen = await this.ensureReady();
    const displays = await this.getDisplays();
    const disp = displays.find((d) => d.id === (options.display ?? 0)) ?? displays[0]!;

    const rx = options.region ? Math.max(0, Math.min(screen.width - 1, Math.round(options.region.x))) : disp.x;
    const ry = options.region ? Math.max(0, Math.min(screen.height - 1, Math.round(options.region.y))) : disp.y;
    const rw = options.region
      ? Math.max(1, Math.min(screen.width - rx, Math.round(options.region.width)))
      : Math.min(disp.width, screen.width - rx);
    const rh = options.region
      ? Math.max(1, Math.min(screen.height - ry, Math.round(options.region.height)))
      : Math.min(disp.height, screen.height - ry);

    const bytesPerPixel = Math.max(2, Math.floor(screen.bitsPerPixel / 8));
    const padBytes = screen.scanlinePad / 8;
    const scanlineStride = Math.ceil((rw * bytesPerPixel) / padBytes) * padBytes;
    // Chunk into strips of <= 4MB so even constrained X servers return smoothly
    const rowsPerBand = Math.max(1, Math.min(rh, Math.floor((4 * 1024 * 1024) / Math.max(1, scanlineStride))));

    const rgba = new Uint8Array(rw * rh * 4);
    const rShift = maskShift(screen.redMask);
    const gShift = maskShift(screen.greenMask);
    const bShift = maskShift(screen.blueMask);
    const msb = screen.imageByteOrder === 1;

    for (let bandY = 0; bandY < rh; bandY += rowsPerBand) {
      const bandH = Math.min(rowsPerBand, rh - bandY);
      const req = Buffer.alloc(20);
      req[0] = 73; // GetImage
      req[1] = 2; // ZPixmap
      req.writeUInt16LE(5, 2);
      req.writeUInt32LE(screen.root, 4);
      req.writeInt16LE(rx, 8);
      req.writeInt16LE(ry + bandY, 10);
      req.writeUInt16LE(rw, 12);
      req.writeUInt16LE(bandH, 14);
      req.writeUInt32LE(0xffffffff, 16);

      let reply: Buffer;
      try {
        reply = await this.sendRequestWithReply(req);
      } catch (err) {
        // On some Wayland+XWayland compositors, root GetImage raises BadMatch (code=8); fallback to CLI screenshot tool
        if (err instanceof Error && err.message.includes("code=8")) {
          const fallback = new LinuxCliBackend();
          await fallback.init();
          return fallback.captureScreen(options);
        }
        throw err;
      }
      const data = reply.subarray(32);

      for (let row = 0; row < bandH; row++) {
        const srcRowStart = row * scanlineStride;
        const dstRowStart = (bandY + row) * rw * 4;

        if (bytesPerPixel === 4) {
          for (let col = 0; col < rw; col++) {
            const s = srcRowStart + col * 4;
            const pixel = msb ? data.readUInt32BE(s) : data.readUInt32LE(s);
            const d = dstRowStart + col * 4;
            rgba[d] = ((pixel & screen.redMask) >>> rShift) & 0xff;
            rgba[d + 1] = ((pixel & screen.greenMask) >>> gShift) & 0xff;
            rgba[d + 2] = ((pixel & screen.blueMask) >>> bShift) & 0xff;
            rgba[d + 3] = 255;
          }
        } else if (bytesPerPixel === 3) {
          for (let col = 0; col < rw; col++) {
            const s = srcRowStart + col * 3;
            const pixel = msb
              ? (data[s]! << 16) | (data[s + 1]! << 8) | data[s + 2]!
              : data[s]! | (data[s + 1]! << 8) | (data[s + 2]! << 16);
            const d = dstRowStart + col * 4;
            rgba[d] = ((pixel & screen.redMask) >>> rShift) & 0xff;
            rgba[d + 1] = ((pixel & screen.greenMask) >>> gShift) & 0xff;
            rgba[d + 2] = ((pixel & screen.blueMask) >>> bShift) & 0xff;
            rgba[d + 3] = 255;
          }
        } else {
          // 16-bit RGB565
          for (let col = 0; col < rw; col++) {
            const s = srcRowStart + col * 2;
            const pixel = msb ? data.readUInt16BE(s) : data.readUInt16LE(s);
            const d = dstRowStart + col * 4;
            rgba[d] = (((pixel >>> 11) & 0x1f) * 255) / 31;
            rgba[d + 1] = (((pixel >>> 5) & 0x3f) * 255) / 63;
            rgba[d + 2] = ((pixel & 0x1f) * 255) / 31;
            rgba[d + 3] = 255;
          }
        }
      }
    }

    return {
      width: rw,
      height: rh,
      data: rgba,
      originX: rx,
      originY: ry,
      logicalWidth: rw,
      logicalHeight: rh,
      scaleFactor: 1,
      displayId: disp.id,
    };
  }

  async doctor(): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    try {
      const screen = await this.ensureReady();
      checks.push({
        name: "X11 Socket Connection",
        ok: true,
        detail: `Connected to ${this.displayStr} (${screen.width}x${screen.height}, depth=${screen.rootDepth})`,
      });
      checks.push({
        name: "XTEST Input Extension",
        ok: this.xtestOpcode !== null,
        detail:
          this.xtestOpcode !== null
            ? `Available (opcode ${this.xtestOpcode})`
            : "Missing XTEST extension on X server",
      });
    } catch (err) {
      checks.push({
        name: "X11 Socket Connection",
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return checks;
  }
}
