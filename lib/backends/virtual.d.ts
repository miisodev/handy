import { type ConcreteModifier } from "../keys.js";
import type { DesktopBackend, DisplayInfo, DoctorCheck, MouseButton, Point, RawFrame, Region, WindowInfo } from "../types.js";
export interface VirtualWidgetState {
    activeWindowId: "workbench" | "scratchpad";
    focusedField: "name" | "notes" | "scratchpad" | null;
    fields: {
        name: string;
        notes: string;
        scratchpad: string;
    };
    clipboard: string;
    selectedAll: boolean;
    submittedValue: string;
    counter: number;
    lastButton: MouseButton | null;
    lastClickCount: number;
    scrollOffset: number;
    cardPosition: Point;
    draggingCard: boolean;
    dragOffset: Point;
    events: string[];
}
export declare class VirtualDesktopBackend implements DesktopBackend {
    readonly name = "virtual";
    readonly platform: "virtual";
    private readonly width;
    private readonly height;
    private mouse;
    private heldButtons;
    private heldKeys;
    private lastClickTime;
    private lastClickPos;
    private clickStreak;
    readonly state: VirtualWidgetState;
    static readonly LAYOUT: {
        readonly workbenchWindow: {
            readonly x: 80;
            readonly y: 80;
            readonly width: 580;
            readonly height: 630;
        };
        readonly scratchpadWindow: {
            readonly x: 720;
            readonly y: 310;
            readonly width: 490;
            readonly height: 360;
        };
        readonly scratchpadInput: {
            readonly x: 745;
            readonly y: 365;
            readonly width: 440;
            readonly height: 280;
        };
        readonly nameInput: {
            readonly x: 120;
            readonly y: 150;
            readonly width: 360;
            readonly height: 44;
        };
        readonly notesInput: {
            readonly x: 120;
            readonly y: 230;
            readonly width: 360;
            readonly height: 44;
        };
        readonly submitButton: {
            readonly x: 120;
            readonly y: 305;
            readonly width: 150;
            readonly height: 42;
        };
        readonly counterButton: {
            readonly x: 295;
            readonly y: 305;
            readonly width: 185;
            readonly height: 42;
        };
        readonly clearButton: {
            readonly x: 500;
            readonly y: 305;
            readonly width: 120;
            readonly height: 42;
        };
        readonly scrollBox: {
            readonly x: 120;
            readonly y: 390;
            readonly width: 500;
            readonly height: 280;
        };
        readonly cardSize: {
            readonly width: 220;
            readonly height: 110;
        };
    };
    constructor(options?: {
        width?: number;
        height?: number;
    });
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
    private hitRect;
    private pushEvent;
    mouseDown(button: MouseButton): Promise<void>;
    mouseUp(button: MouseButton): Promise<void>;
    scroll(deltaX: number, deltaY: number): Promise<void>;
    keyDown(key: string): Promise<void>;
    keyUp(key: string): Promise<void>;
    keyTap(key: string, modifiers?: ConcreteModifier[]): Promise<void>;
    typeText(text: string): Promise<void>;
    private renderDesktop;
    captureScreen(options?: {
        display?: number;
        region?: Region;
    }): Promise<RawFrame>;
    doctor(): Promise<DoctorCheck[]>;
}
