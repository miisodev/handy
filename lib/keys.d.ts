import type { ModifierKey } from "./types.js";
export type ConcreteModifier = "ctrl" | "alt" | "shift" | "meta";
export type CanonicalKey = "enter" | "tab" | "space" | "backspace" | "delete" | "escape" | "up" | "down" | "left" | "right" | "home" | "end" | "pageup" | "pagedown" | "insert" | "capslock" | "f1" | "f2" | "f3" | "f4" | "f5" | "f6" | "f7" | "f8" | "f9" | "f10" | "f11" | "f12" | "ctrl" | "alt" | "shift" | "meta" | string;
export interface ParsedKeyChord {
    key: CanonicalKey;
    modifiers: ConcreteModifier[];
}
export declare function resolveModifier(mod: ModifierKey, platform?: NodeJS.Platform | "virtual"): ConcreteModifier;
export declare function normalizeSingleKey(raw: string, platform?: NodeJS.Platform | "virtual"): CanonicalKey;
/**
 * Parses a key or chord such as "Enter", "ctrl+c", "mod+shift+p", or "ctrl++" into
 * canonical modifiers + primary key.
 */
export declare function parseKeyChord(rawKey: string, extraModifiers?: ModifierKey[], platform?: NodeJS.Platform | "virtual"): ParsedKeyChord;
/** X11 keysyms (X11/keysymdef.h) */
export declare const X11_KEYSYMS: Record<string, number>;
export declare function toX11Keysym(key: CanonicalKey): number;
/** macOS Carbon/CoreGraphics virtual keycodes (Events.h) */
export declare const DARWIN_KEYCODES: Record<string, {
    code: number;
    shift?: boolean;
}>;
/** Windows Win32 Virtual-Key codes (WinUser.h) */
export declare const WIN32_VK_CODES: Record<string, {
    vk: number;
    shift?: boolean;
}>;
export declare function toWin32Vk(key: CanonicalKey): {
    vk: number;
    shift?: boolean;
} | null;
export declare function toXdotoolKey(key: CanonicalKey): string;
