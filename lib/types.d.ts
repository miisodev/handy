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
    /**
     * Present (and `true`) only when the scan stopped early via `earlyExitPercent`. In that case
     * `changedPercent` / `changedPixels` are lower bounds and `changedBounds` may be incomplete.
     */
    partial?: boolean;
}
export interface FrameDiffOptions {
    /** Per-channel delta (0..255) above which a pixel counts as changed. Default: 14 */
    channelDeltaThreshold?: number;
    /** Compute the changed-pixel bounding box. Disable in hot wait loops that only need the percent. Default: true */
    computeBounds?: boolean;
    /** Stop scanning once this percentage of pixels has changed (values become lower bounds). */
    earlyExitPercent?: number;
}
export interface TrailMarker {
    stepNumber: number;
    kind: "click" | "drag_start" | "drag_end";
    x: number;
    y: number;
}
/** Coarse classification of a detected UI element, used to filter and to guide the agent. */
export type UiElementKind = "control" | "text" | "icon" | "region";
export declare const UiElementKindSchema: z.ZodEnum<{
    control: "control";
    icon: "icon";
    region: "region";
    text: "text";
}>;
/**
 * A Set-of-Mark candidate element detected on screen. All coordinates are in global logical screen
 * space, so `centerX`/`centerY` can be clicked directly (or via `mark: index` on an action step).
 */
export interface UiElement extends Region {
    /** 1-based mark number, matching the badge drawn on the annotated screenshot. */
    index: number;
    centerX: number;
    centerY: number;
    /** Confidence (0..1) that this is a genuine interactive element. */
    score: number;
    kind: UiElementKind;
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
export type CoordinateSpace = "screen" | "normalized" | "window";
export declare const MouseButtonSchema: z.ZodEnum<{
    left: "left";
    middle: "middle";
    right: "right";
}>;
export declare const ModifierKeySchema: z.ZodEnum<{
    alt: "alt";
    ctrl: "ctrl";
    meta: "meta";
    mod: "mod";
    shift: "shift";
}>;
export declare const CoordinateSpaceSchema: z.ZodEnum<{
    normalized: "normalized";
    screen: "screen";
    window: "window";
}>;
/**
 * Interpolation curve for pointer travel.
 * - `linear`: constant velocity.
 * - `ease`: quadratic ease-out (default) — fast start, gentle arrival.
 * - `human`: cubic Bezier with a perpendicular arc and Fitts's-law-scaled duration, which mimics
 *   real pointer ballistics so apps that filter synthetic straight-line motion behave normally.
 */
export type MotionProfile = "linear" | "ease" | "human";
export declare const MotionProfileSchema: z.ZodEnum<{
    ease: "ease";
    human: "human";
    linear: "linear";
}>;
export declare const RegionSchema: z.ZodObject<{
    x: z.ZodNumber;
    y: z.ZodNumber;
    width: z.ZodNumber;
    height: z.ZodNumber;
}, z.core.$strip>;
/**
 * Reference to a detected Set-of-Mark element. Lets an action step target a verified element box
 * (by the number drawn on the last marked screenshot) instead of estimating raw pixel coordinates.
 */
export declare const MarkRefSchema: z.ZodOptional<z.ZodNumber>;
export declare const MoveStepSchema: z.ZodObject<{
    type: z.ZodLiteral<"move">;
    x: z.ZodOptional<z.ZodNumber>;
    y: z.ZodOptional<z.ZodNumber>;
    mark: z.ZodOptional<z.ZodNumber>;
    relative: z.ZodOptional<z.ZodBoolean>;
    durationMs: z.ZodOptional<z.ZodNumber>;
    steps: z.ZodOptional<z.ZodNumber>;
    motion: z.ZodOptional<z.ZodEnum<{
        ease: "ease";
        human: "human";
        linear: "linear";
    }>>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        normalized: "normalized";
        screen: "screen";
        window: "window";
    }>>;
}, z.core.$strip>;
export declare const ClickStepSchema: z.ZodObject<{
    type: z.ZodLiteral<"click">;
    x: z.ZodOptional<z.ZodNumber>;
    y: z.ZodOptional<z.ZodNumber>;
    mark: z.ZodOptional<z.ZodNumber>;
    button: z.ZodOptional<z.ZodEnum<{
        left: "left";
        middle: "middle";
        right: "right";
    }>>;
    count: z.ZodOptional<z.ZodNumber>;
    modifiers: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        alt: "alt";
        ctrl: "ctrl";
        meta: "meta";
        mod: "mod";
        shift: "shift";
    }>>>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        normalized: "normalized";
        screen: "screen";
        window: "window";
    }>>;
}, z.core.$strip>;
export declare const DoubleClickStepSchema: z.ZodObject<{
    type: z.ZodLiteral<"double_click">;
    x: z.ZodOptional<z.ZodNumber>;
    y: z.ZodOptional<z.ZodNumber>;
    mark: z.ZodOptional<z.ZodNumber>;
    button: z.ZodOptional<z.ZodEnum<{
        left: "left";
        middle: "middle";
        right: "right";
    }>>;
    modifiers: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        alt: "alt";
        ctrl: "ctrl";
        meta: "meta";
        mod: "mod";
        shift: "shift";
    }>>>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        normalized: "normalized";
        screen: "screen";
        window: "window";
    }>>;
}, z.core.$strip>;
export declare const TripleClickStepSchema: z.ZodObject<{
    type: z.ZodLiteral<"triple_click">;
    x: z.ZodOptional<z.ZodNumber>;
    y: z.ZodOptional<z.ZodNumber>;
    mark: z.ZodOptional<z.ZodNumber>;
    modifiers: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        alt: "alt";
        ctrl: "ctrl";
        meta: "meta";
        mod: "mod";
        shift: "shift";
    }>>>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        normalized: "normalized";
        screen: "screen";
        window: "window";
    }>>;
}, z.core.$strip>;
export declare const RightClickStepSchema: z.ZodObject<{
    type: z.ZodLiteral<"right_click">;
    x: z.ZodOptional<z.ZodNumber>;
    y: z.ZodOptional<z.ZodNumber>;
    mark: z.ZodOptional<z.ZodNumber>;
    modifiers: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        alt: "alt";
        ctrl: "ctrl";
        meta: "meta";
        mod: "mod";
        shift: "shift";
    }>>>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        normalized: "normalized";
        screen: "screen";
        window: "window";
    }>>;
}, z.core.$strip>;
export declare const MouseDownStepSchema: z.ZodObject<{
    type: z.ZodLiteral<"mouse_down">;
    x: z.ZodOptional<z.ZodNumber>;
    y: z.ZodOptional<z.ZodNumber>;
    mark: z.ZodOptional<z.ZodNumber>;
    button: z.ZodOptional<z.ZodEnum<{
        left: "left";
        middle: "middle";
        right: "right";
    }>>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        normalized: "normalized";
        screen: "screen";
        window: "window";
    }>>;
}, z.core.$strip>;
export declare const MouseUpStepSchema: z.ZodObject<{
    type: z.ZodLiteral<"mouse_up">;
    x: z.ZodOptional<z.ZodNumber>;
    y: z.ZodOptional<z.ZodNumber>;
    mark: z.ZodOptional<z.ZodNumber>;
    button: z.ZodOptional<z.ZodEnum<{
        left: "left";
        middle: "middle";
        right: "right";
    }>>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        normalized: "normalized";
        screen: "screen";
        window: "window";
    }>>;
}, z.core.$strip>;
export declare const DragStepSchema: z.ZodObject<{
    type: z.ZodLiteral<"drag">;
    fromX: z.ZodOptional<z.ZodNumber>;
    fromY: z.ZodOptional<z.ZodNumber>;
    fromMark: z.ZodOptional<z.ZodNumber>;
    toX: z.ZodOptional<z.ZodNumber>;
    toY: z.ZodOptional<z.ZodNumber>;
    toMark: z.ZodOptional<z.ZodNumber>;
    button: z.ZodOptional<z.ZodEnum<{
        left: "left";
        middle: "middle";
        right: "right";
    }>>;
    durationMs: z.ZodOptional<z.ZodNumber>;
    steps: z.ZodOptional<z.ZodNumber>;
    motion: z.ZodOptional<z.ZodEnum<{
        ease: "ease";
        human: "human";
        linear: "linear";
    }>>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        normalized: "normalized";
        screen: "screen";
        window: "window";
    }>>;
}, z.core.$strip>;
export declare const ScrollStepSchema: z.ZodObject<{
    type: z.ZodLiteral<"scroll">;
    x: z.ZodOptional<z.ZodNumber>;
    y: z.ZodOptional<z.ZodNumber>;
    mark: z.ZodOptional<z.ZodNumber>;
    deltaX: z.ZodOptional<z.ZodNumber>;
    deltaY: z.ZodOptional<z.ZodNumber>;
    direction: z.ZodOptional<z.ZodEnum<{
        down: "down";
        left: "left";
        right: "right";
        up: "up";
    }>>;
    amount: z.ZodOptional<z.ZodNumber>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        normalized: "normalized";
        screen: "screen";
        window: "window";
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
        alt: "alt";
        ctrl: "ctrl";
        meta: "meta";
        mod: "mod";
        shift: "shift";
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
export declare const WaitForColorStepSchema: z.ZodObject<{
    type: z.ZodLiteral<"wait_for_color">;
    x: z.ZodNumber;
    y: z.ZodNumber;
    color: z.ZodString;
    tolerance: z.ZodOptional<z.ZodNumber>;
    timeoutMs: z.ZodOptional<z.ZodNumber>;
    pollMs: z.ZodOptional<z.ZodNumber>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        normalized: "normalized";
        screen: "screen";
        window: "window";
    }>>;
}, z.core.$strip>;
export declare const ScreenshotStepSchema: z.ZodObject<{
    type: z.ZodLiteral<"screenshot">;
    region: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
        width: z.ZodNumber;
        height: z.ZodNumber;
    }, z.core.$strip>>;
    window: z.ZodOptional<z.ZodString>;
    grid: z.ZodOptional<z.ZodBoolean>;
    showMouse: z.ZodOptional<z.ZodBoolean>;
    highlightDiff: z.ZodOptional<z.ZodBoolean>;
    maxWidth: z.ZodOptional<z.ZodNumber>;
    marks: z.ZodOptional<z.ZodBoolean>;
    maxMarks: z.ZodOptional<z.ZodNumber>;
    label: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const ActionStepSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"move">;
    x: z.ZodOptional<z.ZodNumber>;
    y: z.ZodOptional<z.ZodNumber>;
    mark: z.ZodOptional<z.ZodNumber>;
    relative: z.ZodOptional<z.ZodBoolean>;
    durationMs: z.ZodOptional<z.ZodNumber>;
    steps: z.ZodOptional<z.ZodNumber>;
    motion: z.ZodOptional<z.ZodEnum<{
        ease: "ease";
        human: "human";
        linear: "linear";
    }>>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        normalized: "normalized";
        screen: "screen";
        window: "window";
    }>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"click">;
    x: z.ZodOptional<z.ZodNumber>;
    y: z.ZodOptional<z.ZodNumber>;
    mark: z.ZodOptional<z.ZodNumber>;
    button: z.ZodOptional<z.ZodEnum<{
        left: "left";
        middle: "middle";
        right: "right";
    }>>;
    count: z.ZodOptional<z.ZodNumber>;
    modifiers: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        alt: "alt";
        ctrl: "ctrl";
        meta: "meta";
        mod: "mod";
        shift: "shift";
    }>>>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        normalized: "normalized";
        screen: "screen";
        window: "window";
    }>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"double_click">;
    x: z.ZodOptional<z.ZodNumber>;
    y: z.ZodOptional<z.ZodNumber>;
    mark: z.ZodOptional<z.ZodNumber>;
    button: z.ZodOptional<z.ZodEnum<{
        left: "left";
        middle: "middle";
        right: "right";
    }>>;
    modifiers: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        alt: "alt";
        ctrl: "ctrl";
        meta: "meta";
        mod: "mod";
        shift: "shift";
    }>>>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        normalized: "normalized";
        screen: "screen";
        window: "window";
    }>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"triple_click">;
    x: z.ZodOptional<z.ZodNumber>;
    y: z.ZodOptional<z.ZodNumber>;
    mark: z.ZodOptional<z.ZodNumber>;
    modifiers: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        alt: "alt";
        ctrl: "ctrl";
        meta: "meta";
        mod: "mod";
        shift: "shift";
    }>>>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        normalized: "normalized";
        screen: "screen";
        window: "window";
    }>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"right_click">;
    x: z.ZodOptional<z.ZodNumber>;
    y: z.ZodOptional<z.ZodNumber>;
    mark: z.ZodOptional<z.ZodNumber>;
    modifiers: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        alt: "alt";
        ctrl: "ctrl";
        meta: "meta";
        mod: "mod";
        shift: "shift";
    }>>>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        normalized: "normalized";
        screen: "screen";
        window: "window";
    }>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"mouse_down">;
    x: z.ZodOptional<z.ZodNumber>;
    y: z.ZodOptional<z.ZodNumber>;
    mark: z.ZodOptional<z.ZodNumber>;
    button: z.ZodOptional<z.ZodEnum<{
        left: "left";
        middle: "middle";
        right: "right";
    }>>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        normalized: "normalized";
        screen: "screen";
        window: "window";
    }>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"mouse_up">;
    x: z.ZodOptional<z.ZodNumber>;
    y: z.ZodOptional<z.ZodNumber>;
    mark: z.ZodOptional<z.ZodNumber>;
    button: z.ZodOptional<z.ZodEnum<{
        left: "left";
        middle: "middle";
        right: "right";
    }>>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        normalized: "normalized";
        screen: "screen";
        window: "window";
    }>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"drag">;
    fromX: z.ZodOptional<z.ZodNumber>;
    fromY: z.ZodOptional<z.ZodNumber>;
    fromMark: z.ZodOptional<z.ZodNumber>;
    toX: z.ZodOptional<z.ZodNumber>;
    toY: z.ZodOptional<z.ZodNumber>;
    toMark: z.ZodOptional<z.ZodNumber>;
    button: z.ZodOptional<z.ZodEnum<{
        left: "left";
        middle: "middle";
        right: "right";
    }>>;
    durationMs: z.ZodOptional<z.ZodNumber>;
    steps: z.ZodOptional<z.ZodNumber>;
    motion: z.ZodOptional<z.ZodEnum<{
        ease: "ease";
        human: "human";
        linear: "linear";
    }>>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        normalized: "normalized";
        screen: "screen";
        window: "window";
    }>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"scroll">;
    x: z.ZodOptional<z.ZodNumber>;
    y: z.ZodOptional<z.ZodNumber>;
    mark: z.ZodOptional<z.ZodNumber>;
    deltaX: z.ZodOptional<z.ZodNumber>;
    deltaY: z.ZodOptional<z.ZodNumber>;
    direction: z.ZodOptional<z.ZodEnum<{
        down: "down";
        left: "left";
        right: "right";
        up: "up";
    }>>;
    amount: z.ZodOptional<z.ZodNumber>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        normalized: "normalized";
        screen: "screen";
        window: "window";
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
        alt: "alt";
        ctrl: "ctrl";
        meta: "meta";
        mod: "mod";
        shift: "shift";
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
    type: z.ZodLiteral<"wait_for_color">;
    x: z.ZodNumber;
    y: z.ZodNumber;
    color: z.ZodString;
    tolerance: z.ZodOptional<z.ZodNumber>;
    timeoutMs: z.ZodOptional<z.ZodNumber>;
    pollMs: z.ZodOptional<z.ZodNumber>;
    coordinateSpace: z.ZodOptional<z.ZodEnum<{
        normalized: "normalized";
        screen: "screen";
        window: "window";
    }>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"screenshot">;
    region: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
        width: z.ZodNumber;
        height: z.ZodNumber;
    }, z.core.$strip>>;
    window: z.ZodOptional<z.ZodString>;
    grid: z.ZodOptional<z.ZodBoolean>;
    showMouse: z.ZodOptional<z.ZodBoolean>;
    highlightDiff: z.ZodOptional<z.ZodBoolean>;
    maxWidth: z.ZodOptional<z.ZodNumber>;
    marks: z.ZodOptional<z.ZodBoolean>;
    maxMarks: z.ZodOptional<z.ZodNumber>;
    label: z.ZodOptional<z.ZodString>;
}, z.core.$strip>], "type">;
export type ActionStep = z.infer<typeof ActionStepSchema>;
export interface SeeOptions {
    display?: number;
    region?: Region;
    window?: string | {
        title?: string;
        app?: string;
        id?: string | number;
    };
    grid?: boolean;
    gridStep?: number;
    showMouse?: boolean;
    highlightDiff?: boolean;
    maxWidth?: number;
    trail?: TrailMarker[];
    /** Run Set-of-Mark UI element detection and number the elements on the overlay. */
    marks?: boolean;
    /** Maximum number of marks to detect when `marks` is enabled. Default: 40 */
    maxMarks?: number;
    /** Restrict detected mark kinds. Default: all */
    markKinds?: UiElementKind[];
    /** Minimum detection confidence (0..1) for a mark to be kept. Default: 0.3 */
    minMarkScore?: number;
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
    /** Detected Set-of-Mark UI elements (present when `marks: true`), in global logical screen coords. */
    elements?: UiElement[];
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
    highlightDiff?: boolean;
    settleMs?: number;
    display?: number;
    maxWidth?: number;
    grid?: boolean;
    showMouse?: boolean;
    /** Run Set-of-Mark detection on post-chain and mid-chain screenshots. */
    marks?: boolean;
    maxMarks?: number;
    markKinds?: UiElementKind[];
    minMarkScore?: number;
    /**
     * Capture before and after the chain and report the visual difference, so the agent learns
     * whether its actions actually changed anything without spending a round-trip on an image.
     */
    verifyChange?: boolean;
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
    /** Present when `verifyChange` was requested: visual difference between pre- and post-chain. */
    change?: FrameDiff | null;
    /** True when `change` shows any meaningful visual difference. */
    changed?: boolean;
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
/**
 * Resolves the display an operation should target.
 *
 * Every bundled backend numbers displays from zero, but `id` is an opaque backend value rather
 * than a guaranteed index, so this falls back to positional lookup and then to the primary display
 * instead of silently operating on the wrong monitor (or on `undefined`).
 */
export declare function pickDisplay(displays: DisplayInfo[], index?: number): DisplayInfo | undefined;
export interface DesktopBackend {
    readonly name: string;
    readonly platform: NodeJS.Platform | "virtual";
    /**
     * True when the backend carries click count and held modifiers on the native event itself
     * (macOS CGEvent requires this for double/triple clicks to register). Lets the controller use
     * capability detection rather than an `instanceof` check against a concrete class.
     */
    readonly nativeClickCount?: boolean;
    init(): Promise<void>;
    close(): Promise<void>;
    getDisplays(): Promise<DisplayInfo[]>;
    getMousePosition(): Promise<Point>;
    moveMouse(x: number, y: number): Promise<void>;
    /**
     * Extra arguments are honoured only by backends that set `nativeClickCount`; all others may
     * ignore them, which keeps a plain `(button) => Promise<void>` implementation assignable.
     */
    mouseDown(button: MouseButton, clickCount?: number, modifiers?: Exclude<ModifierKey, "mod">[]): Promise<void>;
    mouseUp(button: MouseButton, clickCount?: number, modifiers?: Exclude<ModifierKey, "mod">[]): Promise<void>;
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
