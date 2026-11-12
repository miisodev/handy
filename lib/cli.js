import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createBackend } from "./backends/index.js";
import { HandyController, parseChainInput } from "./controller.js";
import { runStdioMcpServer } from "./mcp.js";
import { HandyPermissionError, parseDurationMs, PermissionStore } from "./permissions.js";
import { ActionStepSchema } from "./types.js";
import { HANDY_PACKAGE_NAME, HANDY_VERSION } from "./version.js";
import { z } from "zod";
const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;
const EXIT_PERMISSION = 3;
function useColor() {
    if (process.env.NO_COLOR !== undefined)
        return false;
    if (process.env.TERM === "dumb")
        return false;
    return Boolean(process.stdout.isTTY);
}
function colorize(text, ansiCode) {
    return useColor() ? `\x1b[${ansiCode}m${text}\x1b[0m` : text;
}
const HELP_TEXT = `handy v${HANDY_VERSION} — Real-time native computer control & coordinate-mapped screen vision for LLMs

Usage:
  handy mcp                                  Start stdio MCP server (also runs when piped without args)
  handy on [--view-only] [--ttl <duration>]  Turn Handy permissions ON (e.g. --ttl 30m)
  handy off                                  Turn Handy permissions OFF immediately
  handy toggle                               Toggle Handy permissions ON / OFF
  handy status [--json]                      Show permission toggle state, backend, displays & mouse
  handy doctor [--json]                      Verify native OS input & screen capture readiness
  handy see [options]                        Capture screen with mapped (x, y) grid & mouse reticle
  handy act <chain|json> [options]           Execute single or chained mouse & keyboard controls
  handy move <x> <y>                         Move mouse cursor to screen coordinates (x, y)
  handy click [x] [y] [--right|--double]     Click at current cursor or (x, y)
  handy type <text> [--submit]               Type text natively (with optional Enter submit)
  handy key <key-or-chord>                   Press key or shortcut (e.g. Enter, mod+a, ctrl+c)
  handy scroll <up|down|left|right> [amount] Scroll mouse wheel
  handy config [client]                      Print MCP config for claude-desktop, claude-code, or cursor

Options for 'see':
  --out, -o <path>       Save annotated PNG screenshot to file (default: ./handy-screen.png)
  --region <x,y,w,h>     Zoom into a rectangular screen region (keeps global coordinates)
  --display <index>      Target monitor index (default: 0)
  --max-width <px>       Max output image width (default: 1280)
  --grid-step <px>       Custom major coordinate grid spacing
  --no-grid              Disable coordinate ruler & grid overlay
  --no-mouse             Disable live mouse reticle overlay
  --json                 Print structured JSON result to stdout

Options for 'act':
  --step-delay <ms>      Delay in ms between chained steps (default: 15)
  --screenshot-after <f> Save post-chain annotated PNG screenshot to path
  --backend <kind>       Override backend (auto, virtual, linux-x11, linux-cli, darwin, win32)
  --json                 Print structured JSON receipt to stdout

Chained control examples:
  handy act 'move 420 260 -> click -> type "Sam"'
  handy act '[{"type":"move","x":420,"y":260},{"type":"click"},{"type":"type","text":"Sam"}]'

Exit codes:
  0  Success
  1  Execution error
  2  Invalid arguments / usage error
  3  Permission denied (Handy is toggled OFF or in view-only mode)
`;
function parseArgv(argv) {
    const positional = [];
    const flags = new Map();
    const booleanFlags = new Set([
        "help",
        "h",
        "version",
        "v",
        "json",
        "stdio",
        "view-only",
        "no-grid",
        "no-mouse",
        "submit",
        "right",
        "middle",
        "double",
        "triple",
    ]);
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--") {
            positional.push(...argv.slice(i + 1));
            break;
        }
        if (arg.startsWith("--")) {
            const eq = arg.indexOf("=");
            if (eq !== -1) {
                flags.set(arg.slice(2, eq), arg.slice(eq + 1));
            }
            else {
                const name = arg.slice(2);
                if (booleanFlags.has(name)) {
                    flags.set(name, true);
                }
                else if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
                    flags.set(name, argv[++i]);
                }
                else {
                    flags.set(name, true);
                }
            }
            continue;
        }
        if (arg.startsWith("-") && arg.length > 1 && !/^-\d/.test(arg)) {
            const short = arg.slice(1);
            if (short === "o" && i + 1 < argv.length) {
                flags.set("out", argv[++i]);
            }
            else {
                flags.set(short, true);
            }
            continue;
        }
        positional.push(arg);
    }
    return { positional, flags };
}
function parseRegionFlag(raw) {
    const parts = raw.split(",").map((s) => Number(s.trim()));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
        throw new Error(`Invalid --region "${raw}". Expected format: x,y,width,height`);
    }
    return RegionSchemaParse({
        x: parts[0],
        y: parts[1],
        width: parts[2],
        height: parts[3],
    });
}
function RegionSchemaParse(r) {
    if (r.width < 1 || r.height < 1) {
        throw new Error(`Region width and height must be >= 1.`);
    }
    return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
    };
}
function printConfigSnippet(client) {
    const normalized = client.trim().toLowerCase();
    if (normalized === "claude-code") {
        process.stdout.write(`# Option 1: Install full plugin (MCP server + skills + /handy:on & /handy:off commands)\n` +
            `claude plugin marketplace add miisodev/handy\n` +
            `claude plugin install handy\n\n` +
            `# Option 2: Register stdio MCP server directly\n` +
            `claude mcp add handy -- npx -y ${HANDY_PACKAGE_NAME} mcp\n`);
        return;
    }
    const mcpServersJson = {
        mcpServers: {
            handy: {
                command: "npx",
                args: ["-y", HANDY_PACKAGE_NAME, "mcp"],
            },
        },
    };
    process.stdout.write(`${JSON.stringify(mcpServersJson, null, 2)}\n`);
}
export async function runCli(argv = process.argv.slice(2)) {
    const { positional, flags } = parseArgv(argv);
    if (flags.has("version") || flags.has("v")) {
        process.stdout.write(`${HANDY_VERSION}\n`);
        return EXIT_OK;
    }
    if (flags.has("help") || flags.has("h")) {
        process.stdout.write(HELP_TEXT);
        return EXIT_OK;
    }
    const subcommand = positional[0]?.toLowerCase();
    const backendFlag = typeof flags.get("backend") === "string" ? flags.get("backend") : undefined;
    const jsonOut = flags.get("json") === true;
    // Start stdio MCP server explicitly or when piped without arguments/unknown flags
    const onlyAllowedPipeFlags = [...flags.keys()].every((k) => k === "backend");
    if (subcommand === "mcp" ||
        subcommand === "serve" ||
        flags.has("stdio") ||
        (!subcommand && !process.stdin.isTTY && onlyAllowedPipeFlags)) {
        await runStdioMcpServer({ backendKind: backendFlag });
        return EXIT_OK;
    }
    const permissions = new PermissionStore();
    if (!subcommand) {
        const st = permissions.getState();
        const badge = st.enabled ? colorize("ON", "32;1") : colorize("OFF", "31;1");
        process.stdout.write(`Handy v${HANDY_VERSION} — Permission: ${badge} (${st.mode})\n\n${HELP_TEXT}`);
        return EXIT_OK;
    }
    try {
        if (subcommand === "on" || subcommand === "enable") {
            const mode = flags.get("view-only") === true ? "view_only" : "full";
            const ttlRaw = typeof flags.get("ttl") === "string" ? flags.get("ttl") : undefined;
            const ttlMs = ttlRaw ? parseDurationMs(ttlRaw) : null;
            const next = permissions.setEnabled(true, { mode, ttlMs, updatedBy: "cli" });
            if (jsonOut) {
                process.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
            }
            else {
                const modeNote = next.mode === "view_only" ? " (view-only)" : "";
                const expNote = next.expiresAt ? ` until ${next.expiresAt}` : "";
                process.stdout.write(`${colorize("Handy is ON", "32;1")}${modeNote}${expNote}\n`);
            }
            return EXIT_OK;
        }
        if (subcommand === "off" || subcommand === "disable") {
            const next = permissions.setEnabled(false, { updatedBy: "cli" });
            if (jsonOut) {
                process.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
            }
            else {
                process.stdout.write(`${colorize("Handy is OFF", "31;1")} — LLM screen and input control disabled.\n`);
            }
            return EXIT_OK;
        }
        if (subcommand === "toggle") {
            const next = permissions.toggle({ updatedBy: "cli" });
            if (jsonOut) {
                process.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
            }
            else if (next.enabled) {
                process.stdout.write(`${colorize("Handy is ON", "32;1")} (${next.mode})\n`);
            }
            else {
                process.stdout.write(`${colorize("Handy is OFF", "31;1")}\n`);
            }
            return EXIT_OK;
        }
        if (subcommand === "config") {
            printConfigSnippet(positional[1] ?? "mcp");
            return EXIT_OK;
        }
        const backend = createBackend({ kind: backendFlag });
        const controller = new HandyController({ backend, permissions });
        try {
            if (subcommand === "status") {
                const info = await controller.status();
                if (jsonOut) {
                    process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
                }
                else {
                    const stateStr = info.enabled ? colorize("ON", "32;1") : colorize("OFF", "31;1");
                    process.stdout.write(`Permission : ${stateStr} (mode=${info.mode}, source=${info.updatedBy})\n`);
                    if (info.expiresAt)
                        process.stdout.write(`Expires    : ${info.expiresAt}\n`);
                    process.stdout.write(`Platform   : ${info.platform} (${info.backend})\n`);
                    if (info.displays?.length) {
                        for (const d of info.displays) {
                            process.stdout.write(`Display ${d.id}  : ${d.width}x${d.height} @ (${d.x},${d.y}) scale=${d.scaleFactor}x${d.primary ? " [primary]" : ""}\n`);
                        }
                    }
                    if (info.mouse) {
                        process.stdout.write(`Mouse      : (${info.mouse.x}, ${info.mouse.y})\n`);
                    }
                }
                return EXIT_OK;
            }
            if (subcommand === "doctor") {
                const report = await controller.doctor();
                const allOk = report.checks.every((c) => c.ok);
                if (jsonOut) {
                    process.stdout.write(`${JSON.stringify({ ok: allOk, ...report }, null, 2)}\n`);
                }
                else {
                    process.stdout.write(`Backend: ${report.backend}\n`);
                    process.stdout.write(`Permission: ${report.permission.enabled ? "ON" : "OFF"} (${report.permission.mode})\n`);
                    for (const check of report.checks) {
                        const mark = check.ok ? colorize("[OK]", "32;1") : colorize("[FAIL]", "31;1");
                        process.stdout.write(`  ${mark} ${check.name}: ${check.detail}\n`);
                    }
                }
                return allOk ? EXIT_OK : EXIT_ERROR;
            }
            if (subcommand === "see" || subcommand === "screenshot") {
                const outPath = resolve(typeof flags.get("out") === "string" ? flags.get("out") : "handy-screen.png");
                const region = typeof flags.get("region") === "string" ? parseRegionFlag(flags.get("region")) : undefined;
                const display = typeof flags.get("display") === "string" ? Number(flags.get("display")) : undefined;
                const maxWidth = typeof flags.get("max-width") === "string" ? Number(flags.get("max-width")) : undefined;
                const gridStep = typeof flags.get("grid-step") === "string" ? Number(flags.get("grid-step")) : undefined;
                const grid = flags.get("no-grid") === true ? false : true;
                const showMouse = flags.get("no-mouse") === true ? false : true;
                const shot = await controller.see({ display, region, maxWidth, gridStep, grid, showMouse });
                writeFileSync(outPath, shot.pngBuffer);
                const payload = {
                    ok: true,
                    path: outPath,
                    mouse: shot.mouse,
                    screen: shot.screen,
                    region: shot.region,
                    imageSize: { width: shot.imageWidth, height: shot.imageHeight },
                    gridStep: shot.gridStep,
                    captureMs: shot.captureMs,
                };
                if (jsonOut) {
                    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
                }
                else {
                    process.stdout.write(`Saved ${shot.imageWidth}x${shot.imageHeight} screenshot -> ${outPath} (mouse=${shot.mouse.x},${shot.mouse.y}, ${shot.captureMs}ms)\n`);
                }
                return EXIT_OK;
            }
            // Direct convenience commands + chained `act`
            let steps = null;
            if (subcommand === "act") {
                const rawChain = positional.slice(1).join(" ");
                if (!rawChain) {
                    process.stderr.write(`Error: 'handy act' requires a chain expression or JSON array.\n`);
                    return EXIT_USAGE;
                }
                const rawSteps = parseChainInput(rawChain);
                steps = z.array(ActionStepSchema).min(1).max(100).parse(rawSteps);
            }
            else if (subcommand === "move") {
                const x = Number(positional[1]);
                const y = Number(positional[2]);
                if (Number.isNaN(x) || Number.isNaN(y)) {
                    process.stderr.write(`Usage: handy move <x> <y>\n`);
                    return EXIT_USAGE;
                }
                steps = [{ type: "move", x, y }];
            }
            else if (subcommand === "click") {
                const button = flags.has("right") ? "right" : flags.has("middle") ? "middle" : "left";
                const count = flags.has("triple") ? 3 : flags.has("double") ? 2 : 1;
                if (positional[1] !== undefined && positional[2] !== undefined) {
                    const x = Number(positional[1]);
                    const y = Number(positional[2]);
                    if (Number.isNaN(x) || Number.isNaN(y)) {
                        process.stderr.write(`Usage: handy click [x] [y]\n`);
                        return EXIT_USAGE;
                    }
                    steps = [{ type: "click", x, y, button, count }];
                }
                else {
                    steps = [{ type: "click", button, count }];
                }
            }
            else if (subcommand === "type") {
                const text = positional.slice(1).join(" ");
                if (!text) {
                    process.stderr.write(`Usage: handy type <text> [--submit]\n`);
                    return EXIT_USAGE;
                }
                steps = [{ type: "type", text, submit: flags.get("submit") === true }];
            }
            else if (subcommand === "key" || subcommand === "press") {
                const key = positional[1];
                if (!key) {
                    process.stderr.write(`Usage: handy key <key-or-chord>\n`);
                    return EXIT_USAGE;
                }
                steps = [{ type: "key", key }];
            }
            else if (subcommand === "scroll") {
                const dir = positional[1]?.toLowerCase();
                if (dir !== "up" && dir !== "down" && dir !== "left" && dir !== "right") {
                    process.stderr.write(`Usage: handy scroll <up|down|left|right> [amount]\n`);
                    return EXIT_USAGE;
                }
                const amount = positional[2] ? Number(positional[2]) : 3;
                steps = [{ type: "scroll", direction: dir, amount }];
            }
            else {
                process.stderr.write(`Unknown command "${subcommand}". Run 'handy --help' for usage.\n`);
                return EXIT_USAGE;
            }
            const stepDelayMs = typeof flags.get("step-delay") === "string" ? Number(flags.get("step-delay")) : undefined;
            const afterPath = typeof flags.get("screenshot-after") === "string" ? resolve(flags.get("screenshot-after")) : undefined;
            const result = await controller.act({
                actions: steps,
                stepDelayMs,
                screenshotAfter: Boolean(afterPath),
            });
            if (afterPath && result.screenshots[0]) {
                writeFileSync(afterPath, result.screenshots[0].pngBuffer);
            }
            const summary = {
                ok: true,
                stepsCompleted: result.stepsCompleted,
                totalDurationMs: result.totalDurationMs,
                mouse: result.mouse,
                receipts: result.receipts,
                screenshotPath: afterPath,
            };
            if (jsonOut) {
                process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
            }
            else {
                process.stdout.write(`Executed ${result.stepsCompleted} step${result.stepsCompleted === 1 ? "" : "s"} in ${result.totalDurationMs}ms — mouse at (${result.mouse.x}, ${result.mouse.y})\n`);
                if (afterPath) {
                    process.stdout.write(`Saved post-action screenshot -> ${afterPath}\n`);
                }
            }
            return EXIT_OK;
        }
        finally {
            await controller.close();
        }
    }
    catch (err) {
        if (err instanceof HandyPermissionError) {
            if (jsonOut) {
                process.stdout.write(`${JSON.stringify({ ok: false, error: err.code, message: err.message, permission: err.state }, null, 2)}\n`);
            }
            else {
                process.stderr.write(`Permission denied: ${err.message}\n`);
            }
            return EXIT_PERMISSION;
        }
        const message = err instanceof Error ? err.message : String(err);
        if (jsonOut) {
            process.stdout.write(`${JSON.stringify({ ok: false, error: "HANDY_ERROR", message }, null, 2)}\n`);
        }
        else {
            process.stderr.write(`Error: ${message}\n`);
        }
        return EXIT_ERROR;
    }
}
// Entry point guard when invoked directly as bin/handy.js
const isDirectEntry = (() => {
    const argv1 = process.argv[1];
    if (!argv1)
        return false;
    return argv1.endsWith("handy.js") || argv1.endsWith("cli.ts") || argv1.endsWith("cli.js") || argv1.endsWith("/handy");
})();
if (isDirectEntry) {
    runCli().then((code) => {
        // In stdio MCP mode, process stays alive until stdin closes
        const sub = process.argv[2]?.toLowerCase();
        const isMcp = sub === "mcp" ||
            sub === "serve" ||
            process.argv.includes("--stdio") ||
            (!sub && !process.stdin.isTTY && !process.argv.includes("--help") && !process.argv.includes("--version"));
        if (!isMcp) {
            process.exitCode = code;
        }
    }, (err) => {
        process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
    });
}
