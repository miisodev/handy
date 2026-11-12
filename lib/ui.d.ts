import { type Server } from "node:http";
import { type BackendKind } from "./backends/index.js";
import { HandyController } from "./controller.js";
import { PermissionStore } from "./permissions.js";
export interface StartControlPanelOptions {
    port?: number;
    host?: string;
    controller?: HandyController;
    backendKind?: BackendKind | string;
    permissions?: PermissionStore;
}
export interface RunningControlPanel {
    url: string;
    port: number;
    host: string;
    token: string;
    controller: HandyController;
    server: Server;
    close: () => Promise<void>;
}
export declare function startControlPanel(options?: StartControlPanelOptions): Promise<RunningControlPanel>;
