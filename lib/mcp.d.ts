import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type BackendKind } from "./backends/index.js";
import { HandyController } from "./controller.js";
import { PermissionStore } from "./permissions.js";
import { type DesktopBackend } from "./types.js";
export interface CreateHandyMcpOptions {
    controller?: HandyController;
    backend?: DesktopBackend;
    backendKind?: BackendKind | string;
    permissions?: PermissionStore;
    logToStderr?: boolean;
}
export declare function createHandyMcpServer(options?: CreateHandyMcpOptions): {
    server: McpServer;
    controller: HandyController;
    dispose: () => Promise<void>;
};
export declare function runStdioMcpServer(options?: CreateHandyMcpOptions): Promise<void>;
