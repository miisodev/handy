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

export const MouseButtonSchema = z.enum(["left", "right", "middle"]);
export const ModifierKeySchema = z.enum(["ctrl", "alt", "shift", "meta", "mod"]);
export const CoordinateSpaceSchema = z.enum(["screen", "normalized"]);

export const RegionSchema = z.object({
  x: z.number().int().describe("Left X coordinate in screen pixels"),
  y: z.number().int().describe("Top Y coordinate in screen pixels"),
  width: z.number().int().min(1).max(16384).describe("Region width in screen pixels"),
  height: z.number().int().min(1).max(16384).describe("Region height in screen pixels"),
});

export const MoveStepSchema = z.object({
  type: z.literal("move"),
  x: z.number().describe("Target X coordinate (or delta X when relative=true)"),
  y: z.number().describe("Target Y coordinate (or delta Y when relative=true)"),
  relative: z.boolean().optional().describe("Move relative to current mouse position"),
  durationMs: z.number().min(0).max(10000).optional().describe("Smooth movement duration in ms (0 = instant)"),
  steps: z.number().int().min(1).max(200).optional().describe("Interpolation steps when durationMs > 0"),
  coordinateSpace: CoordinateSpaceSchema.optional().describe("screen (default) or normalized (0..1000)"),
});

export const ClickStepSchema = z.object({
  type: z.literal("click"),
  x: z.number().optional().describe("Optional X coordinate to move to before clicking"),
  y: z.number().optional().describe("Optional Y coordinate to move to before clicking"),
  button: MouseButtonSchema.optional().describe("Mouse button: left (default), right, or middle"),
  count: z.number().int().min(1).max(5).optional().describe("Click count (1 = single, 2 = double, 3 = triple)"),
  modifiers: z.array(ModifierKeySchema).optional().describe("Modifier keys held during click"),
  coordinateSpace: CoordinateSpaceSchema.optional(),
});

export const DoubleClickStepSchema = z.object({
  type: z.literal("double_click"),
  x: z.number().optional().describe("Optional X coordinate to move to before double-clicking"),
  y: z.number().optional().describe("Optional Y coordinate to move to before double-clicking"),
  button: MouseButtonSchema.optional(),
  modifiers: z.array(ModifierKeySchema).optional(),
  coordinateSpace: CoordinateSpaceSchema.optional(),
});

export const TripleClickStepSchema = z.object({
  type: z.literal("triple_click"),
  x: z.number().optional().describe("Optional X coordinate to move to before triple-clicking"),
  y: z.number().optional().describe("Optional Y coordinate to move to before triple-clicking"),
  modifiers: z.array(ModifierKeySchema).optional(),
  coordinateSpace: CoordinateSpaceSchema.optional(),
});

export const RightClickStepSchema = z.object({
  type: z.literal("right_click"),
  x: z.number().optional().describe("Optional X coordinate to move to before right-clicking"),
  y: z.number().optional().describe("Optional Y coordinate to move to before right-clicking"),
  modifiers: z.array(ModifierKeySchema).optional(),
  coordinateSpace: CoordinateSpaceSchema.optional(),
});

export const MouseDownStepSchema = z.object({
  type: z.literal("mouse_down"),
  x: z.number().optional(),
  y: z.number().optional(),
  button: MouseButtonSchema.optional(),
  coordinateSpace: CoordinateSpaceSchema.optional(),
});

export const MouseUpStepSchema = z.object({
  type: z.literal("mouse_up"),
  x: z.number().optional(),
  y: z.number().optional(),
  button: MouseButtonSchema.optional(),
  coordinateSpace: CoordinateSpaceSchema.optional(),
});

export const DragStepSchema = z.object({
  type: z.literal("drag"),
  fromX: z.number().optional().describe("Start X (defaults to current mouse X)"),
  fromY: z.number().optional().describe("Start Y (defaults to current mouse Y)"),
  toX: z.number().describe("Destination X coordinate"),
  toY: z.number().describe("Destination Y coordinate"),
  button: MouseButtonSchema.optional(),
  durationMs: z.number().min(0).max(10000).optional().describe("Drag duration in ms (default 180)"),
  steps: z.number().int().min(2).max(200).optional().describe("Interpolation steps along drag path"),
  coordinateSpace: CoordinateSpaceSchema.optional(),
});

export const ScrollStepSchema = z.object({
  type: z.literal("scroll"),
  x: z.number().optional().describe("Optional X to position cursor over before scrolling"),
  y: z.number().optional().describe("Optional Y to position cursor over before scrolling"),
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

export const WaitStepSchema = z.object({
  type: z.literal("wait"),
  ms: z.number().min(0).max(30000).describe("Milliseconds to wait (0..30000)"),
});

export const ScreenshotStepSchema = z.object({
  type: z.literal("screenshot"),
  region: RegionSchema.optional(),
  grid: z.boolean().optional(),
  showMouse: z.boolean().optional(),
  maxWidth: z.number().int().min(320).max(3840).optional(),
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
  KeyStepSchema,
  KeyDownStepSchema,
  KeyUpStepSchema,
  WaitStepSchema,
  ScreenshotStepSchema,
]);

export type ActionStep = z.infer<typeof ActionStepSchema>;

export interface SeeOptions {
  display?: number;
  region?: Region;
  grid?: boolean;
  gridStep?: number;
  showMouse?: boolean;
  maxWidth?: number;
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
  settleMs?: number;
  display?: number;
  maxWidth?: number;
  grid?: boolean;
  showMouse?: boolean;
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
  receipts: StepReceipt[];
  screenshots: SeeResult[];
}

export type PermissionMode = "full" | "view_only";

export interface PermissionState {
  enabled: boolean;
  mode: PermissionMode;
  expiresAt: string | null;
  updatedAt: string;
  updatedBy: "default" | "cli" | "env" | "mcp" | "expired";
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
  captureScreen(options?: { display?: number; region?: Region }): Promise<RawFrame>;
  doctor(): Promise<DoctorCheck[]>;
}
