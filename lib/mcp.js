import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createBackend } from "./backends/index.js";
import { HandyController } from "./controller.js";
import { HandyPermissionError, PermissionStore } from "./permissions.js";
import { ActionStepSchema, RegionSchema, UiElementKindSchema, } from "./types.js";
import { HANDY_NAME, HANDY_VERSION } from "./version.js";
function logAudit(enabled, event) {
    if (!enabled)
        return;
    process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
}
function formatToolError(err) {
    if (err instanceof HandyPermissionError) {
        return {
            isError: true,
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        ok: false,
                        error: err.code,
                        message: err.message,
                        permission: err.state,
                    }, null, 2),
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
export function createHandyMcpServer(options = {}) {
    const permissions = options.permissions ?? new PermissionStore();
    const backend = options.backend ?? createBackend({ kind: options.backendKind });
    const controller = options.controller ?? new HandyController({ backend, permissions });
    const auditEnabled = options.logToStderr ?? process.env.HANDY_LOG === "1";
    const server = new McpServer({
        name: HANDY_NAME,
        version: HANDY_VERSION,
    }, {
        capabilities: {
            tools: { listChanged: true },
            resources: { listChanged: true },
            prompts: {},
        },
        instructions: "Handy provides real-time computer screen vision with mapped (x, y) coordinates, window-scoped capture (`window`), active window metadata, pixel-under-cursor color, and frame-to-frame visual diffs (`handy_see`), plus real-time native mouse, keyboard, clipboard, and window control supporting chained multi-step actions and window-relative coordinates (`handy_act`, `handy_windows`, `handy_clipboard`). Always call `handy_see` before clicking unfamiliar UI elements, prefer `paste` for long or multi-line text, use `wait_for_change` / `wait_for_settled` / `wait_for_color` instead of blind sleeps, and chain sequential steps in a single `handy_act` call.",
    });
    // Watch permissions file so external `handy on` / `handy off` / `handy ui` notifies connected MCP hosts
    const stopWatch = controller.permissions.watch((state) => {
        logAudit(auditEnabled, { type: "permission_changed", enabled: state.enabled, mode: state.mode });
        if (server.isConnected()) {
            server.sendToolListChanged();
            server.sendResourceListChanged();
        }
    });
    // 1. handy_see — Real-time screen capture with mapped coordinates, mouse reticle, active window & frame diff
    server.registerTool("handy_see", {
        title: "See Computer Screen (Mapped Coordinates + Window Zoom + Diff)",
        description: "Capture the computer screen (or a single desktop window via `window`) in real-time with mapped (x, y) coordinate rulers, dual-contrast grid labels, live mouse reticle, hex color under cursor, active window info, and visual diff since the previous capture (`changedPercent`, `changedBounds`). Use `region` or `window` to zoom into dense UI areas at 1:1 resolution while preserving global screen coordinates, and set `highlightDiff: true` to outline changed pixels. Set `marks: true` to run Set-of-Mark UI element detection: Handy outlines and numbers every detected button, field, icon, text line, and panel, and returns their exact bounds and click centres in `elements` — then act on one with `{ \"type\": \"click\", \"mark\": 3 }` instead of estimating coordinates.",
        inputSchema: {
            display: z.number().int().min(0).max(16).optional().describe("Monitor index (default: 0 primary)"),
            region: RegionSchema.optional().describe("Optional screen rectangle { x, y, width, height } to zoom into"),
            window: z
                .string()
                .min(1)
                .max(500)
                .optional()
                .describe("Optional window title or app substring to capture at 1:1 resolution while keeping global coordinates"),
            grid: z.boolean().optional().describe("Overlay mapped coordinate rulers and grid (default: true)"),
            gridStep: z
                .number()
                .int()
                .min(10)
                .max(2000)
                .optional()
                .describe("Custom major grid spacing in screen pixels"),
            showMouse: z.boolean().optional().describe("Overlay live mouse reticle and (x, y) badge (default: true)"),
            highlightDiff: z
                .boolean()
                .optional()
                .describe("Draw an emerald CHANGED bounding box around pixels that changed since the previous capture"),
            maxWidth: z
                .number()
                .int()
                .min(320)
                .max(3840)
                .optional()
                .describe("Max output image width in pixels (default: 1280); drawn coordinates remain exact screen pixels"),
            marks: z
                .boolean()
                .optional()
                .describe("Run Set-of-Mark UI element detection: outline and number detected controls/fields/icons/text/panels on the image and return their exact bounds and click centres in `elements` (default: false)"),
            maxMarks: z
                .number()
                .int()
                .min(1)
                .max(200)
                .optional()
                .describe("Maximum number of element marks to return when `marks` is true (default: 40)"),
            markKinds: z
                .array(UiElementKindSchema)
                .optional()
                .describe("Restrict marks to specific kinds: control, text, icon, region (default: all)"),
            minMarkScore: z
                .number()
                .min(0)
                .max(1)
                .optional()
                .describe("Minimum detection confidence 0..1 for a mark to be kept (default: 0.3)"),
        },
        annotations: {
            title: "See Screen",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    }, async (args) => {
        const t0 = performance.now();
        try {
            const shot = await controller.see({
                display: args.display,
                region: args.region,
                window: args.window,
                grid: args.grid,
                gridStep: args.gridStep,
                showMouse: args.showMouse,
                highlightDiff: args.highlightDiff,
                maxWidth: args.maxWidth,
                marks: args.marks,
                maxMarks: args.maxMarks,
                markKinds: args.markKinds,
                minMarkScore: args.minMarkScore,
            });
            const metadata = {
                ok: true,
                mouse: shot.mouse,
                pixelUnderMouse: shot.pixelUnderMouse,
                activeWindow: shot.activeWindow,
                screenDiff: shot.screenDiff,
                screen: shot.screen,
                region: shot.region,
                imageSize: { width: shot.imageWidth, height: shot.imageHeight },
                gridStep: shot.gridStep,
                coordinateSpace: shot.coordinateSpace,
                captureMs: shot.captureMs,
                timestamp: shot.timestamp,
                ...(shot.elements
                    ? {
                        elementCount: shot.elements.length,
                        elements: shot.elements,
                        elementHint: "Click any element by index without restating coordinates, e.g. { \"type\": \"click\", \"mark\": 3 }. Marks are only valid until the screen changes; re-run handy_see with marks: true after any interaction that mutates the UI.",
                    }
                    : {}),
                // Detection degrades rather than fails the capture, so say why and what to do instead
                // — otherwise an agent sees no `elements` and cannot tell "nothing detected" from
                // "detection broke", nor know that `mark` references are unavailable this round.
                ...(shot.marksError
                    ? {
                        marksError: shot.marksError,
                        marksHint: "UI element detection failed, so this capture has no marks and `mark` references will be rejected. The screenshot is still valid: read (x, y) from the coordinate rulers and pass explicit coordinates instead.",
                    }
                    : {}),
            };
            logAudit(auditEnabled, {
                tool: "handy_see",
                ok: true,
                latencyMs: Math.round(performance.now() - t0),
                mouse: shot.mouse,
                region: shot.region,
                changedPercent: shot.screenDiff?.changedPercent,
            });
            return {
                content: [
                    {
                        type: "image",
                        data: shot.base64Png,
                        mimeType: "image/png",
                    },
                    {
                        type: "text",
                        text: JSON.stringify(metadata, null, 2),
                    },
                ],
            };
        }
        catch (err) {
            logAudit(auditEnabled, {
                tool: "handy_see",
                ok: false,
                latencyMs: Math.round(performance.now() - t0),
                error: err instanceof Error ? err.message : String(err),
            });
            return formatToolError(err);
        }
    });
    // 2. handy_act — Real-time chained mouse, keyboard, paste, focus & smart-wait control
    server.registerTool("handy_act", {
        title: "Control Mouse & Keyboard (Single or Chained)",
        description: 'Execute native mouse, keyboard, clipboard-paste, window-focus, and smart visual-wait controls in real-time. Supports chaining multiple steps sequentially in one call — e.g. [{ "type": "focus_window", "title": "Code" }, { "type": "click", "x": 420, "y": 260 }, { "type": "paste", "text": "Hello!" }, { "type": "wait_for_settled" }]. Steps support `coordinateSpace: "screen" | "normalized" | "window"`, and any pointer step accepts `mark: N` to target a detected UI element from the last `handy_see({ marks: true })` instead of raw x/y. Set `screenshotAfter: true` to receive an updated coordinate-mapped screenshot with numbered action-trail markers, or `verifyChange: true` for a cheap did-anything-happen diff.',
        inputSchema: {
            actions: z
                .array(ActionStepSchema)
                .min(1)
                .max(100)
                .describe("Ordered array of steps (move, click, double_click, triple_click, right_click, drag, scroll, type, paste, key, focus_window, wait, wait_for_change, wait_for_settled, wait_for_color, screenshot)"),
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
            showTrail: z
                .boolean()
                .optional()
                .describe("Draw numbered amber markers (#1, #2, drag lines) on post-action screenshots (default: true)"),
            highlightDiff: z
                .boolean()
                .optional()
                .describe("Outline changed pixels since the previous capture on post-action screenshots (default: false)"),
            failsafe: z
                .boolean()
                .optional()
                .describe("Abort immediately if a human slams the cursor to the top-left (0,0) corner (default: true)"),
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
            marks: z
                .boolean()
                .optional()
                .describe("Run Set-of-Mark element detection on post-chain/mid-chain screenshots and return `elements`"),
            maxMarks: z.number().int().min(1).max(200).optional().describe("Max marks when `marks` is true (default: 40)"),
            verifyChange: z
                .boolean()
                .optional()
                .describe("Capture before and after the chain and report `change`/`changed` so you learn whether anything visually moved without requesting an image (default: false)"),
        },
        annotations: {
            title: "Execute Mouse & Keyboard Actions",
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true,
        },
    }, async (args, extra) => {
        const t0 = performance.now();
        try {
            const result = await controller.act({
                actions: args.actions,
                stepDelayMs: args.stepDelayMs,
                screenshotAfter: args.screenshotAfter,
                showTrail: args.showTrail,
                highlightDiff: args.highlightDiff,
                failsafe: args.failsafe,
                settleMs: args.settleMs,
                display: args.display,
                maxWidth: args.maxWidth,
                grid: args.grid,
                showMouse: args.showMouse,
                marks: args.marks,
                maxMarks: args.maxMarks,
                verifyChange: args.verifyChange,
                signal: extra.signal,
            });
            const summary = {
                ok: true,
                stepsCompleted: result.stepsCompleted,
                totalDurationMs: result.totalDurationMs,
                mouse: result.mouse,
                activeWindow: result.activeWindow,
                receipts: result.receipts,
                ...(result.change !== undefined || result.changed !== undefined
                    ? {
                        changed: result.changed,
                        change: result.change,
                        ...(result.changed === false
                            ? {
                                hint: "No visual change was detected. Verify the target coordinates/mark, that the intended window was focused, and that the control is enabled.",
                            }
                            : {}),
                    }
                    : {}),
            };
            logAudit(auditEnabled, {
                tool: "handy_act",
                ok: true,
                stepsCompleted: result.stepsCompleted,
                latencyMs: Math.round(performance.now() - t0),
                stepTypes: args.actions.map((a) => a.type),
            });
            const content = [
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
        }
        catch (err) {
            logAudit(auditEnabled, {
                tool: "handy_act",
                ok: false,
                latencyMs: Math.round(performance.now() - t0),
                error: err instanceof Error ? err.message : String(err),
            });
            return formatToolError(err);
        }
    });
    // 3. handy_windows — Inspect open windows with screen bounds or bring a target window to front
    server.registerTool("handy_windows", {
        title: "List or Focus Desktop Windows",
        description: "List visible desktop windows with their titles, owning apps, screen bounds `{ x, y, width, height }`, and focused state (`action: 'list'`), or bring a specific window to the foreground (`action: 'focus'`).",
        inputSchema: {
            action: z.enum(["list", "focus"]).describe("'list' to inspect visible windows or 'focus' to activate one"),
            title: z.string().max(500).optional().describe("Case-insensitive window title substring when focusing"),
            app: z.string().max(500).optional().describe("Case-insensitive application name substring when focusing"),
            id: z.union([z.string(), z.number()]).optional().describe("Exact window ID from handy_windows list"),
        },
        annotations: {
            title: "Desktop Windows",
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    }, async (args) => {
        const t0 = performance.now();
        try {
            if (args.action === "list") {
                const windows = await controller.listWindows();
                const activeWindow = windows.find((w) => w.focused) ?? (await controller.getActiveWindow());
                logAudit(auditEnabled, {
                    tool: "handy_windows",
                    action: "list",
                    ok: true,
                    count: windows.length,
                    latencyMs: Math.round(performance.now() - t0),
                });
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ ok: true, count: windows.length, activeWindow, windows }, null, 2),
                        },
                    ],
                };
            }
            if (args.title === undefined && args.app === undefined && args.id === undefined) {
                throw new Error("Provide `title`, `app`, or `id` when `action` is 'focus'.");
            }
            const res = await controller.focusWindow({ title: args.title, app: args.app, id: args.id });
            logAudit(auditEnabled, {
                tool: "handy_windows",
                action: "focus",
                ok: res.focused,
                latencyMs: Math.round(performance.now() - t0),
            });
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ ok: res.focused, focused: res.focused, activeWindow: res.activeWindow }, null, 2),
                    },
                ],
            };
        }
        catch (err) {
            return formatToolError(err);
        }
    });
    // 4. handy_clipboard — Read or write OS clipboard text
    server.registerTool("handy_clipboard", {
        title: "Read or Write System Clipboard",
        description: "Read current plain-text clipboard contents (`action: 'read'`, works in `full` and `view_only` modes) or write Unicode text directly to the system clipboard (`action: 'write'`, requires `full` control mode).",
        inputSchema: {
            action: z.enum(["read", "write"]).describe("'read' clipboard text or 'write' text to clipboard"),
            text: z.string().max(100000).optional().describe("Text to copy to clipboard when action is 'write'"),
        },
        annotations: {
            title: "System Clipboard",
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    }, async (args) => {
        const t0 = performance.now();
        try {
            if (args.action === "read") {
                const text = await controller.readClipboard();
                // Never log raw clipboard text in audit output (MCP-19)
                logAudit(auditEnabled, {
                    tool: "handy_clipboard",
                    action: "read",
                    ok: true,
                    charCount: Array.from(text).length,
                    latencyMs: Math.round(performance.now() - t0),
                });
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ ok: true, length: Array.from(text).length, text }, null, 2),
                        },
                    ],
                };
            }
            const text = args.text ?? "";
            await controller.writeClipboard(text);
            logAudit(auditEnabled, {
                tool: "handy_clipboard",
                action: "write",
                ok: true,
                charCount: Array.from(text).length,
                latencyMs: Math.round(performance.now() - t0),
            });
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ ok: true, writtenChars: Array.from(text).length }, null, 2),
                    },
                ],
            };
        }
        catch (err) {
            return formatToolError(err);
        }
    });
    // 5. handy_status — Live permission toggle status, displays, active window & cursor info
    server.registerTool("handy_status", {
        title: "Check Handy Status & Permission Toggle",
        description: "Check whether Handy permission is currently ON or OFF, which native OS backend is active, connected monitor dimensions, active window, and current mouse position (when enabled).",
        inputSchema: {},
        annotations: {
            title: "Handy Status",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    }, async () => {
        try {
            const info = await controller.status();
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(info, null, 2),
                    },
                ],
            };
        }
        catch (err) {
            return formatToolError(err);
        }
    });
    // 6. handy_permission — Permission status or one-way safe disable from MCP
    server.registerTool("handy_permission", {
        title: "Handy Permission Control (On/Off Toggle)",
        description: "Inspect or turn OFF Handy computer control permissions. Turning Handy OFF (`action: 'off'`) immediately disables screen capture and mouse/keyboard control and releases any held inputs. When disabled by the user, re-enabling requires running `handy on` (or `/handy:on`) unless HANDY_ALLOW_MCP_ENABLE=true.",
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
    }, async (args) => {
        try {
            if (args.action === "status") {
                const state = controller.permissions.getState();
                return {
                    content: [{ type: "text", text: JSON.stringify({ ok: true, permission: state }, null, 2) }],
                };
            }
            if (args.action === "off") {
                await controller.releaseHeldInputs();
                const state = controller.permissions.setEnabled(false, { updatedBy: "mcp" });
                return {
                    content: [{ type: "text", text: JSON.stringify({ ok: true, permission: state }, null, 2) }],
                };
            }
            const state = controller.permissions.setEnabled(true, {
                mode: args.mode,
                updatedBy: "mcp",
            });
            return {
                content: [{ type: "text", text: JSON.stringify({ ok: true, permission: state }, null, 2) }],
            };
        }
        catch (err) {
            return formatToolError(err);
        }
    });
    // Resources
    server.registerResource("handy-status", "handy://status", {
        title: "Handy Status & Permissions",
        description: "Live JSON state of Handy permission toggle, OS backend, active window, and displays.",
        mimeType: "application/json",
    }, async (uri) => {
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
    });
    server.registerResource("handy-windows", "handy://windows", {
        title: "Open Desktop Windows",
        description: "Live list of visible desktop windows with titles, apps, and bounds (requires Handy ON).",
        mimeType: "application/json",
    }, async (uri) => {
        const windows = await controller.listWindows();
        return {
            contents: [
                {
                    uri: uri.href,
                    mimeType: "application/json",
                    text: JSON.stringify({ windows }, null, 2),
                },
            ],
        };
    });
    server.registerResource("handy-current-screen", "handy://screen/current", {
        title: "Current Annotated Computer Screen",
        description: "Real-time PNG screenshot with mapped coordinates and live mouse position (requires Handy ON).",
        mimeType: "image/png",
    }, async (uri) => {
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
    });
    // Prompt
    server.registerPrompt("computer-control", {
        title: "Handy Real-Time Computer Control Workflow",
        description: "Guide an LLM through accurate coordinate-mapped screen reading and chained mouse/keyboard control.",
        argsSchema: {
            goal: z.string().optional().describe("Task to perform on the user's computer"),
        },
    }, async ({ goal }) => {
        const taskLine = goal ? `Target task: ${goal}\n\n` : "";
        return {
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text: `${taskLine}Use Handy to complete this task safely and accurately:\n` +
                            `1. Call \`handy_see\` first to inspect the live screen, active window, pixel color under cursor, and exact (x, y) pixel coordinates from the top/left rulers and interior grid badges.\n` +
                            `2. Use \`handy_windows\` (\`action: "list"\` or \`"focus"\`) or the \`focus_window\` step in \`handy_act\` to bring a target app forward cleanly.\n` +
                            `3. For small icons or dense UI controls, call \`handy_see\` with \`region: { x, y, width, height }\` to inspect at 1:1 resolution with global screen coordinates.\n` +
                            `4. Chain sequential interactions in a single \`handy_act\` call (prefer \`paste\` for long/Unicode text and \`wait_for_change\` / \`wait_for_settled\` instead of blind sleeps) with \`screenshotAfter: true\` so you can verify both the UI state and numbered action trail in one round-trip.\n` +
                            `5. Use \`mod+<key>\` (e.g. \`mod+a\`, \`mod+c\`, \`mod+v\`) for cross-platform shortcuts (maps to Cmd on macOS, Ctrl on Windows/Linux).\n` +
                            `6. Respect the user's permission toggle and top-left (0,0) failsafe; if Handy is OFF, ask the user to run \`handy on\` or \`/handy:on\`. Confirm with the user before irreversible actions.`,
                    },
                },
            ],
        };
    });
    const dispose = async () => {
        stopWatch();
        await controller.close();
        await server.close();
    };
    return { server, controller, dispose };
}
export async function runStdioMcpServer(options = {}) {
    // MCP-04: Guarantee zero accidental diagnostic output on stdout during stdio transport
    const writeStderr = (...args) => {
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
        if (shuttingDown)
            return;
        shuttingDown = true;
        try {
            await dispose();
        }
        catch {
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
