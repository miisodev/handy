import { computeFrameDiff, hexColorDistance, samplePixelHex } from "./diff.js";
import { parseKeyChord, resolveModifier } from "./keys.js";
import { detectUiElements, resolveMarkCenter } from "./marks.js";
import { renderScreenOverlay } from "./overlay.js";
import { PermissionStore } from "./permissions.js";
import { encodePng, resizeRgba } from "./png.js";
import { pickDisplay } from "./types.js";
import type {
  ActionStep,
  ActOptions,
  ActResult,
  CoordinateSpace,
  DesktopBackend,
  DisplayInfo,
  DoctorCheck,
  FrameDiff,
  MotionProfile,
  MouseButton,
  Point,
  RawFrame,
  Region,
  SeeOptions,
  SeeResult,
  StepReceipt,
  TrailMarker,
  UiElement,
  WindowInfo,
} from "./types.js";

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Action chain aborted."));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Action chain aborted."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isTopLeftCorner(p: Point): boolean {
  return p.x <= 2 && p.y <= 2;
}

/**
 * Fitts's-law pointer travel time: `a + b * log2(D/W + 1)`.
 *
 * Real users take longer to reach small, distant targets. Using that curve for `motion: "human"`
 * produces plausible velocities instead of a constant-speed teleport, which matters for apps that
 * gate behaviour on pointer dynamics (hover intent, drag thresholds, gesture recognisers).
 */
export function fittsDurationMs(from: Point, to: Point, targetWidth = 24, a = 60, b = 110): number {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  if (distance < 2) return 0;
  const width = Math.max(4, targetWidth);
  const ms = a + b * Math.log2(distance / width + 1);
  return Math.round(Math.max(0, Math.min(1200, ms)));
}

/** Cubic Bezier control-point evaluation for human-like pointer arcs. */
function bezier1d(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
}

export class HandyController {
  readonly backend: DesktopBackend;
  readonly permissions: PermissionStore;

  private readonly heldButtons = new Set<MouseButton>();
  private readonly heldKeys = new Set<string>();
  private queueTail: Promise<unknown> = Promise.resolve();
  private queuedCount = 0;
  private lastSeenFrame: RawFrame | null = null;
  private lastElements: UiElement[] | null = null;
  private lastObservedMouse: Point | null = null;
  private lastCommandedTarget: Point | null = null;
  private static readonly MAX_QUEUED_CHAINS = 8;

  constructor(options: { backend: DesktopBackend; permissions?: PermissionStore }) {
    this.backend = options.backend;
    this.permissions = options.permissions ?? new PermissionStore();
  }

  async init(): Promise<void> {
    await this.backend.init();
  }

  async close(): Promise<void> {
    await this.releaseHeldInputs();
    await this.backend.close();
  }

  async releaseHeldInputs(): Promise<void> {
    for (const btn of Array.from(this.heldButtons)) {
      try {
        await this.backend.mouseUp(btn);
      } catch {
        // best-effort cleanup
      }
      this.heldButtons.delete(btn);
    }
    for (const key of Array.from(this.heldKeys).reverse()) {
      try {
        await this.backend.keyUp(key);
      } catch {
        // best-effort cleanup
      }
      this.heldKeys.delete(key);
    }
  }

  async status(): Promise<{
    enabled: boolean;
    mode: "full" | "view_only";
    expiresAt: string | null;
    updatedAt: string;
    updatedBy: string;
    platform: string;
    backend: string;
    displays?: DisplayInfo[];
    mouse?: Point;
    activeWindow?: WindowInfo | null;
  }> {
    const perm = this.permissions.getState();
    const base = {
      enabled: perm.enabled,
      mode: perm.mode,
      expiresAt: perm.expiresAt,
      updatedAt: perm.updatedAt,
      updatedBy: perm.updatedBy,
      platform: process.platform,
      backend: this.backend.name,
    };
    if (!perm.enabled) {
      return base;
    }
    try {
      const [displays, mouse, activeWindow] = await Promise.all([
        this.backend.getDisplays(),
        this.backend.getMousePosition(),
        this.backend.getActiveWindow ? this.backend.getActiveWindow().catch(() => null) : Promise.resolve(null),
      ]);
      return { ...base, displays, mouse, activeWindow };
    } catch {
      return base;
    }
  }

  async doctor(): Promise<{
    permission: ReturnType<PermissionStore["getState"]>;
    backend: string;
    checks: DoctorCheck[];
  }> {
    const permission = this.permissions.getState();
    const checks = await this.backend.doctor();
    return {
      permission,
      backend: this.backend.name,
      checks,
    };
  }

  async listWindows(): Promise<WindowInfo[]> {
    this.permissions.assertCanSee();
    if (!this.backend.listWindows) return [];
    return this.backend.listWindows();
  }

  async getActiveWindow(): Promise<WindowInfo | null> {
    this.permissions.assertCanSee();
    if (!this.backend.getActiveWindow) return null;
    return this.backend.getActiveWindow();
  }

  async focusWindow(query: {
    title?: string;
    app?: string;
    id?: string | number;
  }): Promise<{ focused: boolean; activeWindow: WindowInfo | null }> {
    this.permissions.assertCanControl();
    if (!this.backend.focusWindow) {
      throw new Error(`Window focusing is not supported by backend "${this.backend.name}".`);
    }
    const focused = await this.backend.focusWindow(query);
    const activeWindow = this.backend.getActiveWindow ? await this.backend.getActiveWindow().catch(() => null) : null;
    return { focused, activeWindow };
  }

  async readClipboard(): Promise<string> {
    this.permissions.assertCanSee();
    if (!this.backend.getClipboardText) {
      throw new Error(`Clipboard read is not supported by backend "${this.backend.name}".`);
    }
    return this.backend.getClipboardText();
  }

  async writeClipboard(text: string): Promise<void> {
    this.permissions.assertCanControl();
    if (!this.backend.setClipboardText) {
      throw new Error(`Clipboard write is not supported by backend "${this.backend.name}".`);
    }
    await this.backend.setClipboardText(text);
  }

  private async resolveWindowRegion(
    query: NonNullable<SeeOptions["window"]>,
    displayIndex?: number,
  ): Promise<Region> {
    if (!this.backend.listWindows) {
      throw new Error(`Window-scoped capture is not supported by backend "${this.backend.name}".`);
    }
    const q = typeof query === "string" ? { title: query, app: query } : query;
    const [windows, displays] = await Promise.all([this.backend.listWindows(), this.backend.getDisplays()]);
    const titleNeedle = q.title?.toLowerCase();
    const appNeedle = q.app?.toLowerCase();
    const match =
      q.id !== undefined
        ? windows.find((w) => String(w.id) === String(q.id))
        : windows.find((w) => {
            if (titleNeedle && w.title.toLowerCase().includes(titleNeedle)) return true;
            if (appNeedle && (w.app ?? "").toLowerCase().includes(appNeedle)) return true;
            return false;
          });
    if (!match || !match.bounds) {
      const label = typeof query === "string" ? query : (query.title ?? query.app ?? String(query.id ?? ""));
      throw new Error(`No visible window with bounds matched "${label}".`);
    }
    const disp = pickDisplay(displays, displayIndex);
    if (!disp) return match.bounds;

    const x1 = Math.max(disp.x, match.bounds.x);
    const y1 = Math.max(disp.y, match.bounds.y);
    const x2 = Math.min(disp.x + disp.width, match.bounds.x + match.bounds.width);
    const y2 = Math.min(disp.y + disp.height, match.bounds.y + match.bounds.height);
    return {
      x: x1,
      y: y1,
      width: Math.max(1, x2 - x1),
      height: Math.max(1, y2 - y1),
    };
  }

  async see(options: SeeOptions & { trail?: TrailMarker[] } = {}): Promise<SeeResult> {
    this.permissions.assertCanSee();
    const t0 = performance.now();

    const effectiveRegion =
      options.region ??
      (options.window !== undefined ? await this.resolveWindowRegion(options.window, options.display) : undefined);

    const [frame, mouse, activeWindow] = await Promise.all([
      this.backend.captureScreen({ display: options.display, region: effectiveRegion }),
      this.backend.getMousePosition(),
      this.backend.getActiveWindow ? this.backend.getActiveWindow().catch(() => null) : Promise.resolve(null),
    ]);

    this.lastObservedMouse = { ...mouse };

    // Sample pixel color directly under cursor from the raw unannotated frame
    const pixelUnderMouse = samplePixelHex(frame, mouse);

    // Compute fast RGBA visual diff against previous comparable frame
    let screenDiff: FrameDiff | null = null;
    if (
      this.lastSeenFrame &&
      this.lastSeenFrame.displayId === frame.displayId &&
      this.lastSeenFrame.originX === frame.originX &&
      this.lastSeenFrame.originY === frame.originY &&
      this.lastSeenFrame.width === frame.width &&
      this.lastSeenFrame.height === frame.height
    ) {
      screenDiff = computeFrameDiff(this.lastSeenFrame, frame);
    }
    this.lastSeenFrame = frame;

    const maxWidth = options.maxWidth ?? 1280;
    let outWidth = frame.width;
    let outHeight = frame.height;
    let rgba: Uint8Array;

    if (frame.width > maxWidth) {
      const ratio = maxWidth / frame.width;
      outWidth = maxWidth;
      outHeight = Math.max(1, Math.round(frame.height * ratio));
      rgba = resizeRgba(frame.data, frame.width, frame.height, outWidth, outHeight);
    } else {
      rgba = new Uint8Array(frame.data);
    }

    // Set-of-Mark detection runs on the raw, unannotated frame so overlay chrome never influences
    // the result, and coordinates come back in global logical screen space.
    let elements: UiElement[] | undefined;
    if (options.marks) {
      elements = detectUiElements(frame, {
        maxMarks: options.maxMarks,
        kinds: options.markKinds,
        minScore: options.minMarkScore,
      });
      this.lastElements = elements;
    }

    const overlayMeta = renderScreenOverlay(rgba, outWidth, outHeight, {
      originX: frame.originX,
      originY: frame.originY,
      logicalWidth: frame.logicalWidth,
      logicalHeight: frame.logicalHeight,
      mouse,
      grid: options.grid ?? true,
      gridStep: options.gridStep,
      showMouse: options.showMouse ?? true,
      trail: options.trail,
      diffBounds: options.highlightDiff && screenDiff?.changedBounds ? screenDiff.changedBounds : null,
      marks: elements,
    });

    const pngBuffer = encodePng(outWidth, outHeight, rgba, { compressionLevel: 3 });
    const captureMs = Math.round((performance.now() - t0) * 10) / 10;

    return {
      pngBuffer,
      base64Png: pngBuffer.toString("base64"),
      imageWidth: outWidth,
      imageHeight: outHeight,
      screen: {
        displayId: frame.displayId,
        originX: frame.originX,
        originY: frame.originY,
        width: frame.logicalWidth,
        height: frame.logicalHeight,
        scaleFactor: frame.scaleFactor,
      },
      region: {
        x: frame.originX,
        y: frame.originY,
        width: frame.logicalWidth,
        height: frame.logicalHeight,
      },
      mouse,
      pixelUnderMouse,
      activeWindow,
      screenDiff,
      gridStep: overlayMeta.gridStep,
      ...(elements ? { elements } : {}),
      coordinateSpace: "screen",
      captureMs,
      timestamp: new Date().toISOString(),
    };
  }

  async act(options: ActOptions): Promise<ActResult> {
    if (!options.actions || options.actions.length === 0) {
      throw new Error("actions must contain at least one step.");
    }
    if (options.actions.length > 100) {
      throw new Error("actions cannot exceed 100 steps in a single chain.");
    }
    if (this.queuedCount >= HandyController.MAX_QUEUED_CHAINS) {
      throw new Error("Too many concurrent action chains queued; wait for active chain to finish.");
    }

    this.queuedCount += 1;
    const run = this.queueTail.then(
      () => this.executeChainInternal(options),
      () => this.executeChainInternal(options),
    );
    this.queueTail = run.then(
      () => undefined,
      () => undefined,
    );

    try {
      return await run;
    } finally {
      this.queuedCount -= 1;
    }
  }

  private async checkFailsafe(enabled: boolean): Promise<void> {
    const cur = await this.backend.getMousePosition();
    if (
      enabled &&
      isTopLeftCorner(cur) &&
      this.lastObservedMouse !== null &&
      !isTopLeftCorner(this.lastObservedMouse) &&
      (!this.lastCommandedTarget || !isTopLeftCorner(this.lastCommandedTarget))
    ) {
      this.lastObservedMouse = { ...cur };
      throw new Error(
        "Failsafe triggered: cursor was moved to the top-left corner (0,0). Action chain aborted immediately.",
      );
    }
    this.lastObservedMouse = { ...cur };
  }

  private async commandMoveMouse(x: number, y: number): Promise<void> {
    const rx = Math.round(x);
    const ry = Math.round(y);
    this.lastCommandedTarget = { x: rx, y: ry };
    await this.backend.moveMouse(rx, ry);
    this.lastObservedMouse = { x: rx, y: ry };
  }

  /** Most recent Set-of-Mark elements, cleared whenever a capture runs without `marks`. */
  get detectedElements(): UiElement[] | null {
    return this.lastElements;
  }

  private resolveMarkPoint(mark: number): Point {
    if (!this.lastElements || this.lastElements.length === 0) {
      throw new Error(
        `Cannot resolve mark #${mark}: no detected UI elements are available. Call handy_see with { marks: true } first — marks are refreshed on every marked capture.`,
      );
    }
    return resolveMarkCenter(this.lastElements, mark);
  }

  /**
   * Resolves where a pointer step should go: an explicit `mark`, then explicit coordinates, then
   * "wherever the cursor already is". `via` lets receipts record which route was taken.
   */
  private async resolveStepTarget(
    step: { x?: number; y?: number; mark?: number; coordinateSpace?: CoordinateSpace },
    displayIndex: number | undefined,
    cachedDisplays: DisplayInfo[] | null,
  ): Promise<{ point: Point | null; displays: DisplayInfo[] | null; via: "mark" | "coords" | null }> {
    if (step.mark !== undefined) {
      return { point: this.resolveMarkPoint(step.mark), displays: cachedDisplays, via: "mark" };
    }
    if (step.x !== undefined && step.y !== undefined) {
      const res = await this.resolvePoint(step.x, step.y, step.coordinateSpace, displayIndex, cachedDisplays);
      return { point: res.point, displays: res.displays, via: "coords" };
    }
    return { point: null, displays: cachedDisplays, via: null };
  }

  private async resolvePoint(
    x: number,
    y: number,
    space: CoordinateSpace | undefined,
    displayIndex: number | undefined,
    cachedDisplays: DisplayInfo[] | null,
  ): Promise<{ point: Point; displays: DisplayInfo[] | null }> {
    if (!space || space === "screen") {
      return { point: { x: Math.round(x), y: Math.round(y) }, displays: cachedDisplays };
    }

    if (space === "window") {
      if (!this.backend.getActiveWindow) {
        throw new Error(`Coordinate space "window" is not supported by backend "${this.backend.name}".`);
      }
      const win = await this.backend.getActiveWindow();
      if (!win || !win.bounds) {
        throw new Error('Cannot resolve coordinateSpace "window": no active window with bounds is available.');
      }
      return {
        point: {
          x: Math.round(win.bounds.x + x),
          y: Math.round(win.bounds.y + y),
        },
        displays: cachedDisplays,
      };
    }

    const displays = cachedDisplays ?? (await this.backend.getDisplays());
    const disp = pickDisplay(displays, displayIndex);
    if (!disp) {
      throw new Error("No display found for normalized coordinate conversion.");
    }
    const clampedX = Math.max(0, Math.min(1000, x));
    const clampedY = Math.max(0, Math.min(1000, y));
    return {
      point: {
        x: Math.round(disp.x + (clampedX / 1000) * Math.max(1, disp.width - 1)),
        y: Math.round(disp.y + (clampedY / 1000) * Math.max(1, disp.height - 1)),
      },
      displays,
    };
  }

  private async interpolateMove(
    from: Point,
    to: Point,
    durationMs: number,
    steps: number | undefined,
    failsafe: boolean,
    signal?: AbortSignal,
    motion: MotionProfile = "ease",
  ): Promise<void> {
    const count = steps ?? Math.max(2, Math.min(motion === "human" ? 90 : 60, Math.round(durationMs / 10)));
    const interval = durationMs / count;

    // Human motion follows a shallow arc rather than a mathematically straight line.
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy);
    const arc = motion === "human" ? Math.min(14, distance * 0.035) : 0;
    // Deterministic per-move perpendicular direction so a repeated drag is reproducible.
    const sign = (Math.round(from.x + from.y) & 1) === 0 ? 1 : -1;
    const perpX = distance > 0 ? (-dy / distance) * arc * sign : 0;
    const perpY = distance > 0 ? (dx / distance) * arc * sign : 0;

    for (let i = 1; i <= count; i++) {
      this.permissions.assertCanControl();
      if (signal?.aborted) throw new Error("Action chain aborted.");
      if (i > 1 && i % 4 === 0) {
        await this.checkFailsafe(failsafe);
      }

      const t = i / count;
      let nx: number;
      let ny: number;

      if (motion === "linear") {
        nx = Math.round(from.x + dx * t);
        ny = Math.round(from.y + dy * t);
      } else if (motion === "human") {
        // Ease-in-out along a quadratic Bezier bowed perpendicular to the travel direction.
        const eased = bezier1d(0, 0.42, 0.58, 1, t);
        const bow = Math.sin(Math.PI * t);
        nx = Math.round(from.x + dx * eased + perpX * bow);
        ny = Math.round(from.y + dy * eased + perpY * bow);
      } else {
        const eased = 1 - (1 - t) * (1 - t);
        nx = Math.round(from.x + dx * eased);
        ny = Math.round(from.y + dy * eased);
      }

      await this.commandMoveMouse(nx, ny);
      if (i < count && interval >= 1) {
        await sleepAbortable(interval, signal);
      }
    }
  }

  private async performClick(
    button: MouseButton,
    count: number,
    modifiers: ("ctrl" | "alt" | "shift" | "meta" | "mod")[] | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const resolvedMods = (modifiers ?? []).map((m) => resolveModifier(m, this.backend.platform));

    for (const mod of resolvedMods) {
      await this.backend.keyDown(mod);
      this.heldKeys.add(mod);
    }

    try {
      for (let c = 1; c <= count; c++) {
        this.permissions.assertCanControl();
        // Capability detection, not `instanceof`: any backend that can carry click count and
        // modifiers on the native event opts in via `nativeClickCount`.
        if (this.backend.nativeClickCount) {
          await this.backend.mouseDown(button, c, resolvedMods);
          this.heldButtons.add(button);
          await this.backend.mouseUp(button, c, resolvedMods);
          this.heldButtons.delete(button);
        } else {
          await this.backend.mouseDown(button);
          this.heldButtons.add(button);
          await this.backend.mouseUp(button);
          this.heldButtons.delete(button);
        }
        if (c < count) {
          await sleepAbortable(20, signal);
        }
      }
    } finally {
      for (const mod of [...resolvedMods].reverse()) {
        await this.backend.keyUp(mod);
        this.heldKeys.delete(mod);
      }
    }
  }

  private async executeChainInternal(options: ActOptions): Promise<ActResult> {
    this.permissions.assertCanControl();

    const chainStart = performance.now();
    const stepDelayMs = options.stepDelayMs ?? 15;
    const failsafeEnabled = options.failsafe ?? true;
    const showTrail = options.showTrail ?? true;
    const receipts: StepReceipt[] = [];
    const screenshots: SeeResult[] = [];
    const trail: TrailMarker[] = [];
    let cachedDisplays: DisplayInfo[] | null = null;

    // Optional pre-chain baseline so `verifyChange` can report whether anything actually moved.
    let verifyBaseline: RawFrame | null = null;
    if (options.verifyChange) {
      try {
        verifyBaseline = await this.backend.captureScreen({ display: options.display });
      } catch {
        verifyBaseline = null;
      }
    }

    try {
      await this.checkFailsafe(failsafeEnabled);

      for (let i = 0; i < options.actions.length; i++) {
        const step = options.actions[i]!;
        if (options.signal?.aborted) {
          throw new Error("Action chain aborted.");
        }

        if (i > 0) {
          await this.checkFailsafe(failsafeEnabled);
        }

        // Check permission before EVERY step in the chain so `handy off` stops immediately mid-chain
        if (step.type === "screenshot" || step.type === "wait_for_change" || step.type === "wait_for_settled") {
          this.permissions.assertCanSee();
        } else {
          this.permissions.assertCanControl();
        }

        const stepStart = performance.now();
        let detail: string | undefined;

        switch (step.type) {
          case "move": {
            let target: Point;
            let via: "mark" | "coords" | "relative" = "coords";
            if (step.relative) {
              if (step.x === undefined || step.y === undefined) {
                throw new Error("A relative move step requires both x and y deltas.");
              }
              const cur = await this.backend.getMousePosition();
              target = { x: Math.round(cur.x + step.x), y: Math.round(cur.y + step.y) };
              via = "relative";
            } else {
              const res = await this.resolveStepTarget(step, options.display, cachedDisplays);
              cachedDisplays = res.displays;
              if (!res.point) {
                throw new Error('A move step requires either { x, y } or { mark }.');
              }
              target = res.point;
              via = res.via ?? "coords";
            }

            const startPos = await this.backend.getMousePosition();
            const durationMs =
              step.durationMs ?? (step.motion === "human" ? fittsDurationMs(startPos, target) : 0);
            if (durationMs > 0) {
              await this.interpolateMove(
                startPos,
                target,
                durationMs,
                step.steps,
                failsafeEnabled,
                options.signal,
                step.motion,
              );
            } else {
              await this.commandMoveMouse(target.x, target.y);
            }
            detail =
              via === "mark"
                ? `moved to mark #${step.mark} at (${target.x},${target.y})`
                : `moved to (${target.x},${target.y})`;
            break;
          }

          case "click":
          case "double_click":
          case "triple_click":
          case "right_click": {
            let clickPos: Point;
            let clickVia: "mark" | "coords" | null = null;
            const clickTarget = await this.resolveStepTarget(step, options.display, cachedDisplays);
            cachedDisplays = clickTarget.displays;
            if (clickTarget.point) {
              clickPos = clickTarget.point;
              clickVia = clickTarget.via;
              await this.commandMoveMouse(clickPos.x, clickPos.y);
              await sleepAbortable(6, options.signal);
            } else {
              clickPos = await this.backend.getMousePosition();
            }
            const button: MouseButton =
              step.type === "right_click" ? "right" : "button" in step && step.button ? step.button : "left";
            const count =
              step.type === "double_click"
                ? 2
                : step.type === "triple_click"
                  ? 3
                  : "count" in step && step.count
                    ? step.count
                    : 1;
            await this.performClick(button, count, step.modifiers, options.signal);
            trail.push({
              stepNumber: i + 1,
              kind: "click",
              x: clickPos.x,
              y: clickPos.y,
            });
            detail = `${button} click x${count} at (${clickPos.x},${clickPos.y})${
              clickVia === "mark" ? ` (mark #${step.mark})` : ""
            }`;
            break;
          }

          case "mouse_down": {
            const res = await this.resolveStepTarget(step, options.display, cachedDisplays);
            cachedDisplays = res.displays;
            if (res.point) {
              await this.commandMoveMouse(res.point.x, res.point.y);
            }
            const btn = step.button ?? "left";
            await this.backend.mouseDown(btn);
            this.heldButtons.add(btn);
            detail = `${btn} mouse_down`;
            break;
          }

          case "mouse_up": {
            const res = await this.resolveStepTarget(step, options.display, cachedDisplays);
            cachedDisplays = res.displays;
            if (res.point) {
              await this.commandMoveMouse(res.point.x, res.point.y);
            }
            const btn = step.button ?? "left";
            await this.backend.mouseUp(btn);
            this.heldButtons.delete(btn);
            detail = `${btn} mouse_up`;
            break;
          }

          case "drag": {
            let startPos: Point;
            let dragFrom: string;
            if (step.fromMark !== undefined) {
              startPos = this.resolveMarkPoint(step.fromMark);
              dragFrom = `mark #${step.fromMark}`;
              await this.commandMoveMouse(startPos.x, startPos.y);
              await sleepAbortable(8, options.signal);
            } else if (step.fromX !== undefined && step.fromY !== undefined) {
              const fromRes = await this.resolvePoint(
                step.fromX,
                step.fromY,
                step.coordinateSpace,
                options.display,
                cachedDisplays,
              );
              cachedDisplays = fromRes.displays;
              startPos = fromRes.point;
              dragFrom = `(${startPos.x},${startPos.y})`;
              await this.commandMoveMouse(startPos.x, startPos.y);
              await sleepAbortable(8, options.signal);
            } else {
              startPos = await this.backend.getMousePosition();
              dragFrom = `current (${startPos.x},${startPos.y})`;
            }

            let endPos: Point;
            let dragTo: string;
            if (step.toMark !== undefined) {
              endPos = this.resolveMarkPoint(step.toMark);
              dragTo = `mark #${step.toMark}`;
            } else if (step.toX !== undefined && step.toY !== undefined) {
              const toRes = await this.resolvePoint(
                step.toX,
                step.toY,
                step.coordinateSpace,
                options.display,
                cachedDisplays,
              );
              cachedDisplays = toRes.displays;
              endPos = toRes.point;
              dragTo = `(${endPos.x},${endPos.y})`;
            } else {
              throw new Error("A drag step requires either { toX, toY } or { toMark }.");
            }

            const btn = step.button ?? "left";
            const dragDurationMs =
              step.durationMs ?? (step.motion === "human" ? Math.max(160, fittsDurationMs(startPos, endPos)) : 160);

            await this.backend.mouseDown(btn);
            this.heldButtons.add(btn);
            try {
              await this.interpolateMove(
                startPos,
                endPos,
                dragDurationMs,
                step.steps ?? 16,
                failsafeEnabled,
                options.signal,
                step.motion,
              );
            } finally {
              await this.backend.mouseUp(btn);
              this.heldButtons.delete(btn);
            }
            trail.push(
              {
                stepNumber: i + 1,
                kind: "drag_start",
                x: startPos.x,
                y: startPos.y,
              },
              {
                stepNumber: i + 1,
                kind: "drag_end",
                x: endPos.x,
                y: endPos.y,
              },
            );
            detail = `dragged ${dragFrom} -> ${dragTo}`;
            break;
          }

          case "scroll": {
            const res = await this.resolveStepTarget(step, options.display, cachedDisplays);
            cachedDisplays = res.displays;
            if (res.point) {
              await this.commandMoveMouse(res.point.x, res.point.y);
            }
            const amount = step.amount ?? 3;
            let dx = step.deltaX ?? 0;
            let dy = step.deltaY ?? 0;
            if (step.direction === "up") dy -= amount;
            else if (step.direction === "down") dy += amount;
            else if (step.direction === "left") dx -= amount;
            else if (step.direction === "right") dx += amount;
            await this.backend.scroll(dx, dy);
            detail = `scrolled dx=${dx} dy=${dy}`;
            break;
          }

          case "type": {
            if (step.delayMs && step.delayMs > 0) {
              const chars = Array.from(step.text);
              for (let cIdx = 0; cIdx < chars.length; cIdx++) {
                this.permissions.assertCanControl();
                if (options.signal?.aborted) throw new Error("Action chain aborted.");
                await this.backend.typeText(chars[cIdx]!);
                if (cIdx < chars.length - 1) {
                  await sleepAbortable(step.delayMs, options.signal);
                }
              }
            } else if (step.text.length > 0) {
              await this.backend.typeText(step.text);
            }
            if (step.submit) {
              await sleepAbortable(10, options.signal);
              await this.backend.keyTap("enter", []);
            }
            detail = `typed ${Array.from(step.text).length} chars${step.submit ? " + Enter" : ""}`;
            break;
          }

          case "paste": {
            if (!this.backend.setClipboardText) {
              // Graceful fallback to typeText if clipboard utility is unavailable
              await this.backend.typeText(step.text);
              if (step.submit) {
                await sleepAbortable(10, options.signal);
                await this.backend.keyTap("enter", []);
              }
              detail = `typed (clipboard fallback) ${Array.from(step.text).length} chars`;
              break;
            }

            const shouldRestore = step.restoreClipboard ?? true;
            let previousClip: string | null = null;
            if (shouldRestore && this.backend.getClipboardText) {
              try {
                previousClip = await this.backend.getClipboardText();
              } catch {
                previousClip = null;
              }
            }

            await this.backend.setClipboardText(step.text);
            const pasteParsed = parseKeyChord("mod+v", [], this.backend.platform);
            await this.backend.keyTap(pasteParsed.key, pasteParsed.modifiers);

            if (previousClip !== null && this.backend.setClipboardText) {
              await sleepAbortable(35, options.signal);
              try {
                await this.backend.setClipboardText(previousClip);
              } catch {
                // ignore restore error
              }
            }

            if (step.submit) {
              await sleepAbortable(10, options.signal);
              await this.backend.keyTap("enter", []);
            }
            detail = `pasted ${Array.from(step.text).length} chars${step.submit ? " + Enter" : ""}`;
            break;
          }

          case "key": {
            const parsed = parseKeyChord(step.key, step.modifiers ?? [], this.backend.platform);
            const repeat = step.count ?? 1;
            for (let r = 0; r < repeat; r++) {
              this.permissions.assertCanControl();
              await this.backend.keyTap(parsed.key, parsed.modifiers);
              if (r < repeat - 1) {
                await sleepAbortable(15, options.signal);
              }
            }
            const chordLabel = [...parsed.modifiers, parsed.key].join("+");
            detail = repeat > 1 ? `key ${chordLabel} x${repeat}` : `key ${chordLabel}`;
            break;
          }

          case "key_down": {
            await this.backend.keyDown(step.key);
            this.heldKeys.add(step.key);
            detail = `key_down ${step.key}`;
            break;
          }

          case "key_up": {
            await this.backend.keyUp(step.key);
            this.heldKeys.delete(step.key);
            detail = `key_up ${step.key}`;
            break;
          }

          case "focus_window": {
            if (!this.backend.focusWindow) {
              throw new Error(`Window focusing is not supported by backend "${this.backend.name}".`);
            }
            const ok = await this.backend.focusWindow({
              title: step.title,
              app: step.app,
              id: step.id,
            });
            if (!ok) {
              const targetDesc = step.title ?? step.app ?? String(step.id ?? "");
              throw new Error(`Could not find or focus window matching "${targetDesc}".`);
            }
            await sleepAbortable(35, options.signal);
            detail = `focused window (${step.title ?? step.app ?? step.id})`;
            break;
          }

          case "wait": {
            await sleepAbortable(step.ms, options.signal);
            detail = `waited ${step.ms}ms`;
            break;
          }

          case "wait_for_change": {
            const timeoutMs = step.timeoutMs ?? 3000;
            const pollMs = step.pollMs ?? 60;
            const threshold = step.threshold ?? 0.05;
            const baseline = await this.backend.captureScreen({
              display: options.display,
              region: step.region,
            });
            const deadline = performance.now() + timeoutMs;
            let maxObserved = 0;
            let matchedDiff: FrameDiff | null = null;

            while (performance.now() < deadline) {
              await sleepAbortable(pollMs, options.signal);
              this.permissions.assertCanControl();
              await this.checkFailsafe(failsafeEnabled);
              const next = await this.backend.captureScreen({
                display: options.display,
                region: step.region,
              });
              const diff = computeFrameDiff(baseline, next);
              if (diff) {
                if (diff.changedPercent > maxObserved) maxObserved = diff.changedPercent;
                if (diff.changedPercent >= threshold) {
                  matchedDiff = diff;
                  break;
                }
              }
            }

            if (!matchedDiff) {
              throw new Error(
                `Timed out after ${timeoutMs}ms waiting for screen change >= ${threshold}% (max observed: ${maxObserved}%).`,
              );
            }
            detail = `detected ${matchedDiff.changedPercent}% visual change`;
            break;
          }

          case "wait_for_settled": {
            const timeoutMs = step.timeoutMs ?? 3000;
            const quietMs = step.quietMs ?? 120;
            const pollMs = step.pollMs ?? 80;
            const threshold = step.threshold ?? 0.1;

            let prev = await this.backend.captureScreen({
              display: options.display,
              region: step.region,
            });
            const deadline = performance.now() + timeoutMs;
            let quietSince = performance.now();
            let settled = false;

            while (performance.now() < deadline) {
              await sleepAbortable(pollMs, options.signal);
              this.permissions.assertCanControl();
              await this.checkFailsafe(failsafeEnabled);
              const curr = await this.backend.captureScreen({
                display: options.display,
                region: step.region,
              });
              const diff = computeFrameDiff(prev, curr);
              prev = curr;
              if (!diff || diff.changedPercent <= threshold) {
                if (performance.now() - quietSince >= quietMs) {
                  settled = true;
                  break;
                }
              } else {
                quietSince = performance.now();
              }
            }

            detail = settled
              ? `screen settled (${quietMs}ms quiet)`
              : `timeout (${timeoutMs}ms) reached while waiting for settle`;
            break;
          }

          case "wait_for_color": {
            const timeoutMs = step.timeoutMs ?? 5000;
            const pollMs = step.pollMs ?? 80;
            const tolerance = step.tolerance ?? 24;
            const resolved = await this.resolvePoint(
              step.x,
              step.y,
              step.coordinateSpace,
              options.display,
              cachedDisplays,
            );
            cachedDisplays = resolved.displays ?? (await this.backend.getDisplays());
            const disp = pickDisplay(cachedDisplays, options.display);

            let sampleRegion: Region | undefined;
            if (disp) {
              const rx1 = Math.max(disp.x, resolved.point.x - 1);
              const ry1 = Math.max(disp.y, resolved.point.y - 1);
              const rx2 = Math.min(disp.x + disp.width, resolved.point.x + 2);
              const ry2 = Math.min(disp.y + disp.height, resolved.point.y + 2);
              sampleRegion = {
                x: rx1,
                y: ry1,
                width: Math.max(1, rx2 - rx1),
                height: Math.max(1, ry2 - ry1),
              };
            }

            const deadline = performance.now() + timeoutMs;
            let matched = false;
            let lastHex: string | null = null;
            let lastDist: number | null = null;

            while (true) {
              this.permissions.assertCanControl();
              await this.checkFailsafe(failsafeEnabled);
              const frame = await this.backend.captureScreen({
                display: options.display,
                region: sampleRegion,
              });
              lastHex = samplePixelHex(frame, resolved.point);
              if (lastHex) {
                lastDist = Math.round(hexColorDistance(lastHex, step.color) * 10) / 10;
                if (lastDist <= tolerance) {
                  matched = true;
                  break;
                }
              }
              if (performance.now() >= deadline) {
                break;
              }
              await sleepAbortable(Math.min(pollMs, Math.max(1, deadline - performance.now())), options.signal);
            }

            detail = matched
              ? `matched ${lastHex} near ${step.color} (dist ${lastDist}) at (${resolved.point.x}, ${resolved.point.y})`
              : `timeout (${timeoutMs}ms) waiting for ${step.color} at (${resolved.point.x}, ${resolved.point.y}); last ${lastHex ?? "none"}`;
            break;
          }

          case "screenshot": {
            const shot = await this.see({
              display: options.display,
              region: step.region,
              window: step.window,
              grid: step.grid ?? options.grid ?? true,
              showMouse: step.showMouse ?? options.showMouse ?? true,
              maxWidth: step.maxWidth ?? options.maxWidth,
              highlightDiff: step.highlightDiff ?? options.highlightDiff,
              trail: showTrail && trail.length > 0 ? trail : undefined,
              marks: step.marks ?? options.marks,
              maxMarks: step.maxMarks ?? options.maxMarks,
              markKinds: options.markKinds,
              minMarkScore: options.minMarkScore,
            });
            if (step.label) shot.label = step.label;
            screenshots.push(shot);
            detail = `captured ${shot.imageWidth}x${shot.imageHeight}`;
            break;
          }
        }

        const stepDurationMs = Math.round((performance.now() - stepStart) * 10) / 10;
        receipts.push({
          index: i,
          type: step.type,
          durationMs: stepDurationMs,
          detail,
        });

        if (
          i < options.actions.length - 1 &&
          stepDelayMs > 0 &&
          step.type !== "wait" &&
          step.type !== "wait_for_change" &&
          step.type !== "wait_for_settled" &&
          step.type !== "wait_for_color" &&
          step.type !== "screenshot"
        ) {
          await sleepAbortable(stepDelayMs, options.signal);
        }
      }

      if (options.screenshotAfter) {
        const settleMs = options.settleMs ?? 50;
        if (settleMs > 0) {
          await sleepAbortable(settleMs, options.signal);
        }
        const postShot = await this.see({
          display: options.display,
          grid: options.grid ?? true,
          showMouse: options.showMouse ?? true,
          maxWidth: options.maxWidth,
          highlightDiff: options.highlightDiff,
          trail: showTrail && trail.length > 0 ? trail : undefined,
          marks: options.marks,
          maxMarks: options.maxMarks,
          markKinds: options.markKinds,
          minMarkScore: options.minMarkScore,
        });
        postShot.label = "after";
        screenshots.push(postShot);
      }

      const [finalMouse, activeWindow] = await Promise.all([
        this.backend.getMousePosition(),
        this.backend.getActiveWindow ? this.backend.getActiveWindow().catch(() => null) : Promise.resolve(null),
      ]);
      this.lastObservedMouse = { ...finalMouse };

      let change: FrameDiff | null = null;
      if (verifyBaseline) {
        try {
          const after = await this.backend.captureScreen({ display: options.display });
          change = computeFrameDiff(verifyBaseline, after);
        } catch {
          change = null;
        }
      }

      const totalDurationMs = Math.round((performance.now() - chainStart) * 10) / 10;

      return {
        ok: true,
        stepsCompleted: receipts.length,
        totalDurationMs,
        mouse: finalMouse,
        activeWindow,
        receipts,
        screenshots,
        ...(verifyBaseline
          ? { change, changed: change !== null && change.changedPixels > 0 }
          : {}),
      };
    } catch (err) {
      await this.releaseHeldInputs();
      throw err;
    }
  }
}

/**
 * Parses a human/CLI chain expression like:
 *   `focus "Scratchpad" -> click 800 420 -> paste "Hello 🌍" -> key Enter`
 * OR JSON array `[{"type":"move","x":420,"y":260}, ...]` into ActionStep[].
 */
export function parseChainInput(input: string): ActionStep[] {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Empty action input.");
  }
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("JSON action input must be an array of steps.");
    }
    return parsed as ActionStep[];
  }
  if (trimmed.startsWith("{")) {
    return [JSON.parse(trimmed) as ActionStep];
  }

  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (quote) {
      if (ch === "\\" && i + 1 < trimmed.length) {
        current += ch + trimmed[i + 1]!;
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ";") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }
    if (ch === "-" && trimmed[i + 1] === ">") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      i++;
      continue;
    }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());

  const tokenize = (seg: string): string[] => {
    const out: string[] = [];
    let tok = "";
    let q: '"' | "'" | null = null;
    for (let i = 0; i < seg.length; i++) {
      const ch = seg[i]!;
      if (q) {
        if (ch === "\\" && i + 1 < seg.length) {
          const next = seg[i + 1]!;
          tok += next === "n" ? "\n" : next === "t" ? "\t" : next;
          i++;
          continue;
        }
        if (ch === q) {
          q = null;
          continue;
        }
        tok += ch;
        continue;
      }
      if (ch === '"' || ch === "'") {
        q = ch;
        continue;
      }
      if (/\s/.test(ch)) {
        if (tok.length > 0) {
          out.push(tok);
          tok = "";
        }
        continue;
      }
      tok += ch;
    }
    if (tok.length > 0) out.push(tok);
    return out;
  };

  return segments.map((seg): ActionStep => {
    const tokens = tokenize(seg);
    const cmd = (tokens[0] ?? "").toLowerCase();
    const parseCoords = (a?: string, b?: string): [number, number] | null => {
      if (a && a.includes(",") && b === undefined) {
        const [xs, ys] = a.split(",");
        const x = Number(xs);
        const y = Number(ys);
        if (!Number.isNaN(x) && !Number.isNaN(y)) return [x, y];
      }
      if (a !== undefined && b !== undefined) {
        const x = Number(a);
        const y = Number(b);
        if (!Number.isNaN(x) && !Number.isNaN(y)) return [x, y];
      }
      return null;
    };

    switch (cmd) {
      case "move": {
        const coords = parseCoords(tokens[1], tokens[2]);
        if (!coords) throw new Error(`Invalid move step "${seg}". Expected: move <x> <y>`);
        return { type: "move", x: coords[0], y: coords[1] };
      }
      case "click": {
        const coords = parseCoords(tokens[1], tokens[2]);
        return coords ? { type: "click", x: coords[0], y: coords[1] } : { type: "click" };
      }
      case "double_click":
      case "doubleclick":
      case "dblclick": {
        const coords = parseCoords(tokens[1], tokens[2]);
        return coords ? { type: "double_click", x: coords[0], y: coords[1] } : { type: "double_click" };
      }
      case "triple_click":
      case "tripleclick": {
        const coords = parseCoords(tokens[1], tokens[2]);
        return coords ? { type: "triple_click", x: coords[0], y: coords[1] } : { type: "triple_click" };
      }
      case "right_click":
      case "rightclick":
      case "rclick": {
        const coords = parseCoords(tokens[1], tokens[2]);
        return coords ? { type: "right_click", x: coords[0], y: coords[1] } : { type: "right_click" };
      }
      case "drag": {
        if (tokens.length >= 5) {
          return {
            type: "drag",
            fromX: Number(tokens[1]),
            fromY: Number(tokens[2]),
            toX: Number(tokens[3]),
            toY: Number(tokens[4]),
          };
        }
        const coords = parseCoords(tokens[1], tokens[2]);
        if (!coords) throw new Error(`Invalid drag step "${seg}". Expected: drag [fromX fromY] <toX> <toY>`);
        return { type: "drag", toX: coords[0], toY: coords[1] };
      }
      case "scroll": {
        const dir = tokens[1]?.toLowerCase();
        if (dir === "up" || dir === "down" || dir === "left" || dir === "right") {
          const amount = tokens[2] ? Number(tokens[2]) : 3;
          return { type: "scroll", direction: dir, amount };
        }
        const coords = parseCoords(tokens[1], tokens[2]);
        if (coords) return { type: "scroll", deltaX: coords[0], deltaY: coords[1] };
        throw new Error(`Invalid scroll step "${seg}". Expected: scroll <up|down|left|right> [amount]`);
      }
      case "type": {
        const rawAfterCmd = seg.replace(/^type\s+/i, "");
        const text =
          (rawAfterCmd.startsWith('"') && rawAfterCmd.endsWith('"')) ||
          (rawAfterCmd.startsWith("'") && rawAfterCmd.endsWith("'"))
            ? (tokens[1] ?? "")
            : rawAfterCmd;
        return { type: "type", text };
      }
      case "paste": {
        const rawAfterCmd = seg.replace(/^paste\s+/i, "");
        const text =
          (rawAfterCmd.startsWith('"') && rawAfterCmd.endsWith('"')) ||
          (rawAfterCmd.startsWith("'") && rawAfterCmd.endsWith("'"))
            ? (tokens[1] ?? "")
            : rawAfterCmd;
        return { type: "paste", text };
      }
      case "key":
      case "press": {
        if (!tokens[1]) throw new Error(`Invalid key step "${seg}". Expected: key <KeyOrChord>`);
        return { type: "key", key: tokens[1] };
      }
      case "focus":
      case "focus_window": {
        const title = tokens.slice(1).join(" ").trim();
        if (!title) throw new Error(`Invalid focus_window step "${seg}". Expected: focus <WindowTitle>`);
        return { type: "focus_window", title };
      }
      case "wait":
      case "sleep": {
        const ms = Number(tokens[1] ?? 0);
        if (Number.isNaN(ms) || ms < 0) throw new Error(`Invalid wait step "${seg}". Expected: wait <ms>`);
        return { type: "wait", ms };
      }
      case "wait_for_change": {
        const timeoutMs = tokens[1] ? Number(tokens[1]) : undefined;
        return { type: "wait_for_change", timeoutMs };
      }
      case "wait_for_settled": {
        const timeoutMs = tokens[1] ? Number(tokens[1]) : undefined;
        const quietMs = tokens[2] ? Number(tokens[2]) : undefined;
        return { type: "wait_for_settled", timeoutMs, quietMs };
      }
      case "wait_for_color": {
        const x = Number(tokens[1]);
        const y = Number(tokens[2]);
        const color = tokens[3];
        if (
          Number.isNaN(x) ||
          Number.isNaN(y) ||
          !color ||
          !/^#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)
        ) {
          throw new Error(
            `Invalid wait_for_color step "${seg}". Expected: wait_for_color <x> <y> <#rrggbb> [timeoutMs] [tolerance]`,
          );
        }
        const timeoutMs = tokens[4] ? Number(tokens[4]) : undefined;
        const tolerance = tokens[5] ? Number(tokens[5]) : undefined;
        return { type: "wait_for_color", x, y, color, timeoutMs, tolerance };
      }
      case "screenshot":
      case "see":
        return { type: "screenshot" };
      default:
        throw new Error(
          `Unknown step "${cmd}" in "${seg}". Supported steps: move, click, double_click, triple_click, right_click, drag, scroll, type, paste, key, focus_window, wait, wait_for_change, wait_for_settled, wait_for_color, screenshot.`,
        );
    }
  });
}
