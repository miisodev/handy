import { z } from "zod";
export interface Point {
    x: number;
    y: number;
}
export interface Region {
    x: number;
    y: number;
    width: number;
    height: number;
}
export interface DisplayInfo {
    id: number;
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
    scaleFactor: number;
    primary: boolean;
}
export interface WindowInfo {
    id: string | number;
    title: string;
    app?: string;
    pid?: number;
    bounds?: Region;
    focused: boolean;
}
export interface FrameDiff {
    changedPercent: number;
    changedPixels: number;
    changedBounds: Region | null;
}
export interface TrailMarker {
    stepNumber: number;
    kind: "click" | "drag_start" | "drag_end";
    x: number;
    y: number;
}
export interface RawFrame {
    width: number;
    height: number;
    /** Row-major RGBA buffer of length width * height * 4 */
    data: Uint8Array;
    /** Origin of this captured frame in global logical/screen coordinates */
    originX: number;
    originY: number;
    /** Logical coordinate width/height represented by this frame (equals width/height when 1:1) */
    logicalWidth: number;
    logicalHeight: number;
    scaleFactor: number;
    displayId: number;
}
export type MouseButton = "left" | "right" | "middle";
export type ModifierKey = "ctrl" | "alt" | "shift" | "meta" | "mod";
export type CoordinateSpace = "screen" | "normalized";
export declare const MouseButtonSchema: z.ZodEnum<{
    left: "left";
    right: "right";
    middle: "middle";
}>;
export declare const ModifierKeySchema: z.ZodEnum<{
    ctrl: "ctrl";
    alt: "alt";
    shift: "shift";
    meta: "meta";
    mod: "mod";
}>;
export declare const CoordinateSpaceSchema: z.ZodEnum<{
    screen: "screen";
    normalized: "normalized";
}>;
export declare const RegionSchema: z.ZodObject<{
    x: z.ZodNumber;
    y: z.ZodNumber;
    width: z.ZodNumber;
    height: z.ZodNumber;
}, z.core.$strip>;
export declare const MoveStepSchema: z.ZodObject<{
    type: z.ZodLiteral<"move">;
    x: z.ZodNumber;
    y: z.ZodNumber;
    relative: z.ZodOptional<z.ZodBoolean>;
    durationMs: z.ZodOptional<z.ZodNumber>;
    steps: z.ZodOptional<z.ZodNumber>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        screen: "screen";
        normalized: "normalized";
    }>>;
}, z.core.$strip>;
export declare const ClickStepSchema: z.ZodObject<{
    type: z.ZodLiteral<"click">;
    x: z.ZodOptional<z.ZodNumber>;
    y: z.ZodOptional<z.ZodNumber>;
    button: z.ZodOptional<z.ZodEnum<{
        left: "left";
        right: "right";
        middle: "middle";
    }>>;
    count: z.ZodOptional<z.ZodNumber>;
    modifiers: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        ctrl: "ctrl";
        alt: "alt";
        shift: "shift";
        meta: "meta";
        mod: "mod";
    }>>>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        screen: "screen";
        normalized: "normalized";
    }>>;
}, z.core.$strip>;
export declare const DoubleClickStepSchema: z.ZodObject<{
    type: z.ZodLiteral<"double_click">;
    x: z.ZodOptional<z.ZodNumber>;
    y: z.ZodOptional<z.ZodNumber>;
    button: z.ZodOptional<z.ZodEnum<{
        left: "left";
        right: "right";
        middle: "middle";
    }>>;
    modifiers: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        ctrl: "ctrl";
        alt: "alt";
        shift: "shift";
        meta: "meta";
        mod: "mod";
    }>>>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        screen: "screen";
        normalized: "normalized";
    }>>;
}, z.core.$strip>;
export declare const TripleClickStepSchema: z.ZodObject<{
    type: z.ZodLiteral<"triple_click">;
    x: z.ZodOptional<z.ZodNumber>;
    y: z.ZodOptional<z.ZodNumber>;
    modifiers: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        ctrl: "ctrl";
        alt: "alt";
        shift: "shift";
        meta: "meta";
        mod: "mod";
    }>>>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        screen: "screen";
        normalized: "normalized";
    }>>;
}, z.core.$strip>;
export declare const RightClickStepSchema: z.ZodObject<{
    type: z.ZodLiteral<"right_click">;
    x: z.ZodOptional<z.ZodNumber>;
    y: z.ZodOptional<z.ZodNumber>;
    modifiers: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        ctrl: "ctrl";
        alt: "alt";
        shift: "shift";
        meta: "meta";
        mod: "mod";
    }>>>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        screen: "screen";
        normalized: "normalized";
    }>>;
}, z.core.$strip>;
export declare const MouseDownStepSchema: z.ZodObject<{
    type: z.ZodLiteral<"mouse_down">;
    x: z.ZodOptional<z.ZodNumber>;
    y: z.ZodOptional<z.ZodNumber>;
    button: z.ZodOptional<z.ZodEnum<{
        left: "left";
        right: "right";
        middle: "middle";
    }>>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        screen: "screen";
        normalized: "normalized";
    }>>;
}, z.core.$strip>;
export declare const MouseUpStepSchema: z.ZodObject<{
    type: z.ZodLiteral<"mouse_up">;
    x: z.ZodOptional<z.ZodNumber>;
    y: z.ZodOptional<z.ZodNumber>;
    button: z.ZodOptional<z.ZodEnum<{
        left: "left";
        right: "right";
        middle: "middle";
    }>>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        screen: "screen";
        normalized: "normalized";
    }>>;
}, z.core.$strip>;
export declare const DragStepSchema: z.ZodObject<{
    type: z.ZodLiteral<"drag">;
    fromX: z.ZodOptional<z.ZodNumber>;
    fromY: z.ZodOptional<z.ZodNumber>;
    toX: z.ZodNumber;
    toY: z.ZodNumber;
    button: z.ZodOptional<z.ZodEnum<{
        left: "left";
        right: "right";
        middle: "middle";
    }>>;
    durationMs: z.ZodOptional<z.ZodNumber>;
    steps: z.ZodOptional<z.ZodNumber>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        screen: "screen";
        normalized: "normalized";
    }>>;
}, z.core.$strip>;
export declare const ScrollStepSchema: z.ZodObject<{
    type: z.ZodLiteral<"scroll">;
    x: z.ZodOptional<z.ZodNumber>;
    y: z.ZodOptional<z.ZodNumber>;
    deltaX: z.ZodOptional<z.ZodNumber>;
    deltaY: z.ZodOptional<z.ZodNumber>;
    direction: z.ZodOptional<z.ZodEnum<{
        left: "left";
        right: "right";
        up: "up";
        down: "down";
    }>>;
    amount: z.ZodOptional<z.ZodNumber>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        screen: "screen";
        normalized: "normalized";
    }>>;
}, z.core.$strip>;
export declare const TypeStepSchema: z.ZodObject<{
    type: z.ZodLiteral<"type">;
    text: z.ZodString;
    delayMs: z.ZodOptional<z.ZodNumber>;
    submit: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export declare const PasteStepSchema: z.ZodObject<{
    type: z.ZodLiteral<"paste">;
    text: z.ZodString;
    restoreClipboard: z.ZodOptional<z.ZodBoolean>;
    submit: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export declare const KeyStepSchema: z.ZodObject<{
    type: z.ZodLiteral<"key">;
    key: z.ZodString;
    modifiers: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        ctrl: "ctrl";
        alt: "alt";
        shift: "shift";
        meta: "meta";
        mod: "mod";
    }>>>;
    count: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const KeyDownStepSchema: z.ZodObject<{
    type: z.ZodLiteral<"key_down">;
    key: z.ZodString;
}, z.core.$strip>;
export declare const KeyUpStepSchema: z.ZodObject<{
    type: z.ZodLiteral<"key_up">;
    key: z.ZodString;
}, z.core.$strip>;
export declare const FocusWindowStepSchema: z.ZodObject<{
    type: z.ZodLiteral<"focus_window">;
    title: z.ZodOptional<z.ZodString>;
    app: z.ZodOptional<z.ZodString>;
    id: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
}, z.core.$strip>;
export declare const WaitStepSchema: z.ZodObject<{
    type: z.ZodLiteral<"wait">;
    ms: z.ZodNumber;
}, z.core.$strip>;
export declare const WaitForChangeStepSchema: z.ZodObject<{
    type: z.ZodLiteral<"wait_for_change">;
    region: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
        width: z.ZodNumber;
        height: z.ZodNumber;
    }, z.core.$strip>>;
    timeoutMs: z.ZodOptional<z.ZodNumber>;
    pollMs: z.ZodOptional<z.ZodNumber>;
    threshold: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const WaitForSettledStepSchema: z.ZodObject<{
    type: z.ZodLiteral<"wait_for_settled">;
    region: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
        width: z.ZodNumber;
        height: z.ZodNumber;
    }, z.core.$strip>>;
    timeoutMs: z.ZodOptional<z.ZodNumber>;
    quietMs: z.ZodOptional<z.ZodNumber>;
    pollMs: z.ZodOptional<z.ZodNumber>;
    threshold: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const ScreenshotStepSchema: z.ZodObject<{
    type: z.ZodLiteral<"screenshot">;
    region: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
        width: z.ZodNumber;
        height: z.ZodNumber;
    }, z.core.$strip>>;
    grid: z.ZodOptional<z.ZodBoolean>;
    showMouse: z.ZodOptional<z.ZodBoolean>;
    maxWidth: z.ZodOptional<z.ZodNumber>;
    label: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const ActionStepSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"move">;
    x: z.ZodNumber;
    y: z.ZodNumber;
    relative: z.ZodOptional<z.ZodBoolean>;
    durationMs: z.ZodOptional<z.ZodNumber>;
    steps: z.ZodOptional<z.ZodNumber>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        screen: "screen";
        normalized: "normalized";
    }>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"click">;
    x: z.ZodOptional<z.ZodNumber>;
    y: z.ZodOptional<z.ZodNumber>;
    button: z.ZodOptional<z.ZodEnum<{
        left: "left";
        right: "right";
        middle: "middle";
    }>>;
    count: z.ZodOptional<z.ZodNumber>;
    modifiers: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        ctrl: "ctrl";
        alt: "alt";
        shift: "shift";
        meta: "meta";
        mod: "mod";
    }>>>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        screen: "screen";
        normalized: "normalized";
    }>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"double_click">;
    x: z.ZodOptional<z.ZodNumber>;
    y: z.ZodOptional<z.ZodNumber>;
    button: z.ZodOptional<z.ZodEnum<{
        left: "left";
        right: "right";
        middle: "middle";
    }>>;
    modifiers: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        ctrl: "ctrl";
        alt: "alt";
        shift: "shift";
        meta: "meta";
        mod: "mod";
    }>>>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        screen: "screen";
        normalized: "normalized";
    }>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"triple_click">;
    x: z.ZodOptional<z.ZodNumber>;
    y: z.ZodOptional<z.ZodNumber>;
    modifiers: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        ctrl: "ctrl";
        alt: "alt";
        shift: "shift";
        meta: "meta";
        mod: "mod";
    }>>>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        screen: "screen";
        normalized: "normalized";
    }>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"right_click">;
    x: z.ZodOptional<z.ZodNumber>;
    y: z.ZodOptional<z.ZodNumber>;
    modifiers: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        ctrl: "ctrl";
        alt: "alt";
        shift: "shift";
        meta: "meta";
        mod: "mod";
    }>>>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        screen: "screen";
        normalized: "normalized";
    }>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"mouse_down">;
    x: z.ZodOptional<z.ZodNumber>;
    y: z.ZodOptional<z.ZodNumber>;
    button: z.ZodOptional<z.ZodEnum<{
        left: "left";
        right: "right";
        middle: "middle";
    }>>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        screen: "screen";
        normalized: "normalized";
    }>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"mouse_up">;
    x: z.ZodOptional<z.ZodNumber>;
    y: z.ZodOptional<z.ZodNumber>;
    button: z.ZodOptional<z.ZodEnum<{
        left: "left";
        right: "right";
        middle: "middle";
    }>>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        screen: "screen";
        normalized: "normalized";
    }>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"drag">;
    fromX: z.ZodOptional<z.ZodNumber>;
    fromY: z.ZodOptional<z.ZodNumber>;
    toX: z.ZodNumber;
    toY: z.ZodNumber;
    button: z.ZodOptional<z.ZodEnum<{
        left: "left";
        right: "right";
        middle: "middle";
    }>>;
    durationMs: z.ZodOptional<z.ZodNumber>;
    steps: z.ZodOptional<z.ZodNumber>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        screen: "screen";
        normalized: "normalized";
    }>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"scroll">;
    x: z.ZodOptional<z.ZodNumber>;
    y: z.ZodOptional<z.ZodNumber>;
    deltaX: z.ZodOptional<z.ZodNumber>;
    deltaY: z.ZodOptional<z.ZodNumber>;
    direction: z.ZodOptional<z.ZodEnum<{
        left: "left";
        right: "right";
        up: "up";
        down: "down";
    }>>;
    amount: z.ZodOptional<z.ZodNumber>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        screen: "screen";
        normalized: "normalized";
    }>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"type">;
    text: z.ZodString;
    delayMs: z.ZodOptional<z.ZodNumber>;
    submit: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"paste">;
    text: z.ZodString;
    restoreClipboard: z.ZodOptional<z.ZodBoolean>;
    submit: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"key">;
    key: z.ZodString;
    modifiers: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        ctrl: "ctrl";
        alt: "alt";
        shift: "shift";
        meta: "meta";
        mod: "mod";
    }>>>;
    count: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"key_down">;
    key: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"key_up">;
    key: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"focus_window">;
    title: z.ZodOptional<z.ZodString>;
    app: z.ZodOptional<z.ZodString>;
    id: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"wait">;
    ms: z.ZodNumber;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"wait_for_change">;
    region: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
        width: z.ZodNumber;
        height: z.ZodNumber;
    }, z.core.$strip>>;
    timeoutMs: z.ZodOptional<z.ZodNumber>;
    pollMs: z.ZodOptional<z.ZodNumber>;
    threshold: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"wait_for_settled">;
    region: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
        width: z.ZodNumber;
        height: z.ZodNumber;
    }, z.core.$strip>>;
    timeoutMs: z.ZodOptional<z.ZodNumber>;
    quietMs: z.ZodOptional<z.ZodNumber>;
    pollMs: z.ZodOptional<z.ZodNumber>;
    threshold: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"screenshot">;
    region: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
        width: z.ZodNumber;
        height: z.ZodNumber;
    }, z.core.$strip>>;
    grid: z.ZodOptional<z.ZodBoolean>;
    showMouse: z.ZodOptional<z.ZodBoolean>;
    maxWidth: z.ZodOptional<z.ZodNumber>;
    label: z.ZodOptional<z.ZodString>;
}, z.core.$strip>], "type">;
export type ActionStep = z.infer<typeof ActionStepSchema>;
export interface SeeOptions {
    display?: number;
    region?: Region;
    grid?: boolean;
    gridStep?: number;
    showMouse?: boolean;
    maxWidth?: number;
    trail?: TrailMarker[];
}
export interface SeeResult {
    pngBuffer: Buffer;
    base64Png: string;
    imageWidth: number;
    imageHeight: number;
    screen: {
        displayId: number;
        originX: number;
        originY: number;
        width: number;
        height: number;
        scaleFactor: number;
    };
    region: Region;
    mouse: Point;
    pixelUnderMouse: string | null;
    activeWindow: WindowInfo | null;
    screenDiff: FrameDiff | null;
    gridStep: number | null;
    coordinateSpace: "screen";
    captureMs: number;
    timestamp: string;
    label?: string;
}
export interface ActOptions {
    actions: ActionStep[];
    stepDelayMs?: number;
    screenshotAfter?: boolean;
    showTrail?: boolean;
    settleMs?: number;
    display?: number;
    maxWidth?: number;
    grid?: boolean;
    showMouse?: boolean;
    failsafe?: boolean;
    signal?: AbortSignal;
}
export interface StepReceipt {
    index: number;
    type: ActionStep["type"];
    durationMs: number;
    mouse?: Point;
    detail?: string;
}
export interface ActResult {
    ok: true;
    stepsCompleted: number;
    totalDurationMs: number;
    mouse: Point;
    activeWindow?: WindowInfo | null;
    receipts: StepReceipt[];
    screenshots: SeeResult[];
}
export type PermissionMode = "full" | "view_only";
export interface PermissionState {
    enabled: boolean;
    mode: PermissionMode;
    expiresAt: string | null;
    updatedAt: string;
    updatedBy: "default" | "cli" | "env" | "mcp" | "ui" | "expired";
}
export interface DoctorCheck {
    name: string;
    ok: boolean;
    detail: string;
}
export interface DesktopBackend {
    readonly name: string;
    readonly platform: NodeJS.Platform | "virtual";
    init(): Promise<void>;
    close(): Promise<void>;
    getDisplays(): Promise<DisplayInfo[]>;
    getMousePosition(): Promise<Point>;
    moveMouse(x: number, y: number): Promise<void>;
    mouseDown(button: MouseButton): Promise<void>;
    mouseUp(button: MouseButton): Promise<void>;
    scroll(deltaX: number, deltaY: number): Promise<void>;
    keyDown(key: string): Promise<void>;
    keyUp(key: string): Promise<void>;
    keyTap(key: string, modifiers?: Exclude<ModifierKey, "mod">[]): Promise<void>;
    typeText(text: string): Promise<void>;
    captureScreen(options?: {
        display?: number;
        region?: Region;
    }): Promise<RawFrame>;
    getActiveWindow?(): Promise<WindowInfo | null>;
    listWindows?(): Promise<WindowInfo[]>;
    focusWindow?(query: {
        title?: string;
        app?: string;
        id?: string | number;
    }): Promise<boolean>;
    getClipboardText?(): Promise<string>;
    setClipboardText?(text: string): Promise<void>;
    doctor(): Promise<DoctorCheck[]>;
}
