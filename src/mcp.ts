import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createBackend, type BackendKind } from "./backends/index.js";
import { HandyController } from "./controller.js";
import { HandyPermissionError, PermissionStore } from "./permissions.js";
import { ActionStepSchema, RegionSchema, type DesktopBackend } from "./types.js";
import { HANDY_NAME, HANDY_VERSION } from "./version.js";

export interface CreateHandyMcpOptions {
  controller?: HandyController;
  backend?: DesktopBackend;
  backendKind?: BackendKind | string;
  permissions?: PermissionStore;
  logToStderr?: boolean;
}

function logAudit(enabled: boolean, event: Record<string, unknown>): void {
  if (!enabled) return;
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
}

function formatToolError(err: unknown): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
  if (err instanceof HandyPermissionError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: false,
              error: err.code,
              message: err.message,
              permission: err.state,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ ok: false, error: "HANDY_ERROR", message }, null, 2),
      },
    ],
  };
}

export function createHandyMcpServer(options: CreateHandyMcpOptions = {}): {
  server: McpServer;
  controller: HandyController;
  dispose: () => Promise<void>;
} {
  const permissions = options.permissions ?? new PermissionStore();
  const backend = options.backend ?? createBackend({ kind: options.backendKind });
  const controller = options.controller ?? new HandyController({ backend, permissions });
  const auditEnabled = options.logToStderr ?? process.env.HANDY_LOG === "1";

  const server = new McpServer(
    {
      name: HANDY_NAME,
      version: HANDY_VERSION,
    },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: {},
      },
      instructions:
        "Handy provides real-time computer screen vision with mapped (x, y) coordinates and live mouse reticle (`handy_see`), plus real-time native mouse and keyboard control supporting chained multi-step actions (`handy_act`). Always call `handy_see` to read exact screen coordinates before clicking unfamiliar UI elements, and chain related steps (e.g. move -> click -> type) in a single `handy_act` call.",
    },
  );

  // Watch permissions file so external `handy on` / `handy off` notifies connected MCP hosts
  const stopWatch = controller.permissions.watch((state) => {
    logAudit(auditEnabled, { type: "permission_changed", enabled: state.enabled, mode: state.mode });
    if (server.isConnected()) {
      server.sendToolListChanged();
      server.sendResourceListChanged();
    }
  });

  // 1. handy_see — Real-time screen capture with mapped coordinates & mouse position
  server.registerTool(
    "handy_see",
    {
      title: "See Computer Screen (Mapped Coordinates + Mouse)",
      description:
        "Capture the computer screen in real-time with mapped (x, y) coordinate rulers, grid labels, and a high-contrast reticle marking the live mouse position. Use `region` to zoom into dense UI areas at 1:1 resolution while preserving global screen coordinates.",
      inputSchema: {
        display: z.number().int().min(0).max(16).optional().describe("Monitor index (default: 0 primary)"),
        region: RegionSchema.optional().describe("Optional screen rectangle { x, y, width, height } to zoom into"),
        grid: z.boolean().optional().describe("Overlay mapped coordinate rulers and grid (default: true)"),
        gridStep: z
          .number()
          .int()
          .min(10)
          .max(2000)
          .optional()
          .describe("Custom major grid spacing in screen pixels"),
        showMouse: z.boolean().optional().describe("Overlay live mouse reticle and (x, y) badge (default: true)"),
        maxWidth: z
          .number()
          .int()
          .min(320)
          .max(3840)
          .optional()
          .describe("Max output image width in pixels (default: 1280); drawn coordinates remain exact screen pixels"),
      },
      annotations: {
        title: "See Screen",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      const t0 = performance.now();
      try {
        const shot = await controller.see({
          display: args.display,
          region: args.region,
          grid: args.grid,
          gridStep: args.gridStep,
          showMouse: args.showMouse,
          maxWidth: args.maxWidth,
        });

        const metadata = {
          ok: true,
          mouse: shot.mouse,
          screen: shot.screen,
          region: shot.region,
          imageSize: { width: shot.imageWidth, height: shot.imageHeight },
          gridStep: shot.gridStep,
          coordinateSpace: shot.coordinateSpace,
          captureMs: shot.captureMs,
          timestamp: shot.timestamp,
        };

        logAudit(auditEnabled, {
          tool: "handy_see",
          ok: true,
          latencyMs: Math.round(performance.now() - t0),
          mouse: shot.mouse,
          region: shot.region,
        });

        return {
          content: [
            {
              type: "image" as const,
              data: shot.base64Png,
              mimeType: "image/png",
            },
            {
              type: "text" as const,
              text: JSON.stringify(metadata, null, 2),
            },
          ],
        };
      } catch (err) {
        logAudit(auditEnabled, {
          tool: "handy_see",
          ok: false,
          latencyMs: Math.round(performance.now() - t0),
          error: err instanceof Error ? err.message : String(err),
        });
        return formatToolError(err);
      }
    },
  );

  // 2. handy_act — Real-time chained mouse & keyboard control
  server.registerTool(
    "handy_act",
    {
      title: "Control Mouse & Keyboard (Single or Chained)",
      description:
        'Execute native mouse and keyboard controls in real-time. Supports chaining multiple steps sequentially in one call — for example: [{ "type": "move", "x": 420, "y": 260 }, { "type": "click" }, { "type": "type", "text": "Sam" }]. Set `screenshotAfter: true` to receive an updated coordinate-mapped screenshot immediately after the chain finishes.',
      inputSchema: {
        actions: z
          .array(ActionStepSchema)
          .min(1)
          .max(100)
          .describe("Ordered array of mouse/keyboard/wait/screenshot steps to execute sequentially"),
        stepDelayMs: z
          .number()
          .min(0)
          .max(5000)
          .optional()
          .describe("Settling delay in ms between steps so native UI focus updates reliably (default: 15)"),
        screenshotAfter: z
          .boolean()
          .optional()
          .describe("Capture and return an annotated screen image after the chain completes (default: false)"),
        settleMs: z
          .number()
          .min(0)
          .max(5000)
          .optional()
          .describe("Wait in ms before taking screenshotAfter (default: 50)"),
        display: z
          .number()
          .int()
          .min(0)
          .max(16)
          .optional()
          .describe("Target display index for normalized coordinates or screenshotAfter"),
        maxWidth: z.number().int().min(320).max(3840).optional(),
        grid: z.boolean().optional(),
        showMouse: z.boolean().optional(),
      },
      annotations: {
        title: "Execute Mouse & Keyboard Actions",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra) => {
      const t0 = performance.now();
      try {
        const result = await controller.act({
          actions: args.actions,
          stepDelayMs: args.stepDelayMs,
          screenshotAfter: args.screenshotAfter,
          settleMs: args.settleMs,
          display: args.display,
          maxWidth: args.maxWidth,
          grid: args.grid,
          showMouse: args.showMouse,
          signal: extra.signal,
        });

        const summary = {
          ok: true,
          stepsCompleted: result.stepsCompleted,
          totalDurationMs: result.totalDurationMs,
          mouse: result.mouse,
          receipts: result.receipts,
        };

        // Redact raw typed strings in audit log — receipts only carry char counts
        logAudit(auditEnabled, {
          tool: "handy_act",
          ok: true,
          stepsCompleted: result.stepsCompleted,
          latencyMs: Math.round(performance.now() - t0),
          stepTypes: args.actions.map((a) => a.type),
        });

        const content: Array<
          { type: "text"; text: string } | { type: "image"; data: string; mimeType: "image/png" }
        > = [
          {
            type: "text",
            text: JSON.stringify(summary, null, 2),
          },
        ];

        for (const shot of result.screenshots) {
          content.push({
            type: "image",
            data: shot.base64Png,
            mimeType: "image/png",
          });
        }

        return { content };
      } catch (err) {
        logAudit(auditEnabled, {
          tool: "handy_act",
          ok: false,
          latencyMs: Math.round(performance.now() - t0),
          error: err instanceof Error ? err.message : String(err),
        });
        return formatToolError(err);
      }
    },
  );

  // 3. handy_status — Live permission toggle status, displays & cursor info
  server.registerTool(
    "handy_status",
    {
      title: "Check Handy Status & Permission Toggle",
      description:
        "Check whether Handy permission is currently ON or OFF, which native OS backend is active, connected monitor dimensions, and current mouse position (when enabled).",
      inputSchema: {},
      annotations: {
        title: "Handy Status",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const info = await controller.status();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(info, null, 2),
            },
          ],
        };
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  // 4. handy_permission — Permission status or one-way safe disable from MCP
  server.registerTool(
    "handy_permission",
    {
      title: "Handy Permission Control (On/Off Toggle)",
      description:
        "Inspect or turn OFF Handy computer control permissions. Turning Handy OFF (`action: 'off'`) immediately disables screen capture and mouse/keyboard control and releases any held inputs. When disabled by the user, re-enabling requires running `handy on` (or `/handy:on`) unless HANDY_ALLOW_MCP_ENABLE=true.",
      inputSchema: {
        action: z
          .enum(["status", "off", "on"])
          .describe("'status' to read current state, 'off' to immediately disable Handy, 'on' (only if allowed)"),
        mode: z.enum(["full", "view_only"]).optional().describe("Optional mode when enabling: full or view_only"),
      },
      annotations: {
        title: "Handy Permission Toggle",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        if (args.action === "status") {
          const state = controller.permissions.getState();
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ ok: true, permission: state }, null, 2) }],
          };
        }

        if (args.action === "off") {
          await controller.releaseHeldInputs();
          const state = controller.permissions.setEnabled(false, { updatedBy: "mcp" });
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ ok: true, permission: state }, null, 2) }],
          };
        }

        const state = controller.permissions.setEnabled(true, {
          mode: args.mode,
          updatedBy: "mcp",
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: true, permission: state }, null, 2) }],
        };
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  // Resources
  server.registerResource(
    "handy-status",
    "handy://status",
    {
      title: "Handy Status & Permissions",
      description: "Live JSON state of Handy permission toggle, OS backend, and displays.",
      mimeType: "application/json",
    },
    async (uri) => {
      const info = await controller.status();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(info, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "handy-current-screen",
    "handy://screen/current",
    {
      title: "Current Annotated Computer Screen",
      description: "Real-time PNG screenshot with mapped coordinates and live mouse position (requires Handy ON).",
      mimeType: "image/png",
    },
    async (uri) => {
      const shot = await controller.see({ grid: true, showMouse: true });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "image/png",
            blob: shot.base64Png,
          },
        ],
      };
    },
  );

  // Prompt
  server.registerPrompt(
    "computer-control",
    {
      title: "Handy Real-Time Computer Control Workflow",
      description: "Guide an LLM through accurate coordinate-mapped screen reading and chained mouse/keyboard control.",
      argsSchema: {
        goal: z.string().optional().describe("Task to perform on the user's computer"),
      },
    },
    async ({ goal }) => {
      const taskLine = goal ? `Target task: ${goal}\n\n` : "";
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `${taskLine}Use Handy to complete this task safely and accurately:\n` +
                `1. Call \`handy_see\` first to inspect the live screen. Read the exact (x, y) pixel coordinates from the top/left rulers and interior grid badges, and note the red \`MOUSE (x,y)\` reticle.\n` +
                `2. For small icons or dense UI controls, call \`handy_see\` with \`region: { x, y, width, height }\` to inspect at 1:1 resolution with global screen coordinates.\n` +
                `3. Chain sequential interactions in a single \`handy_act\` call (for example: move -> click -> type -> key Enter) with \`screenshotAfter: true\` so you can verify the UI change in one round-trip.\n` +
                `4. Use \`mod+<key>\` (e.g. \`mod+a\`, \`mod+c\`, \`mod+v\`) for cross-platform shortcuts (maps to Cmd on macOS, Ctrl on Windows/Linux).\n` +
                `5. Respect the user's permission toggle; if Handy is OFF, ask the user to run \`handy on\` or \`/handy:on\`. Confirm with the user before irreversible actions (deleting files, sending messages, or completing purchases).`,
            },
          },
        ],
      };
    },
  );

  const dispose = async () => {
    stopWatch();
    await controller.close();
    await server.close();
  };

  return { server, controller, dispose };
}

export async function runStdioMcpServer(options: CreateHandyMcpOptions = {}): Promise<void> {
  // MCP-04: Guarantee zero accidental diagnostic output on stdout during stdio transport
  const writeStderr = (...args: unknown[]) => {
    const formatted = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    process.stderr.write(`${formatted}\n`);
  };
  console.log = writeStderr;
  console.info = writeStderr;
  console.debug = writeStderr;
  console.warn = writeStderr;

  const { server, dispose } = createHandyMcpServer(options);
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await dispose();
    } catch {
      // ignore shutdown cleanup errors
    }
    process.exit(exitCode);
  };

  process.stdin.on("end", () => {
    void shutdown(0);
  });
  process.stdin.on("close", () => {
    void shutdown(0);
  });
  process.on("SIGINT", () => {
    void shutdown(0);
  });
  process.on("SIGTERM", () => {
    void shutdown(0);
  });

  await server.connect(transport);
}
