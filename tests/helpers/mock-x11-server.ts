import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drawText, fillRect, strokeRect } from "../../src/font.js";
import { X11_KEYSYMS } from "../../src/keys.js";

function pad4(n: number): number {
  return (n + 3) & ~3;
}

/**
 * Real X11 Version 11 binary wire-protocol server over a UNIX domain socket.
 * Implements Connection Setup, QueryExtension (BIG-REQUESTS, XTEST, RANDR),
 * GetKeyboardMapping, ChangeKeyboardMapping, QueryPointer, WarpPointer,
 * XTestFakeInput, GetInputFocus, RRQueryVersion, RRGetMonitors, and GetImage (ZPixmap BGRA).
 */
export class MockX11Server {
  readonly width: number;
  readonly height: number;
  readonly tempDir: string;
  readonly socketPath: string;
  displayString: string;

  mouse = { x: 100, y: 100 };
  focusedInput = false;
  typedText = "";
  buttonEvents: Array<{ type: "down" | "up"; button: number; x: number; y: number }> = [];
  keyEvents: Array<{ type: "down" | "up"; keycode: number; keysym: number }> = [];
  heldShift = false;
  heldCtrl = false;

  private server: Server | null = null;
  private clients = new Set<Socket>();
  private keymap = new Map<number, [number, number]>();

  private static readonly OPCODE_BIGREQ = 133;
  private static readonly OPCODE_XTEST = 132;
  private static readonly OPCODE_RANDR = 140;
  private static readonly ROOT_WIN = 0x00000101;
  private static readonly ROOT_VISUAL = 0x00000021;

  // Input box hitbox at (180, 120, 280, 44)
  static readonly INPUT_BOX = { x: 180, y: 120, width: 280, height: 44 };

  constructor(width = 800, height = 600) {
    this.width = width;
    this.height = height;
    this.tempDir = mkdtempSync(join(tmpdir(), "handy-x11-"));
    this.socketPath = join(this.tempDir, "X99");
    this.displayString = `unix:${this.socketPath}`;
    this.initDefaultKeymap();
  }

  private initDefaultKeymap(): void {
    // Populate standard ASCII & modifier keycodes (min=8..max=255)
    this.keymap.set(36, [X11_KEYSYMS.enter!, X11_KEYSYMS.enter!]);
    this.keymap.set(22, [X11_KEYSYMS.backspace!, X11_KEYSYMS.backspace!]);
    this.keymap.set(23, [X11_KEYSYMS.tab!, X11_KEYSYMS.tab!]);
    this.keymap.set(9, [X11_KEYSYMS.escape!, X11_KEYSYMS.escape!]);
    this.keymap.set(50, [X11_KEYSYMS.shift!, X11_KEYSYMS.shift!]);
    this.keymap.set(37, [X11_KEYSYMS.ctrl!, X11_KEYSYMS.ctrl!]);
    this.keymap.set(64, [X11_KEYSYMS.alt!, X11_KEYSYMS.alt!]);
    this.keymap.set(133, [X11_KEYSYMS.meta!, X11_KEYSYMS.meta!]);
    this.keymap.set(65, [0x20, 0x20]); // space

    // Map 'a'..'z' + 'A'..'Z' starting at keycode 70
    let kc = 70;
    for (let ch = 97; ch <= 122; ch++) {
      this.keymap.set(kc++, [ch, ch - 32]);
    }
    // Map '0'..'9' starting at keycode 100
    for (let ch = 48; ch <= 57; ch++) {
      this.keymap.set(kc++, [ch, ch]);
    }
  }

  async start(): Promise<void> {
    this.server = createServer((socket) => {
      this.clients.add(socket);
      socket.on("close", () => this.clients.delete(socket));
      this.handleClient(socket);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      if (process.platform === "win32") {
        this.server!.listen(0, "127.0.0.1", () => {
          const addr = this.server!.address();
          if (addr && typeof addr === "object") {
            this.displayString = `tcp:127.0.0.1:${addr.port}`;
          }
          resolve();
        });
      } else {
        this.server!.listen(this.socketPath, () => resolve());
      }
    });
  }

  async stop(): Promise<void> {
    for (const c of this.clients) c.destroy();
    this.clients.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    rmSync(this.tempDir, { recursive: true, force: true });
  }

  private handleClient(socket: Socket): void {
    let handshakeDone = false;
    let seq = 0;
    let buf = Buffer.alloc(0);

    socket.on("data", (chunk: Buffer) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);

      if (!handshakeDone) {
        if (buf.length < 12) return;
        const authNameLen = buf.readUInt16LE(6);
        const authDataLen = buf.readUInt16LE(8);
        const setupReqLen = 12 + pad4(authNameLen) + pad4(authDataLen);
        if (buf.length < setupReqLen) return;
        buf = buf.subarray(setupReqLen);
        handshakeDone = true;
        socket.write(this.buildSetupAccept());
      }

      while (buf.length >= 4) {
        const major = buf[0]!;
        let lenWords = buf.readUInt16LE(2);
        let headerOffset = 0;
        if (lenWords === 0) {
          if (buf.length < 8) return;
          lenWords = buf.readUInt32LE(4);
          headerOffset = 4;
        }
        const totalBytes = lenWords * 4;
        if (totalBytes === 0 || buf.length < totalBytes) return;

        const req = buf.subarray(0, totalBytes);
        buf = buf.subarray(totalBytes);
        seq = (seq + 1) & 0xffff;

        this.dispatchRequest(socket, seq, major, req, headerOffset);
      }
    });
  }

  private buildSetupAccept(): Buffer {
    const vendor = Buffer.from("HandyMockX11", "ascii");
    const vendorPadded = pad4(vendor.length);
    // 1 FORMAT (8 bytes), 1 SCREEN (40 bytes + 1 DEPTH (8 bytes) + 1 VISUALTYPE (24 bytes) = 72 bytes)
    const bodyLen = 32 + vendorPadded + 8 + 72;
    const packet = Buffer.alloc(8 + bodyLen);

    packet[0] = 1; // Success
    packet.writeUInt16LE(11, 2);
    packet.writeUInt16LE(0, 4);
    packet.writeUInt16LE(bodyLen / 4, 6);

    const body = packet.subarray(8);
    body.writeUInt32LE(1, 0); // release
    body.writeUInt32LE(0x02000000, 4); // resourceIdBase
    body.writeUInt32LE(0x001fffff, 8); // resourceIdMask
    body.writeUInt16LE(vendor.length, 16);
    body.writeUInt16LE(65535, 18); // maxRequestLength
    body[20] = 1; // numScreens
    body[21] = 1; // numFormats
    body[22] = 0; // LSBFirst
    body[26] = 8; // minKeycode
    body[27] = 255; // maxKeycode
    vendor.copy(body, 32);

    let off = 32 + vendorPadded;
    // FORMAT: depth=24, bpp=32, scanlinePad=32
    body[off] = 24;
    body[off + 1] = 32;
    body[off + 2] = 32;
    off += 8;

    // SCREEN
    body.writeUInt32LE(MockX11Server.ROOT_WIN, off);
    body.writeUInt16LE(this.width, off + 20);
    body.writeUInt16LE(this.height, off + 22);
    body.writeUInt32LE(MockX11Server.ROOT_VISUAL, off + 32);
    body[off + 38] = 24; // rootDepth
    body[off + 39] = 1; // numAllowedDepths
    off += 40;

    // DEPTH
    body[off] = 24;
    body.writeUInt16LE(1, off + 2); // 1 visual
    off += 8;

    // VISUALTYPE (BGRA in little-endian memory: R=0x00ff0000, G=0x0000ff00, B=0x000000ff)
    body.writeUInt32LE(MockX11Server.ROOT_VISUAL, off);
    body[off + 4] = 4; // TrueColor
    body[off + 5] = 8;
    body.writeUInt16LE(256, off + 6);
    body.writeUInt32LE(0x00ff0000, off + 8);
    body.writeUInt32LE(0x0000ff00, off + 12);
    body.writeUInt32LE(0x000000ff, off + 16);

    return packet;
  }

  private renderBgbaFramebuffer(): Buffer {
    // Render RGBA first using font helpers, then convert to X11 BGRX little-endian pixels
    const rgba = new Uint8Array(this.width * this.height * 4);
    fillRect(rgba, this.width, this.height, 0, 0, this.width, this.height, [248, 250, 252, 255]);
    const box = MockX11Server.INPUT_BOX;
    fillRect(rgba, this.width, this.height, box.x, box.y, box.width, box.height, [255, 255, 255, 255]);
    strokeRect(
      rgba,
      this.width,
      this.height,
      box.x,
      box.y,
      box.width,
      box.height,
      this.focusedInput ? [2, 132, 199, 255] : [148, 163, 184, 255],
      2,
    );
    if (this.typedText) {
      drawText(rgba, this.width, this.height, box.x + 10, box.y + 14, this.typedText, [15, 23, 42, 255], 2);
    }

    const bgrx = Buffer.allocUnsafe(this.width * this.height * 4);
    for (let i = 0; i < this.width * this.height; i++) {
      const s = i * 4;
      const r = rgba[s]!;
      const g = rgba[s + 1]!;
      const b = rgba[s + 2]!;
      const pixel = ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
      bgrx.writeUInt32LE(pixel >>> 0, s);
    }
    return bgrx;
  }

  private dispatchRequest(socket: Socket, seq: number, major: number, req: Buffer, _hdrOff: number): void {
    // QueryExtension (98)
    if (major === 98) {
      const nameLen = req.readUInt16LE(4);
      const name = req.subarray(8, 8 + nameLen).toString("ascii");
      const rep = Buffer.alloc(32);
      rep[0] = 1;
      rep.writeUInt16LE(seq, 2);
      if (name === "BIG-REQUESTS") {
        rep[8] = 1;
        rep[9] = MockX11Server.OPCODE_BIGREQ;
      } else if (name === "XTEST") {
        rep[8] = 1;
        rep[9] = MockX11Server.OPCODE_XTEST;
      } else if (name === "RANDR") {
        rep[8] = 1;
        rep[9] = MockX11Server.OPCODE_RANDR;
      }
      socket.write(rep);
      return;
    }

    // BIG-REQUESTS Enable
    if (major === MockX11Server.OPCODE_BIGREQ) {
      const rep = Buffer.alloc(32);
      rep[0] = 1;
      rep.writeUInt16LE(seq, 2);
      rep.writeUInt32LE(4194303, 8);
      socket.write(rep);
      return;
    }

    // RANDR
    if (major === MockX11Server.OPCODE_RANDR) {
      const minor = req[1]!;
      if (minor === 0) {
        // RRQueryVersion -> 1.5
        const rep = Buffer.alloc(32);
        rep[0] = 1;
        rep.writeUInt16LE(seq, 2);
        rep.writeUInt32LE(1, 8);
        rep.writeUInt32LE(5, 12);
        socket.write(rep);
        return;
      }
      if (minor === 42) {
        // RRGetMonitors -> 1 monitor (24 bytes)
        const rep = Buffer.alloc(32 + 24);
        rep[0] = 1;
        rep.writeUInt16LE(seq, 2);
        rep.writeUInt32LE(24 / 4, 4);
        rep.writeUInt32LE(1, 12); // nMonitors = 1
        const m = rep.subarray(32);
        m.writeUInt32LE(1, 0); // name atom
        m[4] = 1; // primary
        m.writeUInt16LE(0, 6); // nOutput
        m.writeInt16LE(0, 8);
        m.writeInt16LE(0, 10);
        m.writeUInt16LE(this.width, 12);
        m.writeUInt16LE(this.height, 14);
        socket.write(rep);
        return;
      }
    }

    // GetKeyboardMapping (101)
    if (major === 101) {
      const first = req[4]!;
      const count = req[5]!;
      const perKey = 2;
      const payload = Buffer.alloc(count * perKey * 4);
      for (let i = 0; i < count; i++) {
        const pair = this.keymap.get(first + i);
        if (pair) {
          payload.writeUInt32LE(pair[0] >>> 0, i * 8);
          payload.writeUInt32LE(pair[1] >>> 0, i * 8 + 4);
        }
      }
      const rep = Buffer.alloc(32);
      rep[0] = 1;
      rep[1] = perKey;
      rep.writeUInt16LE(seq, 2);
      rep.writeUInt32LE(payload.length / 4, 4);
      socket.write(Buffer.concat([rep, payload]));
      return;
    }

    // ChangeKeyboardMapping (100)
    if (major === 100) {
      const count = req[1]!;
      const first = req[4]!;
      const perKey = req[5]!;
      for (let i = 0; i < count; i++) {
        const s0 = req.readUInt32LE(8 + i * perKey * 4);
        const s1 = perKey > 1 ? req.readUInt32LE(8 + i * perKey * 4 + 4) : s0;
        this.keymap.set(first + i, [s0, s1]);
      }
      return;
    }

    // GetInputFocus (43)
    if (major === 43) {
      const rep = Buffer.alloc(32);
      rep[0] = 1;
      rep[1] = 1;
      rep.writeUInt16LE(seq, 2);
      rep.writeUInt32LE(MockX11Server.ROOT_WIN, 8);
      socket.write(rep);
      return;
    }

    // QueryPointer (38)
    if (major === 38) {
      const rep = Buffer.alloc(32);
      rep[0] = 1;
      rep[1] = 1;
      rep.writeUInt16LE(seq, 2);
      rep.writeUInt32LE(MockX11Server.ROOT_WIN, 8);
      rep.writeInt16LE(this.mouse.x, 16);
      rep.writeInt16LE(this.mouse.y, 18);
      socket.write(rep);
      return;
    }

    // WarpPointer (41)
    if (major === 41) {
      this.mouse = {
        x: Math.max(0, Math.min(this.width - 1, req.readInt16LE(20))),
        y: Math.max(0, Math.min(this.height - 1, req.readInt16LE(22))),
      };
      return;
    }

    // XTEST FakeInput (minor 2)
    if (major === MockX11Server.OPCODE_XTEST && req[1] === 2) {
      const evType = req[4]!;
      const detail = req[5]!;
      if (evType === 6) {
        // MotionNotify
        const rx = req.readInt16LE(24);
        const ry = req.readInt16LE(26);
        this.mouse =
          detail === 1
            ? { x: this.mouse.x + rx, y: this.mouse.y + ry }
            : { x: rx, y: ry };
      } else if (evType === 4 || evType === 5) {
        // ButtonPress / ButtonRelease
        const kind = evType === 4 ? "down" : "up";
        this.buttonEvents.push({ type: kind, button: detail, x: this.mouse.x, y: this.mouse.y });
        if (evType === 4 && detail === 1) {
          const b = MockX11Server.INPUT_BOX;
          this.focusedInput =
            this.mouse.x >= b.x &&
            this.mouse.x <= b.x + b.width &&
            this.mouse.y >= b.y &&
            this.mouse.y <= b.y + b.height;
        }
      } else if (evType === 2 || evType === 3) {
        // KeyPress / KeyRelease
        const pair = this.keymap.get(detail) ?? [0, 0];
        const sym = this.heldShift ? pair[1] : pair[0];
        this.keyEvents.push({ type: evType === 2 ? "down" : "up", keycode: detail, keysym: sym });

        if (sym === X11_KEYSYMS.shift) {
          this.heldShift = evType === 2;
        } else if (sym === X11_KEYSYMS.ctrl) {
          this.heldCtrl = evType === 2;
        } else if (evType === 2 && this.focusedInput) {
          if (this.heldCtrl && (sym === 0x61 || sym === 0x41)) {
            // Ctrl+A clears on next backspace in simple test input
          } else if (sym === X11_KEYSYMS.backspace) {
            this.typedText = Array.from(this.typedText).slice(0, -1).join("");
          } else if (sym >= 0x20 && sym <= 0xff) {
            this.typedText += String.fromCodePoint(sym);
          } else if ((sym & 0xff000000) === 0x01000000) {
            this.typedText += String.fromCodePoint(sym & 0x00ffffff);
          }
        }
      }
      return;
    }

    // GetImage (73)
    if (major === 73) {
      const rx = req.readInt16LE(8);
      const ry = req.readInt16LE(10);
      const rw = req.readUInt16LE(12);
      const rh = req.readUInt16LE(14);
      const fullBgrx = this.renderBgbaFramebuffer();
      const out = Buffer.allocUnsafe(rw * rh * 4);
      for (let row = 0; row < rh; row++) {
        const srcOff = ((ry + row) * this.width + rx) * 4;
        fullBgrx.copy(out, row * rw * 4, srcOff, srcOff + rw * 4);
      }

      const rep = Buffer.alloc(32);
      rep[0] = 1;
      rep[1] = 24; // depth
      rep.writeUInt16LE(seq, 2);
      rep.writeUInt32LE(out.length / 4, 4);
      rep.writeUInt32LE(MockX11Server.ROOT_VISUAL, 8);
      socket.write(Buffer.concat([rep, out]));
    }
  }
}
