import { PermissionStore } from "./permissions.js";
import type { ActionStep, ActOptions, ActResult, DesktopBackend, DisplayInfo, DoctorCheck, Point, SeeOptions, SeeResult } from "./types.js";
export declare class HandyController {
    readonly backend: DesktopBackend;
    readonly permissions: PermissionStore;
    private readonly heldButtons;
    private readonly heldKeys;
    private queueTail;
    private queuedCount;
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
    }>;
    doctor(): Promise<{
        permission: ReturnType<PermissionStore["getState"]>;
        backend: string;
        checks: DoctorCheck[];
    }>;
    see(options?: SeeOptions): Promise<SeeResult>;
    act(options: ActOptions): Promise<ActResult>;
    private resolvePoint;
    private interpolateMove;
    private performClick;
    private executeChainInternal;
}
/**
 * Parses a human/CLI chain expression like:
 *   `move 420 260 -> click -> type "Sam" -> key Enter`
 * OR JSON array `[{"type":"move","x":420,"y":260}, ...]` into validated ActionStep[].
 */
export declare function parseChainInput(input: string): ActionStep[];
