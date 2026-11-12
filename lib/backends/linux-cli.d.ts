import { type ConcreteModifier } from "../keys.js";
import type { DesktopBackend, DisplayInfo, DoctorCheck, MouseButton, Point, RawFrame, Region, WindowInfo } from "../types.js";
export declare function readLinuxClipboard(): Promise<string>;
export declare function writeLinuxClipboard(text: string): Promise<void>;
export declare class LinuxCliBackend implements DesktopBackend {
    readonly name = "linux-cli";
    readonly platform: "linux";
    private screenshotTool;
    private inputTool;
    private wtypeAvailable;
    private wmctrlAvailable;
    private lastKnownMouse;
    private cachedScreenSize;
    init(): Promise<void>;
    close(): Promise<void>;
    getDisplays(): Promise<DisplayInfo[]>;
    listWindows(): Promise<WindowInfo[]>;
    getActiveWindow(): Promise<WindowInfo | null>;
    focusWindow(query: {
        title?: string;
        app?: string;
        id?: string | number;
    }): Promise<boolean>;
    getClipboardText(): Promise<string>;
    setClipboardText(text: string): Promise<void>;
    getMousePosition(): Promise<Point>;
    moveMouse(x: number, y: number): Promise<void>;
    private buttonNum;
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
