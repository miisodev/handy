import { PermissionStore } from "./permissions.js";
import type { ActionStep, ActOptions, ActResult, DesktopBackend, DisplayInfo, DoctorCheck, Point, SeeOptions, SeeResult, TrailMarker, UiElement, WindowInfo } from "./types.js";
/**
 * Fitts's-law pointer travel time: `a + b * log2(D/W + 1)`.
 *
 * Real users take longer to reach small, distant targets. Using that curve for `motion: "human"`
 * produces plausible velocities instead of a constant-speed teleport, which matters for apps that
 * gate behaviour on pointer dynamics (hover intent, drag thresholds, gesture recognisers).
 */
export declare function fittsDurationMs(from: Point, to: Point, targetWidth?: number, a?: number, b?: number): number;
export declare class HandyController {
    readonly backend: DesktopBackend;
    readonly permissions: PermissionStore;
    private readonly heldButtons;
    private readonly heldKeys;
    private queueTail;
    private queuedCount;
    private lastSeenFrame;
    private lastElements;
    private lastObservedMouse;
    private lastCommandedTarget;
    private static readonly MAX_QUEUED_CHAINS;
    constructor(options: {
        backend: DesktopBackend;
        permissions?: PermissionStore;
    });
    init(): Promise<void>;
    close(): Promise<void>;
    releaseHeldInputs(): Promise<void>;
    status(): Promise<{
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
    }>;
    doctor(): Promise<{
        permission: ReturnType<PermissionStore["getState"]>;
        backend: string;
        checks: DoctorCheck[];
    }>;
    listWindows(): Promise<WindowInfo[]>;
    getActiveWindow(): Promise<WindowInfo | null>;
    focusWindow(query: {
        title?: string;
        app?: string;
        id?: string | number;
    }): Promise<{
        focused: boolean;
        activeWindow: WindowInfo | null;
    }>;
    readClipboard(): Promise<string>;
    writeClipboard(text: string): Promise<void>;
    private resolveWindowRegion;
    see(options?: SeeOptions & {
        trail?: TrailMarker[];
    }): Promise<SeeResult>;
    act(options: ActOptions): Promise<ActResult>;
    private checkFailsafe;
    private commandMoveMouse;
    /** Most recent Set-of-Mark elements, cleared whenever a capture runs without `marks`. */
    get detectedElements(): UiElement[] | null;
    /**
     * Resolves a mark index to a point, detecting elements from the current screen when no marked
     * capture has happened in this process yet.
     *
     * Marks live on the controller instance, and every CLI invocation is a fresh process — so
     * without this, `handy see --marks` followed by `handy act 'click mark 5'` could never work:
     * the second command would have nothing to resolve against. Detecting on demand makes a mark
     * reference self-sufficient from every entry point (CLI, MCP, library) with no persisted state
     * to go stale, and the indices then describe the screen as it is *now*, which is the only
     * meaning they can safely have.
     *
     * This captures and detects directly rather than calling `see()`, skipping the overlay render
     * and PNG encode that a detection-only pass would otherwise pay for.
     */
    private resolveMarkPoint;
    /**
     * Resolves where a pointer step should go: an explicit `mark`, then explicit coordinates, then
     * "wherever the cursor already is". `via` lets receipts record which route was taken.
     */
    private resolveStepTarget;
    private resolvePoint;
    private interpolateMove;
    private performClick;
    private executeChainInternal;
}
/**
 * Parses a human/CLI chain expression like:
 *   `focus "Scratchpad" -> click 800 420 -> paste "Hello 🌍" -> key Enter`
 * OR JSON array `[{"type":"move","x":420,"y":260}, ...]` into ActionStep[].
 */
export declare function parseChainInput(input: string): ActionStep[];
