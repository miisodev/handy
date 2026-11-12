const MODIFIER_ALIASES = {
    ctrl: "ctrl",
    control: "ctrl",
    ctl: "ctrl",
    alt: "alt",
    opt: "alt",
    option: "alt",
    shift: "shift",
    shft: "shift",
    meta: "meta",
    cmd: "meta",
    command: "meta",
    super: "meta",
    win: "meta",
    windows: "meta",
    gui: "meta",
    mod: "mod",
    cmdorctrl: "mod",
};
const KEY_ALIASES = {
    enter: "enter",
    return: "enter",
    kp_enter: "enter",
    "\n": "enter",
    "\r": "enter",
    tab: "tab",
    "\t": "tab",
    space: "space",
    spacebar: "space",
    " ": "space",
    backspace: "backspace",
    bksp: "backspace",
    bs: "backspace",
    delete: "delete",
    del: "delete",
    forwarddelete: "delete",
    esc: "escape",
    escape: "escape",
    up: "up",
    arrowup: "up",
    down: "down",
    arrowdown: "down",
    left: "left",
    arrowleft: "left",
    right: "right",
    arrowright: "right",
    home: "home",
    end: "end",
    pageup: "pageup",
    pgup: "pageup",
    prior: "pageup",
    pagedown: "pagedown",
    pgdn: "pagedown",
    next: "pagedown",
    insert: "insert",
    ins: "insert",
    capslock: "capslock",
    caps: "capslock",
    f1: "f1",
    f2: "f2",
    f3: "f3",
    f4: "f4",
    f5: "f5",
    f6: "f6",
    f7: "f7",
    f8: "f8",
    f9: "f9",
    f10: "f10",
    f11: "f11",
    f12: "f12",
    plus: "+",
    minus: "-",
    equal: "=",
    equals: "=",
    slash: "/",
    backslash: "\\",
    comma: ",",
    period: ".",
    dot: ".",
    semicolon: ";",
    apostrophe: "'",
    quote: "'",
    grave: "`",
    backtick: "`",
    bracketleft: "[",
    bracketright: "]",
};
export function resolveModifier(mod, platform = process.platform) {
    if (mod === "mod") {
        return platform === "darwin" ? "meta" : "ctrl";
    }
    return mod;
}
export function normalizeSingleKey(raw, platform = process.platform) {
    if (raw === " ")
        return "space";
    if (raw === "\n" || raw === "\r")
        return "enter";
    if (raw === "\t")
        return "tab";
    const trimmed = raw.trim();
    if (!trimmed) {
        throw new Error("Key cannot be empty.");
    }
    const lower = trimmed.toLowerCase();
    const modAlias = MODIFIER_ALIASES[lower];
    if (modAlias) {
        return resolveModifier(modAlias, platform);
    }
    const keyAlias = KEY_ALIASES[lower];
    if (keyAlias) {
        return keyAlias;
    }
    // Single character (ASCII or Unicode)
    const codePoints = Array.from(trimmed);
    if (codePoints.length === 1) {
        return trimmed.length === 1 && trimmed >= "A" && trimmed <= "Z" ? trimmed.toLowerCase() : trimmed;
    }
    throw new Error(`Unsupported key "${raw}". Use a named key (Enter, Tab, Escape, Backspace, Delete, Space, ArrowUp..ArrowRight, Home, End, PageUp, PageDown, F1..F12), modifier (ctrl, alt, shift, meta, mod), or chord like "ctrl+c" / "mod+a".`);
}
/**
 * Parses a key or chord such as "Enter", "ctrl+c", "mod+shift+p", or "ctrl++" into
 * canonical modifiers + primary key.
 */
export function parseKeyChord(rawKey, extraModifiers = [], platform = process.platform) {
    const modSet = new Set();
    for (const m of extraModifiers) {
        modSet.add(resolveModifier(m, platform));
    }
    // Handle single space/newline/plus directly without splitting
    if (rawKey === " " || rawKey === "+" || rawKey === "\n" || rawKey === "\t") {
        return {
            key: normalizeSingleKey(rawKey, platform),
            modifiers: Array.from(modSet),
        };
    }
    // Tokenize '+' carefully so "ctrl++" parses as modifier "ctrl" + key "+"
    const tokens = [];
    let rest = rawKey.trim();
    while (rest.length > 0) {
        const plusIdx = rest.indexOf("+");
        if (plusIdx === -1) {
            tokens.push(rest);
            break;
        }
        if (plusIdx === 0) {
            // Leading '+' means literal '+' key
            tokens.push("+");
            rest = rest.slice(1);
            if (rest.startsWith("+"))
                rest = rest.slice(1);
        }
        else {
            tokens.push(rest.slice(0, plusIdx));
            rest = rest.slice(plusIdx + 1);
            if (rest === "") {
                // Trailing '+' (e.g. "ctrl++") -> literal '+'
                tokens.push("+");
                break;
            }
        }
    }
    if (tokens.length === 0) {
        throw new Error(`Invalid key "${rawKey}".`);
    }
    for (let i = 0; i < tokens.length - 1; i++) {
        const tok = tokens[i].trim().toLowerCase();
        const mod = MODIFIER_ALIASES[tok];
        if (!mod) {
            throw new Error(`Unknown modifier "${tokens[i]}" in key chord "${rawKey}".`);
        }
        modSet.add(resolveModifier(mod, platform));
    }
    const lastRaw = tokens[tokens.length - 1];
    // Uppercase single ASCII letter without explicit chord turns into shift + lowercase only if specified as e.g. "A" alone?
    // Note: for key("A") vs key("ctrl+C"), users writing "ctrl+C" mean ctrl+c (not ctrl+shift+c!).
    const isSingleUpperAlpha = tokens.length === 1 && extraModifiers.length === 0 && /^[A-Z]$/.test(lastRaw);
    if (isSingleUpperAlpha) {
        modSet.add("shift");
    }
    const key = normalizeSingleKey(lastRaw, platform);
    // If key itself is a modifier (e.g. key("Shift")), remove it from wrapper modifiers
    if (key === "ctrl" || key === "alt" || key === "shift" || key === "meta") {
        modSet.delete(key);
    }
    return {
        key,
        modifiers: Array.from(modSet),
    };
}
/** X11 keysyms (X11/keysymdef.h) */
export const X11_KEYSYMS = {
    backspace: 0xff08,
    tab: 0xff09,
    enter: 0xff0d,
    escape: 0xff1b,
    delete: 0xffff,
    home: 0xff50,
    left: 0xff51,
    up: 0xff52,
    right: 0xff53,
    down: 0xff54,
    pageup: 0xff55,
    pagedown: 0xff56,
    end: 0xff57,
    insert: 0xff63,
    capslock: 0xffe5,
    f1: 0xffbe,
    f2: 0xffbf,
    f3: 0xffc0,
    f4: 0xffc1,
    f5: 0xffc2,
    f6: 0xffc3,
    f7: 0xffc4,
    f8: 0xffc5,
    f9: 0xffc6,
    f10: 0xffc7,
    f11: 0xffc8,
    f12: 0xffc9,
    shift: 0xffe1,
    ctrl: 0xffe3,
    meta: 0xffeb, // XK_Super_L
    alt: 0xffe9, // XK_Alt_L
    space: 0x0020,
};
export function toX11Keysym(key) {
    const named = X11_KEYSYMS[key];
    if (named !== undefined)
        return named;
    const cp = key.codePointAt(0);
    if (cp === undefined)
        throw new Error(`Cannot map empty key to X11 keysym`);
    // Latin-1 printable range maps 1:1 in X11 keysyms (0x0020..0x00ff)
    if (cp >= 0x20 && cp <= 0xff)
        return cp;
    // Standard X11 Unicode keysym encoding
    return 0x01000000 | cp;
}
/** macOS Carbon/CoreGraphics virtual keycodes (Events.h) */
export const DARWIN_KEYCODES = {
    a: { code: 0x00 },
    s: { code: 0x01 },
    d: { code: 0x02 },
    f: { code: 0x03 },
    h: { code: 0x04 },
    g: { code: 0x05 },
    z: { code: 0x06 },
    x: { code: 0x07 },
    c: { code: 0x08 },
    v: { code: 0x09 },
    b: { code: 0x0b },
    q: { code: 0x0c },
    w: { code: 0x0d },
    e: { code: 0x0e },
    r: { code: 0x0f },
    y: { code: 0x10 },
    t: { code: 0x11 },
    "1": { code: 0x12 },
    "!": { code: 0x12, shift: true },
    "2": { code: 0x13 },
    "@": { code: 0x13, shift: true },
    "3": { code: 0x14 },
    "#": { code: 0x14, shift: true },
    "4": { code: 0x15 },
    "$": { code: 0x15, shift: true },
    "6": { code: 0x16 },
    "^": { code: 0x16, shift: true },
    "5": { code: 0x17 },
    "%": { code: 0x17, shift: true },
    "=": { code: 0x18 },
    "+": { code: 0x18, shift: true },
    "9": { code: 0x19 },
    "(": { code: 0x19, shift: true },
    "7": { code: 0x1a },
    "&": { code: 0x1a, shift: true },
    "-": { code: 0x1b },
    "_": { code: 0x1b, shift: true },
    "8": { code: 0x1c },
    "*": { code: 0x1c, shift: true },
    "0": { code: 0x1d },
    ")": { code: 0x1d, shift: true },
    "]": { code: 0x1e },
    "}": { code: 0x1e, shift: true },
    o: { code: 0x1f },
    u: { code: 0x20 },
    "[": { code: 0x21 },
    "{": { code: 0x21, shift: true },
    i: { code: 0x22 },
    p: { code: 0x23 },
    enter: { code: 0x24 },
    l: { code: 0x25 },
    j: { code: 0x26 },
    "'": { code: 0x27 },
    '"': { code: 0x27, shift: true },
    k: { code: 0x28 },
    ";": { code: 0x29 },
    ":": { code: 0x29, shift: true },
    "\\": { code: 0x2a },
    "|": { code: 0x2a, shift: true },
    ",": { code: 0x2b },
    "<": { code: 0x2b, shift: true },
    "/": { code: 0x2c },
    "?": { code: 0x2c, shift: true },
    n: { code: 0x2d },
    m: { code: 0x2e },
    ".": { code: 0x2f },
    ">": { code: 0x2f, shift: true },
    tab: { code: 0x30 },
    space: { code: 0x31 },
    "`": { code: 0x32 },
    "~": { code: 0x32, shift: true },
    backspace: { code: 0x33 },
    escape: { code: 0x35 },
    meta: { code: 0x37 },
    shift: { code: 0x38 },
    capslock: { code: 0x39 },
    alt: { code: 0x3a },
    ctrl: { code: 0x3b },
    f5: { code: 0x60 },
    f6: { code: 0x61 },
    f7: { code: 0x62 },
    f3: { code: 0x63 },
    f8: { code: 0x64 },
    f9: { code: 0x65 },
    f11: { code: 0x67 },
    f10: { code: 0x6d },
    f12: { code: 0x6f },
    insert: { code: 0x72 },
    home: { code: 0x73 },
    pageup: { code: 0x74 },
    delete: { code: 0x75 },
    f4: { code: 0x76 },
    end: { code: 0x77 },
    f2: { code: 0x78 },
    pagedown: { code: 0x79 },
    f1: { code: 0x7a },
    left: { code: 0x7b },
    right: { code: 0x7c },
    down: { code: 0x7d },
    up: { code: 0x7e },
};
/** Windows Win32 Virtual-Key codes (WinUser.h) */
export const WIN32_VK_CODES = {
    backspace: { vk: 0x08 },
    tab: { vk: 0x09 },
    enter: { vk: 0x0d },
    shift: { vk: 0x10 },
    ctrl: { vk: 0x11 },
    alt: { vk: 0x12 },
    capslock: { vk: 0x14 },
    escape: { vk: 0x1b },
    space: { vk: 0x20 },
    pageup: { vk: 0x21 },
    pagedown: { vk: 0x22 },
    end: { vk: 0x23 },
    home: { vk: 0x24 },
    left: { vk: 0x25 },
    up: { vk: 0x26 },
    right: { vk: 0x27 },
    down: { vk: 0x28 },
    insert: { vk: 0x2d },
    delete: { vk: 0x2e },
    meta: { vk: 0x5b }, // VK_LWIN
    f1: { vk: 0x70 },
    f2: { vk: 0x71 },
    f3: { vk: 0x72 },
    f4: { vk: 0x73 },
    f5: { vk: 0x74 },
    f6: { vk: 0x75 },
    f7: { vk: 0x76 },
    f8: { vk: 0x77 },
    f9: { vk: 0x78 },
    f10: { vk: 0x79 },
    f11: { vk: 0x7a },
    f12: { vk: 0x7b },
    ";": { vk: 0xba },
    ":": { vk: 0xba, shift: true },
    "=": { vk: 0xbb },
    "+": { vk: 0xbb, shift: true },
    ",": { vk: 0xbc },
    "<": { vk: 0xbc, shift: true },
    "-": { vk: 0xbd },
    "_": { vk: 0xbd, shift: true },
    ".": { vk: 0xbe },
    ">": { vk: 0xbe, shift: true },
    "/": { vk: 0xbf },
    "?": { vk: 0xbf, shift: true },
    "`": { vk: 0xc0 },
    "~": { vk: 0xc0, shift: true },
    "[": { vk: 0xdb },
    "{": { vk: 0xdb, shift: true },
    "\\": { vk: 0xdc },
    "|": { vk: 0xdc, shift: true },
    "]": { vk: 0xdd },
    "}": { vk: 0xdd, shift: true },
    "'": { vk: 0xde },
    '"': { vk: 0xde, shift: true },
    "!": { vk: 0x31, shift: true },
    "@": { vk: 0x32, shift: true },
    "#": { vk: 0x33, shift: true },
    $: { vk: 0x34, shift: true },
    "%": { vk: 0x35, shift: true },
    "^": { vk: 0x36, shift: true },
    "&": { vk: 0x37, shift: true },
    "*": { vk: 0x38, shift: true },
    "(": { vk: 0x39, shift: true },
    ")": { vk: 0x30, shift: true },
};
export function toWin32Vk(key) {
    const mapped = WIN32_VK_CODES[key];
    if (mapped)
        return mapped;
    if (key.length === 1) {
        const ch = key.charCodeAt(0);
        if (ch >= 0x61 && ch <= 0x7a)
            return { vk: ch - 32 }; // 'a'..'z' -> 'A'..'Z' (0x41..0x5A)
        if (ch >= 0x30 && ch <= 0x39)
            return { vk: ch }; // '0'..'9'
    }
    return null;
}
export function toXdotoolKey(key) {
    const map = {
        enter: "Return",
        tab: "Tab",
        space: "space",
        backspace: "BackSpace",
        delete: "Delete",
        escape: "Escape",
        up: "Up",
        down: "Down",
        left: "Left",
        right: "Right",
        home: "Home",
        end: "End",
        pageup: "Prior",
        pagedown: "Next",
        insert: "Insert",
        capslock: "Caps_Lock",
        ctrl: "ctrl",
        alt: "alt",
        shift: "shift",
        meta: "super",
        f1: "F1",
        f2: "F2",
        f3: "F3",
        f4: "F4",
        f5: "F5",
        f6: "F6",
        f7: "F7",
        f8: "F8",
        f9: "F9",
        f10: "F10",
        f11: "F11",
        f12: "F12",
        "+": "plus",
        "-": "minus",
        "=": "equal",
        "/": "slash",
        "\\": "backslash",
        ",": "comma",
        ".": "period",
        ";": "semicolon",
        "'": "apostrophe",
        "`": "grave",
        "[": "bracketleft",
        "]": "bracketright",
    };
    return map[key] ?? key;
}
