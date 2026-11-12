import { PermissionStore } from "./permissions.js";
import type { ActionStep, ActOptions, ActResult, DesktopBackend, DisplayInfo, DoctorCheck, Point, SeeOptions, SeeResult, TrailMarker, WindowInfo } from "./types.js";
export declare class HandyController {
    readonly backend: DesktopBackend;
    readonly permissions: PermissionStore;
    private readonly heldButtons;
    private readonly heldKeys;
    private queueTail;
    private queuedCount;
    private lastSeenFrame;
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
