import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { parseKeyChord, toX11Keysym, X11_KEYSYMS } from "../keys.js";
import { LinuxCliBackend, readLinuxClipboard, writeLinuxClipboard } from "./linux-cli.js";
function pad4(n) {
    return (n + 3) & ~3;
}
export function parseX11Display(displayEnv) {
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
            host: tcpMatch[1],
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
function readXauthorityCookie(displayNum) {
    const xauthPath = process.env.XAUTHORITY?.trim() || join(homedir(), ".Xauthority");
    if (!existsSync(xauthPath))
        return null;
    try {
        const buf = readFileSync(xauthPath);
        let offset = 0;
        const localHost = hostname();
        const dispStr = String(displayNum);
        let fallback = null;
        const readChunk = () => {
            if (offset + 2 > buf.length)
                return null;
            const len = buf.readUInt16BE(offset);
            offset += 2;
            if (offset + len > buf.length)
                return null;
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
            if (!addr || !num || !name || !data)
                break;
            const numText = num.toString("utf8");
            const nameText = name.toString("ascii");
            if (numText !== "" && numText !== dispStr)
                continue;
            if (nameText !== "MIT-MAGIC-COOKIE-1")
                continue;
            // FamilyLocal (256) or FamilyWild (65535)
            if (family === 65535 || (family === 256 && addr.toString("utf8") === localHost)) {
                return { name: nameText, data: Buffer.from(data) };
            }
            if (!fallback) {
                fallback = { name: nameText, data: Buffer.from(data) };
            }
        }
        return fallback;
    }
    catch {
        return null;
    }
}
function maskShift(mask) {
    if (mask === 0)
        return 0;
    let s = 0;
    let m = mask >>> 0;
    while ((m & 1) === 0 && s < 32) {
        m >>>= 1;
        s++;
    }
    return s;
}
export class LinuxX11Backend {
    name = "linux-x11";
    platform = "linux";
    displayStr;
    socket = null;
    rxBuf = Buffer.alloc(0);
    seq = 0;
    pending = new Map();
    screenInfo = null;
    minKeycode = 8;
    maxKeycode = 255;
    xtestOpcode = null;
    randrOpcode = null;
    keysymMap = new Map();
    modifierKeycodes = {
        shift: 50,
        ctrl: 37,
        alt: 64,
        meta: 133,
    };
    scratchKeycode = 254;
    atomCache = new Map();
    initialized = false;
    constructor(options = {}) {
        this.displayStr = options.display ?? process.env.DISPLAY ?? ":0";
    }
    async init() {
        if (this.initialized && this.socket && !this.socket.destroyed)
            return;
        const target = parseX11Display(this.displayStr);
        const socket = await new Promise((resolve, reject) => {
            const s = target.socketPath
                ? createConnection({ path: target.socketPath })
                : createConnection({ host: target.host ?? "127.0.0.1", port: target.port ?? 6000 });
            const onErr = (err) => {
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
        const setupReply = await new Promise((resolve, reject) => {
            let buf = Buffer.alloc(0);
            const onData = (chunk) => {
                buf = Buffer.concat([buf, chunk]);
                if (buf.length < 8)
                    return;
                const additionalWords = buf.readUInt16LE(6);
                const totalBytes = 8 + additionalWords * 4;
                if (buf.length < totalBytes)
                    return;
                cleanup();
                const packet = buf.subarray(0, totalBytes);
                this.rxBuf = buf.subarray(totalBytes);
                resolve(packet);
            };
            const onErr = (err) => {
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
        const status = setupReply[0];
        if (status !== 1) {
            const reasonLen = setupReply[1] ?? 0;
            const reason = setupReply.subarray(8, 8 + reasonLen).toString("utf8");
            socket.destroy();
            throw new Error(`X11 authentication/setup failed (status=${status}): ${reason || "access denied"}`);
        }
        this.parseSetupBody(setupReply.subarray(8), target.screenNum);
        // Attach ongoing reply/error frame demuxer
        socket.on("data", (chunk) => {
            this.rxBuf = this.rxBuf.length === 0 ? chunk : Buffer.concat([this.rxBuf, chunk]);
            this.drainIncoming();
        });
        socket.on("error", (err) => {
            for (const p of this.pending.values())
                p.reject(err);
            this.pending.clear();
        });
        socket.on("close", () => {
            this.initialized = false;
            const err = new Error("X11 connection closed.");
            for (const p of this.pending.values())
                p.reject(err);
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
        if (this.rxBuf.length > 0)
            this.drainIncoming();
    }
    parseSetupBody(body, screenIndex) {
        const vendorLen = body.readUInt16LE(16);
        const numScreens = body[20];
        const numFormats = body[21];
        const imageByteOrder = body[22];
        this.minKeycode = body[26];
        this.maxKeycode = body[27];
        let offset = 32 + pad4(vendorLen);
        const formats = new Map();
        for (let i = 0; i < numFormats; i++) {
            const depth = body[offset];
            const bpp = body[offset + 1];
            const scanlinePad = body[offset + 2];
            formats.set(depth, { bpp, scanlinePad });
            offset += 8;
        }
        let chosenScreen = null;
        for (let s = 0; s < numScreens; s++) {
            const root = body.readUInt32LE(offset);
            const width = body.readUInt16LE(offset + 20);
            const height = body.readUInt16LE(offset + 22);
            const rootVisual = body.readUInt32LE(offset + 32);
            const rootDepth = body[offset + 38];
            const numDepths = body[offset + 39];
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
            const info = {
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
    drainIncoming() {
        while (this.rxBuf.length >= 32) {
            const packetType = this.rxBuf[0];
            if (packetType === 1) {
                // Reply packet: 32 bytes + replyLength * 4 bytes
                const extraWords = this.rxBuf.readUInt32LE(4);
                const totalLen = 32 + extraWords * 4;
                if (this.rxBuf.length < totalLen)
                    return;
                const seq = this.rxBuf.readUInt16LE(2);
                const packet = this.rxBuf.subarray(0, totalLen);
                this.rxBuf = this.rxBuf.subarray(totalLen);
                const waiter = this.pending.get(seq);
                if (waiter) {
                    this.pending.delete(seq);
                    waiter.resolve(packet);
                }
            }
            else if (packetType === 0) {
                // Error packet: 32 bytes
                const errCode = this.rxBuf[1];
                const seq = this.rxBuf.readUInt16LE(2);
                const majorOp = this.rxBuf[10];
                const minorOp = this.rxBuf.readUInt16LE(8);
                this.rxBuf = this.rxBuf.subarray(32);
                const waiter = this.pending.get(seq);
                if (waiter) {
                    this.pending.delete(seq);
                    waiter.reject(new Error(`X11 protocol error code=${errCode} opcode=${majorOp}:${minorOp} seq=${seq}`));
                }
            }
            else {
                // Asynchronous event: 32 bytes (ignore)
                this.rxBuf = this.rxBuf.subarray(32);
            }
        }
    }
    nextSeq() {
        this.seq = (this.seq + 1) & 0xffff;
        return this.seq;
    }
    sendOneWay(req) {
        if (!this.socket || this.socket.destroyed) {
            throw new Error("X11 socket is not connected.");
        }
        this.nextSeq();
        this.socket.write(req);
    }
    sendRequestWithReply(req, timeoutMs = 4000) {
        if (!this.socket || this.socket.destroyed) {
            return Promise.reject(new Error("X11 socket is not connected."));
        }
        const seq = this.nextSeq();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pending.delete(seq)) {
                    reject(new Error(`X11 request opcode=${req[0]} seq=${seq} timed out after ${timeoutMs}ms`));
                }
            }, timeoutMs);
            this.pending.set(seq, {
                resolve: (pkt) => {
                    clearTimeout(timer);
                    resolve(pkt);
                },
                reject: (err) => {
                    clearTimeout(timer);
                    reject(err);
                },
            });
            this.socket.write(req);
        });
    }
    async sync() {
        // GetInputFocus (opcode 43) acts as XSync(dpy, False) round-trip barrier
        const req = Buffer.from([43, 0, 1, 0]);
        await this.sendRequestWithReply(req);
    }
    async queryExtension(name) {
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
            majorOpcode: reply[9],
        };
    }
    async loadKeyboardMapping() {
        const count = this.maxKeycode - this.minKeycode + 1;
        const req = Buffer.alloc(8);
        req[0] = 101; // GetKeyboardMapping
        req[1] = 0;
        req.writeUInt16LE(2, 2);
        req[4] = this.minKeycode;
        req[5] = count;
        const reply = await this.sendRequestWithReply(req);
        const keysymsPerKeycode = reply[1];
        if (keysymsPerKeycode === 0)
            return;
        this.keysymMap.clear();
        let unusedCandidate = this.maxKeycode;
        for (let i = 0; i < count; i++) {
            const keycode = this.minKeycode + i;
            const baseOffset = 32 + i * keysymsPerKeycode * 4;
            let allZero = true;
            for (let col = 0; col < Math.min(2, keysymsPerKeycode); col++) {
                const symOffset = baseOffset + col * 4;
                if (symOffset + 4 > reply.length)
                    break;
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
            shift: this.keysymMap.get(X11_KEYSYMS.shift)?.keycode ?? 50,
            ctrl: this.keysymMap.get(X11_KEYSYMS.ctrl)?.keycode ?? 37,
            alt: this.keysymMap.get(X11_KEYSYMS.alt)?.keycode ?? 64,
            meta: this.keysymMap.get(X11_KEYSYMS.meta)?.keycode ?? 133,
        };
    }
    sendXTestEvent(type, detail, x = 0, y = 0) {
        if (this.xtestOpcode === null) {
            throw new Error("X11 server does not advertise the XTEST extension needed for synthetic keyboard/mouse button injection.");
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
    async resolveKeycodeForKeysym(keysym) {
        const existing = this.keysymMap.get(keysym);
        if (existing)
            return existing;
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
    async close() {
        this.initialized = false;
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
        this.pending.clear();
        this.atomCache.clear();
    }
    async ensureReady() {
        if (!this.initialized || !this.screenInfo || !this.socket || this.socket.destroyed) {
            await this.init();
        }
        return this.screenInfo;
    }
    async getDisplays() {
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
                        const displays = [];
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
                        if (displays.length > 0)
                            return displays;
                    }
                }
            }
            catch {
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
    async internAtom(name) {
        const cached = this.atomCache.get(name);
        if (cached !== undefined)
            return cached;
        const nameBytes = Buffer.from(name, "ascii");
        const padded = pad4(nameBytes.length);
        const req = Buffer.alloc(8 + padded);
        req[0] = 16; // InternAtom
        req[1] = 0; // only-if-exists = false
        req.writeUInt16LE((8 + padded) / 4, 2);
        req.writeUInt16LE(nameBytes.length, 4);
        nameBytes.copy(req, 8);
        const reply = await this.sendRequestWithReply(req);
        const atom = reply.readUInt32LE(8);
        this.atomCache.set(name, atom);
        return atom;
    }
    async getProperty(window, propertyAtom) {
        const req = Buffer.alloc(24);
        req[0] = 20; // GetProperty
        req[1] = 0; // delete = false
        req.writeUInt16LE(6, 2);
        req.writeUInt32LE(window >>> 0, 4);
        req.writeUInt32LE(propertyAtom >>> 0, 8);
        req.writeUInt32LE(0, 12); // AnyPropertyType
        req.writeUInt32LE(0, 16); // long-offset
        req.writeUInt32LE(1024, 20); // long-length
        const reply = await this.sendRequestWithReply(req);
        const format = reply[1];
        if (format === 0)
            return { format: 0, value: Buffer.alloc(0) };
        const valueLen = reply.readUInt32LE(16);
        const byteCount = valueLen * (format / 8);
        return {
            format,
            value: reply.subarray(32, Math.min(reply.length, 32 + byteCount)),
        };
    }
    async getActiveWindowId(root) {
        try {
            const netActive = await this.internAtom("_NET_ACTIVE_WINDOW");
            const prop = await this.getProperty(root, netActive);
            if (prop.format === 32 && prop.value.length >= 4) {
                const id = prop.value.readUInt32LE(0);
                if (id > 0 && id !== root)
                    return id;
            }
        }
        catch {
            // fall through
        }
        try {
            const reply = await this.sendRequestWithReply(Buffer.from([43, 0, 1, 0])); // GetInputFocus
            const focus = reply.readUInt32LE(8);
            if (focus > 1 && focus !== root)
                return focus;
        }
        catch {
            // ignore
        }
        return 0;
    }
    async inspectX11Window(winId, root, activeId, netWmNameAtom, netWmPidAtom) {
        try {
            let title = "";
            const utf8Name = await this.getProperty(winId, netWmNameAtom);
            if (utf8Name.format === 8 && utf8Name.value.length > 0) {
                title = utf8Name.value.toString("utf8").replace(/\0+$/g, "").trim();
            }
            if (!title) {
                const wmName = await this.getProperty(winId, 39); // XA_WM_NAME
                if (wmName.format === 8 && wmName.value.length > 0) {
                    title = wmName.value.toString("utf8").replace(/\0+$/g, "").trim();
                }
            }
            let app;
            const wmClass = await this.getProperty(winId, 67); // XA_WM_CLASS
            if (wmClass.format === 8 && wmClass.value.length > 0) {
                const parts = wmClass.value
                    .toString("utf8")
                    .split("\0")
                    .map((s) => s.trim())
                    .filter(Boolean);
                app = parts[1] ?? parts[0];
            }
            if (!title && !app)
                return null;
            let pid;
            const pidProp = await this.getProperty(winId, netWmPidAtom);
            if (pidProp.format === 32 && pidProp.value.length >= 4) {
                const p = pidProp.value.readUInt32LE(0);
                if (p > 0)
                    pid = p;
            }
            let bounds;
            try {
                const geomReq = Buffer.alloc(8);
                geomReq[0] = 14; // GetGeometry
                geomReq.writeUInt16LE(2, 2);
                geomReq.writeUInt32LE(winId >>> 0, 4);
                const geomRep = await this.sendRequestWithReply(geomReq);
                let wx = geomRep.readInt16LE(12);
                let wy = geomRep.readInt16LE(14);
                const ww = geomRep.readUInt16LE(16);
                const wh = geomRep.readUInt16LE(18);
                try {
                    const transReq = Buffer.alloc(16);
                    transReq[0] = 40; // TranslateCoordinates
                    transReq.writeUInt16LE(4, 2);
                    transReq.writeUInt32LE(winId >>> 0, 4);
                    transReq.writeUInt32LE(root >>> 0, 8);
                    const transRep = await this.sendRequestWithReply(transReq);
                    wx = transRep.readInt16LE(12);
                    wy = transRep.readInt16LE(14);
                }
                catch {
                    // keep GetGeometry coords
                }
                if (ww > 0 && wh > 0) {
                    bounds = { x: wx, y: wy, width: ww, height: wh };
                }
            }
            catch {
                // ignore geometry errors on transient windows
            }
            return {
                id: winId,
                title: title || app || `Window ${winId}`,
                app,
                pid,
                bounds,
                focused: winId === activeId,
            };
        }
        catch {
            return null;
        }
    }
    async listWindows() {
        const screen = await this.ensureReady();
        const activeId = await this.getActiveWindowId(screen.root);
        const netClientList = await this.internAtom("_NET_CLIENT_LIST");
        const netWmName = await this.internAtom("_NET_WM_NAME");
        const netWmPid = await this.internAtom("_NET_WM_PID");
        const windowIds = [];
        try {
            const listProp = await this.getProperty(screen.root, netClientList);
            if (listProp.format === 32 && listProp.value.length >= 4) {
                for (let off = 0; off + 4 <= listProp.value.length; off += 4) {
                    const id = listProp.value.readUInt32LE(off);
                    if (id > 0)
                        windowIds.push(id);
                }
            }
        }
        catch {
            // ignore
        }
        if (windowIds.length === 0) {
            // Fallback for window-manager-less X servers (e.g. bare Xvfb): QueryTree on root
            try {
                const treeReq = Buffer.alloc(8);
                treeReq[0] = 15; // QueryTree
                treeReq.writeUInt16LE(2, 2);
                treeReq.writeUInt32LE(screen.root, 4);
                const treeRep = await this.sendRequestWithReply(treeReq);
                const numChildren = treeRep.readUInt16LE(16);
                for (let i = 0; i < numChildren && 32 + (i + 1) * 4 <= treeRep.length; i++) {
                    const cid = treeRep.readUInt32LE(32 + i * 4);
                    if (cid > 0)
                        windowIds.push(cid);
                }
            }
            catch {
                // ignore
            }
        }
        if (activeId > 0 && !windowIds.includes(activeId)) {
            windowIds.unshift(activeId);
        }
        const windows = [];
        for (const id of windowIds) {
            const info = await this.inspectX11Window(id, screen.root, activeId, netWmName, netWmPid);
            if (info)
                windows.push(info);
        }
        return windows;
    }
    async getActiveWindow() {
        const screen = await this.ensureReady();
        const activeId = await this.getActiveWindowId(screen.root);
        if (!activeId)
            return null;
        const netWmName = await this.internAtom("_NET_WM_NAME");
        const netWmPid = await this.internAtom("_NET_WM_PID");
        return this.inspectX11Window(activeId, screen.root, activeId, netWmName, netWmPid);
    }
    async focusWindow(query) {
        const screen = await this.ensureReady();
        const windows = await this.listWindows();
        const titleNeedle = query.title?.toLowerCase();
        const appNeedle = query.app?.toLowerCase();
        const target = windows.find((w) => {
            if (query.id !== undefined && String(w.id) === String(query.id))
                return true;
            if (titleNeedle && w.title.toLowerCase().includes(titleNeedle))
                return true;
            if (appNeedle && (w.app ?? "").toLowerCase().includes(appNeedle))
                return true;
            return false;
        });
        if (!target)
            return false;
        const winId = typeof target.id === "number" ? target.id : Number(target.id);
        if (!Number.isFinite(winId) || winId <= 0)
            return false;
        // 1. Send EWMH _NET_ACTIVE_WINDOW ClientMessage to root window
        const netActive = await this.internAtom("_NET_ACTIVE_WINDOW");
        const sendEv = Buffer.alloc(44);
        sendEv[0] = 25; // SendEvent
        sendEv[1] = 0; // propagate = false
        sendEv.writeUInt16LE(11, 2); // 44 / 4 = 11 words
        sendEv.writeUInt32LE(screen.root, 4);
        sendEv.writeUInt32LE(0x00180000, 8); // SubstructureRedirectMask | SubstructureNotifyMask
        sendEv[12] = 33; // ClientMessage
        sendEv[13] = 32; // format = 32
        sendEv.writeUInt32LE(winId >>> 0, 16);
        sendEv.writeUInt32LE(netActive >>> 0, 20);
        sendEv.writeUInt32LE(2, 24); // source = 2 (pager / user-automated)
        sendEv.writeUInt32LE(0, 28); // CurrentTime
        sendEv.writeUInt32LE(0, 32);
        this.sendOneWay(sendEv);
        // 2. Also raise & focus directly for bare X servers without an EWMH window manager
        const raiseReq = Buffer.alloc(16);
        raiseReq[0] = 12; // ConfigureWindow
        raiseReq.writeUInt16LE(4, 2);
        raiseReq.writeUInt32LE(winId >>> 0, 4);
        raiseReq.writeUInt16LE(0x0040, 8); // StackMode
        raiseReq.writeUInt32LE(0, 12); // Above = 0
        this.sendOneWay(raiseReq);
        const focusReq = Buffer.alloc(12);
        focusReq[0] = 42; // SetInputFocus
        focusReq[1] = 2; // RevertToParent
        focusReq.writeUInt16LE(3, 2);
        focusReq.writeUInt32LE(winId >>> 0, 4);
        focusReq.writeUInt32LE(0, 8); // CurrentTime
        this.sendOneWay(focusReq);
        await this.sync();
        return true;
    }
    async getClipboardText() {
        return readLinuxClipboard();
    }
    async setClipboardText(text) {
        await writeLinuxClipboard(text);
    }
    async getMousePosition() {
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
    async moveMouse(x, y) {
        const screen = await this.ensureReady();
        const cx = Math.max(0, Math.min(screen.width - 1, Math.round(x)));
        const cy = Math.max(0, Math.min(screen.height - 1, Math.round(y)));
        if (this.xtestOpcode !== null) {
            this.sendXTestEvent(6, 0, cx, cy); // MotionNotify (6), absolute (0)
        }
        else {
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
    buttonCode(button) {
        switch (button) {
            case "left":
                return 1;
            case "middle":
                return 2;
            case "right":
                return 3;
        }
    }
    async mouseDown(button) {
        await this.ensureReady();
        this.sendXTestEvent(4, this.buttonCode(button)); // ButtonPress (4)
        await this.sync();
    }
    async mouseUp(button) {
        await this.ensureReady();
        this.sendXTestEvent(5, this.buttonCode(button)); // ButtonRelease (5)
        await this.sync();
    }
    async scroll(deltaX, deltaY) {
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
    async keyDown(key) {
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
    async keyUp(key) {
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
    async keyTap(key, modifiers = []) {
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
            this.sendXTestEvent(3, this.modifierKeycodes[activeMods[i]]);
        }
        await this.sync();
    }
    async typeText(text) {
        await this.ensureReady();
        for (const ch of Array.from(text)) {
            if (ch === "\r")
                continue;
            if (ch === "\n") {
                await this.keyTap("enter");
                continue;
            }
            if (ch === "\t") {
                await this.keyTap("tab");
                continue;
            }
            const cp = ch.codePointAt(0);
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
    async captureScreen(options = {}) {
        const screen = await this.ensureReady();
        const displays = await this.getDisplays();
        const disp = displays.find((d) => d.id === (options.display ?? 0)) ?? displays[0];
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
            let reply;
            try {
                reply = await this.sendRequestWithReply(req);
            }
            catch (err) {
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
                }
                else if (bytesPerPixel === 3) {
                    for (let col = 0; col < rw; col++) {
                        const s = srcRowStart + col * 3;
                        const pixel = msb
                            ? (data[s] << 16) | (data[s + 1] << 8) | data[s + 2]
                            : data[s] | (data[s + 1] << 8) | (data[s + 2] << 16);
                        const d = dstRowStart + col * 4;
                        rgba[d] = ((pixel & screen.redMask) >>> rShift) & 0xff;
                        rgba[d + 1] = ((pixel & screen.greenMask) >>> gShift) & 0xff;
                        rgba[d + 2] = ((pixel & screen.blueMask) >>> bShift) & 0xff;
                        rgba[d + 3] = 255;
                    }
                }
                else {
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
    async doctor() {
        const checks = [];
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
                detail: this.xtestOpcode !== null
                    ? `Available (opcode ${this.xtestOpcode})`
                    : "Missing XTEST extension on X server",
            });
        }
        catch (err) {
            checks.push({
                name: "X11 Socket Connection",
                ok: false,
                detail: err instanceof Error ? err.message : String(err),
            });
        }
        return checks;
    }
}
