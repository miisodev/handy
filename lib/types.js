import { z } from "zod";
export const UiElementKindSchema = z.enum(["control", "text", "icon", "region"]);
export const MouseButtonSchema = z.enum(["left", "right", "middle"]);
export const ModifierKeySchema = z.enum(["ctrl", "alt", "shift", "meta", "mod"]);
export const CoordinateSpaceSchema = z.enum(["screen", "normalized", "window"]);
export const MotionProfileSchema = z.enum(["linear", "ease", "human"]);
export const RegionSchema = z.object({
    x: z.number().int().describe("Left X coordinate in screen pixels"),
    y: z.number().int().describe("Top Y coordinate in screen pixels"),
    width: z.number().int().min(1).max(16384).describe("Region width in screen pixels"),
    height: z.number().int().min(1).max(16384).describe("Region height in screen pixels"),
});
/**
 * Reference to a detected Set-of-Mark element. Lets an action step target a verified element box
 * (by the number drawn on the last marked screenshot) instead of estimating raw pixel coordinates.
 */
export const MarkRefSchema = z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Target detected UI element mark #N — the number drawn on the screenshot returned by the last `handy_see({ marks: true })` — instead of supplying x/y");
export const MoveStepSchema = z.object({
    type: z.literal("move"),
    x: z.number().optional().describe("Target X coordinate (or delta X when relative=true). Omit when using `mark`."),
    y: z.number().optional().describe("Target Y coordinate (or delta Y when relative=true). Omit when using `mark`."),
    mark: MarkRefSchema,
    relative: z.boolean().optional().describe("Move relative to current mouse position"),
    durationMs: z.number().min(0).max(10000).optional().describe("Smooth movement duration in ms (0 = instant)"),
    steps: z.number().int().min(1).max(200).optional().describe("Interpolation steps when durationMs > 0"),
    motion: MotionProfileSchema.optional().describe("Interpolation curve used when durationMs > 0"),
    coordinateSpace: CoordinateSpaceSchema.optional().describe("screen (default), normalized (0..1000), or window"),
});
export const ClickStepSchema = z.object({
    type: z.literal("click"),
    x: z.number().optional().describe("Optional X coordinate to move to before clicking"),
    y: z.number().optional().describe("Optional Y coordinate to move to before clicking"),
    mark: MarkRefSchema,
    button: MouseButtonSchema.optional().describe("Mouse button: left (default), right, or middle"),
    count: z.number().int().min(1).max(5).optional().describe("Click count (1 = single, 2 = double, 3 = triple)"),
    modifiers: z.array(ModifierKeySchema).optional().describe("Modifier keys held during click"),
    coordinateSpace: CoordinateSpaceSchema.optional(),
});
export const DoubleClickStepSchema = z.object({
    type: z.literal("double_click"),
    x: z.number().optional().describe("Optional X coordinate to move to before double-clicking"),
    y: z.number().optional().describe("Optional Y coordinate to move to before double-clicking"),
    mark: MarkRefSchema,
    button: MouseButtonSchema.optional(),
    modifiers: z.array(ModifierKeySchema).optional(),
    coordinateSpace: CoordinateSpaceSchema.optional(),
});
export const TripleClickStepSchema = z.object({
    type: z.literal("triple_click"),
    x: z.number().optional().describe("Optional X coordinate to move to before triple-clicking"),
    y: z.number().optional().describe("Optional Y coordinate to move to before triple-clicking"),
    mark: MarkRefSchema,
    modifiers: z.array(ModifierKeySchema).optional(),
    coordinateSpace: CoordinateSpaceSchema.optional(),
});
export const RightClickStepSchema = z.object({
    type: z.literal("right_click"),
    x: z.number().optional().describe("Optional X coordinate to move to before right-clicking"),
    y: z.number().optional().describe("Optional Y coordinate to move to before right-clicking"),
    mark: MarkRefSchema,
    modifiers: z.array(ModifierKeySchema).optional(),
    coordinateSpace: CoordinateSpaceSchema.optional(),
});
export const MouseDownStepSchema = z.object({
    type: z.literal("mouse_down"),
    x: z.number().optional(),
    y: z.number().optional(),
    mark: MarkRefSchema,
    button: MouseButtonSchema.optional(),
    coordinateSpace: CoordinateSpaceSchema.optional(),
});
export const MouseUpStepSchema = z.object({
    type: z.literal("mouse_up"),
    x: z.number().optional(),
    y: z.number().optional(),
    mark: MarkRefSchema,
    button: MouseButtonSchema.optional(),
    coordinateSpace: CoordinateSpaceSchema.optional(),
});
export const DragStepSchema = z.object({
    type: z.literal("drag"),
    fromX: z.number().optional().describe("Start X (defaults to current mouse X)"),
    fromY: z.number().optional().describe("Start Y (defaults to current mouse Y)"),
    fromMark: z.number().int().min(1).max(200).optional().describe("Start the drag at detected element mark #N"),
    toX: z.number().optional().describe("Destination X coordinate. Omit when using `toMark`."),
    toY: z.number().optional().describe("Destination Y coordinate. Omit when using `toMark`."),
    toMark: z.number().int().min(1).max(200).optional().describe("End the drag at detected element mark #N"),
    button: MouseButtonSchema.optional(),
    durationMs: z.number().min(0).max(10000).optional().describe("Drag duration in ms (default 160)"),
    steps: z.number().int().min(2).max(200).optional().describe("Interpolation steps along drag path"),
    motion: MotionProfileSchema.optional().describe("Interpolation curve along the drag path"),
    coordinateSpace: CoordinateSpaceSchema.optional(),
});
export const ScrollStepSchema = z.object({
    type: z.literal("scroll"),
    x: z.number().optional().describe("Optional X to position cursor over before scrolling"),
    y: z.number().optional().describe("Optional Y to position cursor over before scrolling"),
    mark: MarkRefSchema,
    deltaX: z.number().optional().describe("Horizontal wheel ticks (+ right, - left)"),
    deltaY: z.number().optional().describe("Vertical wheel ticks (+ down, - up)"),
    direction: z.enum(["up", "down", "left", "right"]).optional().describe("Named scroll direction"),
    amount: z.number().min(1).max(100).optional().describe("Wheel ticks when using direction (default 3)"),
    coordinateSpace: CoordinateSpaceSchema.optional(),
});
export const TypeStepSchema = z.object({
    type: z.literal("type"),
    text: z.string().max(10000).describe("Text to type natively (supports Unicode and newlines)"),
    delayMs: z.number().min(0).max(1000).optional().describe("Optional delay between characters in ms"),
    submit: z.boolean().optional().describe("Press Enter immediately after typing"),
});
export const PasteStepSchema = z.object({
    type: z.literal("paste"),
    text: z
        .string()
        .max(100000)
        .describe("Text to paste instantly via OS clipboard + mod+v (ideal for long text, URLs, or code)"),
    restoreClipboard: z.boolean().optional().describe("Restore previous clipboard text after pasting (default: true)"),
    submit: z.boolean().optional().describe("Press Enter immediately after pasting"),
});
export const KeyStepSchema = z.object({
    type: z.literal("key"),
    key: z
        .string()
        .min(1)
        .max(100)
        .describe("Key or chord, e.g. 'Enter', 'Tab', 'Escape', 'Backspace', 'ArrowDown', 'ctrl+c', 'mod+a', 'cmd+shift+p'"),
    modifiers: z.array(ModifierKeySchema).optional().describe("Optional modifiers held while pressing key"),
    count: z.number().int().min(1).max(50).optional().describe("Repeat count (default 1)"),
});
export const KeyDownStepSchema = z.object({
    type: z.literal("key_down"),
    key: z.string().min(1).max(64).describe("Key to press and hold down"),
});
export const KeyUpStepSchema = z.object({
    type: z.literal("key_up"),
    key: z.string().min(1).max(64).describe("Key to release"),
});
export const FocusWindowStepSchema = z.object({
    type: z.literal("focus_window"),
    title: z.string().min(1).max(256).optional().describe("Case-insensitive substring of window title to focus"),
    app: z.string().min(1).max(256).optional().describe("Case-insensitive application/process name to focus"),
    id: z.union([z.string(), z.number()]).optional().describe("Exact window ID from handy_windows"),
});
export const WaitStepSchema = z.object({
    type: z.literal("wait"),
    ms: z.number().min(0).max(30000).describe("Milliseconds to wait (0..30000)"),
});
export const WaitForChangeStepSchema = z.object({
    type: z.literal("wait_for_change"),
    region: RegionSchema.optional().describe("Optional screen region to watch for visual change"),
    timeoutMs: z.number().min(50).max(15000).optional().describe("Max time to wait in ms (default: 3000)"),
    pollMs: z.number().min(20).max(1000).optional().describe("Polling interval in ms (default: 60)"),
    threshold: z
        .number()
        .min(0.001)
        .max(100)
        .optional()
        .describe("Minimum changed pixel percentage to trigger completion (default: 0.05)"),
});
export const WaitForSettledStepSchema = z.object({
    type: z.literal("wait_for_settled"),
    region: RegionSchema.optional().describe("Optional screen region to wait until animations stop"),
    timeoutMs: z.number().min(50).max(15000).optional().describe("Max time to wait in ms (default: 3000)"),
    quietMs: z.number().min(30).max(2000).optional().describe("Required visually quiet window in ms (default: 120)"),
    pollMs: z.number().min(20).max(1000).optional().describe("Polling interval in ms (default: 80)"),
    threshold: z
        .number()
        .min(0.001)
        .max(100)
        .optional()
        .describe("Max changed pixel percentage still treated as settled (default: 0.1)"),
});
export const WaitForColorStepSchema = z.object({
    type: z.literal("wait_for_color"),
    x: z.number().int().describe("Target X coordinate of pixel to inspect"),
    y: z.number().int().describe("Target Y coordinate of pixel to inspect"),
    color: z.string().regex(/^#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/).describe("Expected hex color (#rrggbb or #rgb)"),
    tolerance: z
        .number()
        .min(0)
        .max(442)
        .optional()
        .describe("Allowed Euclidean RGB distance 0..442 (default: 24)"),
    timeoutMs: z.number().min(50).max(15000).optional().describe("Max time to wait in ms (default: 5000)"),
    pollMs: z.number().min(20).max(1000).optional().describe("Polling interval in ms (default: 80)"),
    coordinateSpace: CoordinateSpaceSchema.optional(),
});
export const ScreenshotStepSchema = z.object({
    type: z.literal("screenshot"),
    region: RegionSchema.optional(),
    window: z.string().max(256).optional().describe("Optional window title substring to capture at 1:1 resolution"),
    grid: z.boolean().optional(),
    showMouse: z.boolean().optional(),
    highlightDiff: z.boolean().optional(),
    maxWidth: z.number().int().min(320).max(3840).optional(),
    marks: z.boolean().optional().describe("Run Set-of-Mark UI element detection on this mid-chain capture"),
    maxMarks: z.number().int().min(1).max(200).optional(),
    label: z.string().max(120).optional().describe("Optional label identifying this mid-chain capture"),
});
export const ActionStepSchema = z.discriminatedUnion("type", [
    MoveStepSchema,
    ClickStepSchema,
    DoubleClickStepSchema,
    TripleClickStepSchema,
    RightClickStepSchema,
    MouseDownStepSchema,
    MouseUpStepSchema,
    DragStepSchema,
    ScrollStepSchema,
    TypeStepSchema,
    PasteStepSchema,
    KeyStepSchema,
    KeyDownStepSchema,
    KeyUpStepSchema,
    FocusWindowStepSchema,
    WaitStepSchema,
    WaitForChangeStepSchema,
    WaitForSettledStepSchema,
    WaitForColorStepSchema,
    ScreenshotStepSchema,
]);
/**
 * Resolves the display an operation should target.
 *
 * Every bundled backend numbers displays from zero, but `id` is an opaque backend value rather
 * than a guaranteed index, so this falls back to positional lookup and then to the primary display
 * instead of silently operating on the wrong monitor (or on `undefined`).
 */
export function pickDisplay(displays, index) {
    if (displays.length === 0)
        return undefined;
    const wanted = index ?? 0;
    return (displays.find((d) => d.id === wanted) ??
        displays[wanted] ??
        displays.find((d) => d.primary) ??
        displays[0]);
}
