import { type ConcreteModifier } from "../keys.js";
import type { DesktopBackend, DisplayInfo, DoctorCheck, MouseButton, Point, RawFrame, Region } from "../types.js";
export interface X11DisplayTarget {
    socketPath?: string;
    host?: string;
    port?: number;
    displayNum: number;
    screenNum: number;
}
export declare function parseX11Display(displayEnv: string): X11DisplayTarget;
export declare class LinuxX11Backend implements DesktopBackend {
    readonly name = "linux-x11";
    readonly platform: "linux";
    private readonly displayStr;
    private socket;
    private rxBuf;
    private seq;
    private pending;
    private screenInfo;
    private minKeycode;
    private maxKeycode;
    private xtestOpcode;
    private randrOpcode;
    private keysymMap;
    private modifierKeycodes;
    private scratchKeycode;
    private initialized;
    constructor(options?: {
        display?: string;
    });
    init(): Promise<void>;
    private parseSetupBody;
    private drainIncoming;
    private nextSeq;
    private sendOneWay;
    private sendRequestWithReply;
    private sync;
    private queryExtension;
    private loadKeyboardMapping;
    private sendXTestEvent;
    private resolveKeycodeForKeysym;
    close(): Promise<void>;
    private ensureReady;
    getDisplays(): Promise<DisplayInfo[]>;
    getMousePosition(): Promise<Point>;
    moveMouse(x: number, y: number): Promise<void>;
    private buttonCode;
    mouseDown(button: MouseButton): Promise<void>;
    mouseUp(button: MouseButton): Promise<void>;
    scroll(deltaX: number, deltaY: number): Promise<void>;
    keyDown(key: string): Promise<void>;
    keyUp(key: string): Promise<void>;
    keyTap(key: string, modifiers?: ConcreteModifier[]): Promise<void>;
    typeText(text: string): Promise<void>;
    captureScreen(options?: {
        display?: number;
        region?: Region;
    }): Promise<RawFrame>;
    doctor(): Promise<DoctorCheck[]>;
}
