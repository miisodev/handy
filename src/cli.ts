import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { createBackend } from "./backends/index.js";
import { HandyController, parseChainInput } from "./controller.js";
import {
  installHandyToHosts,
  SUPPORTED_MCP_HOSTS,
  uninstallHandyFromHosts,
  type McpHostTarget,
} from "./installer.js";
import { runStdioMcpServer } from "./mcp.js";
import { HandyPermissionError, parseDurationMs, PermissionStore } from "./permissions.js";
import { ActionStepSchema, type ActionStep, type MouseButton, type Region } from "./types.js";
import { startControlPanel } from "./ui.js";
import { HANDY_PACKAGE_NAME, HANDY_VERSION } from "./version.js";

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;
const EXIT_PERMISSION = 3;

function useColor(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.TERM === "dumb") return false;
  return Boolean(process.stdout.isTTY);
}

function colorize(text: string, ansiCode: string): string {
  return useColor() ? `\x1b[${ansiCode}m${text}\x1b[0m` : text;
}

const HELP_TEXT = `handy v${HANDY_VERSION} — Real-time native computer control & coordinate-mapped screen vision for LLMs

Usage:
  handy mcp                                  Start stdio MCP server (also runs when piped without args)
  handy install [host] [--dry-run]           Auto-register Handy in Claude Desktop, Cursor, Windsurf, or Claude Code
  handy uninstall [host] [--dry-run]         Remove Handy from MCP host config(s)
  handy ui [--port 7788]                     Launch local live web Control Panel & coordinate inspector
  handy on [--view-only] [--ttl <duration>]  Turn Handy permissions ON (e.g. --ttl 30m)
  handy off                                  Turn Handy permissions OFF immediately
  handy toggle                               Toggle Handy permissions ON / OFF
  handy status [--json]                      Show permission state, backend, displays, active window & mouse
  handy doctor [--json]                      Verify native OS input & screen capture readiness
  handy see [options]                        Capture screen with mapped (x, y) grid, reticle & frame diff
  handy windows [--json]                     List visible desktop windows with bounds & focus state
  handy focus <title>                        Bring a desktop window to the foreground
  handy clipboard [get|set <text>]           Read or write plain-text system clipboard
  handy act <chain|json> [options]           Execute single or chained mouse & keyboard controls
  handy move <x> <y>                         Move mouse cursor to screen coordinates (x, y)
  handy click [x] [y] [--right|--double]     Click at current cursor or (x, y)
  handy type <text> [--submit]               Type text natively (with optional Enter submit)
  handy paste <text> [--submit]              Paste Unicode/long text instantly via clipboard
  handy key <key-or-chord>                   Press key or shortcut (e.g. Enter, mod+a, ctrl+c)
  handy scroll <up|down|left|right> [amount] Scroll mouse wheel
  handy config [client]                      Print MCP config for claude-desktop, claude-code, or cursor

Options for 'see':
  --out, -o <path>       Save annotated PNG screenshot to file (default: ./handy-screen.png)
  --region <x,y,w,h>     Zoom into a rectangular screen region (keeps global coordinates)
  --window <title>       Capture a specific visible window by title/app substring
  --highlight-diff       Outline changed pixels since the previous capture
  --marks                Detect & number UI elements (Set-of-Mark); prints their bounds/centres
  --max-marks <n>        Max element marks to return with --marks (default: 40)
  --display <index>      Target monitor index (default: 0)
  --max-width <px>       Max output image width (default: 1280)
  --grid-step <px>       Custom major coordinate grid spacing
  --no-grid              Disable coordinate ruler & grid overlay
  --no-mouse             Disable live mouse reticle overlay
  --json                 Print structured JSON result to stdout

Options for 'act':
  --step-delay <ms>      Delay in ms between chained steps (default: 15)
  --screenshot-after <f> Save post-chain annotated PNG screenshot (with numbered trail) to path
  --highlight-diff       Outline changed pixels on --screenshot-after
  --no-trail             Omit numbered action-trail markers on --screenshot-after
  --no-failsafe          Disable top-left (0,0) corner-slam failsafe
  --backend <kind>       Override backend (auto, virtual, linux-x11, linux-cli, darwin, win32)
  --json                 Print structured JSON receipt to stdout

Chained control examples:
  handy act 'focus "Scratchpad" -> click 800 420 -> paste "Hello 🌍" -> wait_for_settled'
  handy act '[{"type":"move","x":420,"y":260},{"type":"click"},{"type":"paste","text":"Sam"}]'

Exit codes:
  0  Success
  1  Execution error
  2  Invalid arguments / usage error
  3  Permission denied (Handy is toggled OFF or in view-only mode)
`;

interface ParsedFlags {
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArgv(argv: string[]): ParsedFlags {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();

  const booleanFlags = new Set([
    "help",
    "h",
    "version",
    "v",
    "json",
    "stdio",
    "view-only",
    "dry-run",
    "no-grid",
    "no-mouse",
    "no-trail",
    "no-failsafe",
    "highlight-diff",
    "submit",
    "right",
    "middle",
    "double",
    "triple",
  ]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        const name = arg.slice(2);
        if (booleanFlags.has(name)) {
          flags.set(name, true);
        } else if (i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) {
          flags.set(name, argv[++i]!);
        } else {
          flags.set(name, true);
        }
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1 && !/^-\d/.test(arg)) {
      const short = arg.slice(1);
      if (short === "o" && i + 1 < argv.length) {
        flags.set("out", argv[++i]!);
      } else {
        flags.set(short, true);
      }
      continue;
    }
    positional.push(arg);
  }

  return { positional, flags };
}

function parseRegionFlag(raw: string): Region {
  const parts = raw.split(",").map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    throw new Error(`Invalid --region "${raw}". Expected format: x,y,width,height`);
  }
  return RegionSchemaParse({
    x: parts[0]!,
    y: parts[1]!,
    width: parts[2]!,
    height: parts[3]!,
  });
}

function RegionSchemaParse(r: Region): Region {
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

function printConfigSnippet(client: string): void {
  const normalized = client.trim().toLowerCase();
  if (normalized === "claude-code") {
    process.stdout.write(
      `# Option 1: Install full plugin (MCP server + skills + /handy:on & /handy:off commands)\n` +
        `claude plugin marketplace add miisodev/handy\n` +
        `claude plugin install handy\n\n` +
        `# Option 2: Register stdio MCP server directly\n` +
        `claude mcp add handy -- npx -y ${HANDY_PACKAGE_NAME} mcp\n`,
    );
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

function parseHostArg(raw?: string): McpHostTarget | "all" {
  if (!raw || raw.toLowerCase() === "all") return "all";
  const normalized = raw.toLowerCase() as McpHostTarget;
  if (!(SUPPORTED_MCP_HOSTS as readonly string[]).includes(normalized)) {
    throw new Error(
      `Unsupported host "${raw}". Expected one of: all, ${SUPPORTED_MCP_HOSTS.join(", ")}.`,
    );
  }
  return normalized;
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
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
  const backendFlag = typeof flags.get("backend") === "string" ? (flags.get("backend") as string) : undefined;
  const jsonOut = flags.get("json") === true;

  // Start stdio MCP server explicitly or when piped without arguments/unknown flags
  const onlyAllowedPipeFlags = [...flags.keys()].every((k) => k === "backend");
  if (
    subcommand === "mcp" ||
    subcommand === "serve" ||
    flags.has("stdio") ||
    (!subcommand && !process.stdin.isTTY && onlyAllowedPipeFlags)
  ) {
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
    if (subcommand === "install" || subcommand === "uninstall") {
      let target: McpHostTarget | "all";
      try {
        target = parseHostArg(positional[1]);
      } catch (e) {
        process.stderr.write(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
        return EXIT_USAGE;
      }
      const dryRun = flags.get("dry-run") === true;
      const results =
        subcommand === "install"
          ? installHandyToHosts(target, { dryRun })
          : uninstallHandyFromHosts(target, { dryRun });
      if (jsonOut) {
        process.stdout.write(`${JSON.stringify({ ok: true, dryRun, results }, null, 2)}\n`);
      } else {
        for (const r of results) {
          const tag =
            r.action === "installed" || r.action === "updated" || r.action === "removed"
              ? colorize(`[${r.action.toUpperCase()}]`, "32;1")
              : `[${r.action.toUpperCase()}]`;
          process.stdout.write(`${tag} ${r.host} -> ${r.configPath} (${r.detail})\n`);
        }
      }
      return EXIT_OK;
    }

    if (subcommand === "ui" || subcommand === "panel") {
      const port = typeof flags.get("port") === "string" ? Number(flags.get("port")) : 7788;
      const host = typeof flags.get("host") === "string" ? (flags.get("host") as string) : "127.0.0.1";
      const running = await startControlPanel({
        port,
        host,
        backendKind: backendFlag,
        permissions,
      });
      process.stdout.write(
        `${colorize("Handy Control Panel", "36;1")} listening on ${running.url}\n` +
          `Press Ctrl+C to stop.\n`,
      );
      await new Promise<void>((resolveStop) => {
        const stop = () => {
          void running.close().finally(() => resolveStop());
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      return EXIT_OK;
    }

    if (subcommand === "on" || subcommand === "enable") {
      const mode = flags.get("view-only") === true ? "view_only" : "full";
      const ttlRaw = typeof flags.get("ttl") === "string" ? (flags.get("ttl") as string) : undefined;
      const ttlMs = ttlRaw ? parseDurationMs(ttlRaw) : null;
      const next = permissions.setEnabled(true, { mode, ttlMs, updatedBy: "cli" });
      if (jsonOut) {
        process.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
      } else {
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
      } else {
        process.stdout.write(`${colorize("Handy is OFF", "31;1")} — LLM screen and input control disabled.\n`);
      }
      return EXIT_OK;
    }

    if (subcommand === "toggle") {
      const next = permissions.toggle({ updatedBy: "cli" });
      if (jsonOut) {
        process.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
      } else if (next.enabled) {
        process.stdout.write(`${colorize("Handy is ON", "32;1")} (${next.mode})\n`);
      } else {
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
        } else {
          const stateStr = info.enabled ? colorize("ON", "32;1") : colorize("OFF", "31;1");
          process.stdout.write(`Permission : ${stateStr} (mode=${info.mode}, source=${info.updatedBy})\n`);
          if (info.expiresAt) process.stdout.write(`Expires    : ${info.expiresAt}\n`);
          process.stdout.write(`Platform   : ${info.platform} (${info.backend})\n`);
          if (info.displays?.length) {
            for (const d of info.displays) {
              process.stdout.write(
                `Display ${d.id}  : ${d.width}x${d.height} @ (${d.x},${d.y}) scale=${d.scaleFactor}x${d.primary ? " [primary]" : ""}\n`,
              );
            }
          }
          if (info.activeWindow) {
            process.stdout.write(
              `Window     : ${info.activeWindow.title}${info.activeWindow.app ? ` (${info.activeWindow.app})` : ""}\n`,
            );
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
        } else {
          process.stdout.write(`Backend: ${report.backend}\n`);
          process.stdout.write(`Permission: ${report.permission.enabled ? "ON" : "OFF"} (${report.permission.mode})\n`);
          for (const check of report.checks) {
            const mark = check.ok ? colorize("[OK]", "32;1") : colorize("[FAIL]", "31;1");
            process.stdout.write(`  ${mark} ${check.name}: ${check.detail}\n`);
          }
        }
        return allOk ? EXIT_OK : EXIT_ERROR;
      }

      if (subcommand === "windows") {
        const windows = await controller.listWindows();
        if (jsonOut) {
          process.stdout.write(`${JSON.stringify({ ok: true, count: windows.length, windows }, null, 2)}\n`);
        } else if (windows.length === 0) {
          process.stdout.write("No visible windows reported.\n");
        } else {
          for (const w of windows) {
            const mark = w.focused ? colorize("*", "32;1") : " ";
            const b = w.bounds ? ` [${w.bounds.x},${w.bounds.y} ${w.bounds.width}x${w.bounds.height}]` : "";
            process.stdout.write(`${mark} ${w.id}: ${w.title}${w.app ? ` (${w.app})` : ""}${b}\n`);
          }
        }
        return EXIT_OK;
      }

      if (subcommand === "focus") {
        const title = positional.slice(1).join(" ").trim();
        if (!title) {
          process.stderr.write(`Usage: handy focus <window-title>\n`);
          return EXIT_USAGE;
        }
        const res = await controller.focusWindow({ title });
        if (jsonOut) {
          process.stdout.write(`${JSON.stringify({ ok: res.focused, ...res }, null, 2)}\n`);
        } else if (res.focused) {
          process.stdout.write(`Focused window "${res.activeWindow?.title ?? title}".\n`);
        } else {
          process.stderr.write(`No window matched "${title}".\n`);
          return EXIT_ERROR;
        }
        return EXIT_OK;
      }

      if (subcommand === "clipboard") {
        const action = (positional[1] ?? "get").toLowerCase();
        if (action === "get" || action === "read") {
          const text = await controller.readClipboard();
          if (jsonOut) {
            process.stdout.write(`${JSON.stringify({ ok: true, length: Array.from(text).length, text }, null, 2)}\n`);
          } else {
            process.stdout.write(`${text}\n`);
          }
          return EXIT_OK;
        }
        if (action === "set" || action === "write") {
          const text = positional.slice(2).join(" ");
          await controller.writeClipboard(text);
          if (jsonOut) {
            process.stdout.write(`${JSON.stringify({ ok: true, writtenChars: Array.from(text).length }, null, 2)}\n`);
          } else {
            process.stdout.write(`Copied ${Array.from(text).length} characters to clipboard.\n`);
          }
          return EXIT_OK;
        }
        process.stderr.write(`Usage: handy clipboard [get | set <text>]\n`);
        return EXIT_USAGE;
      }

      if (subcommand === "see" || subcommand === "screenshot") {
        const outPath = resolve(
          typeof flags.get("out") === "string" ? (flags.get("out") as string) : "handy-screen.png",
        );
        const region = typeof flags.get("region") === "string" ? parseRegionFlag(flags.get("region") as string) : undefined;
        const windowQuery = typeof flags.get("window") === "string" ? (flags.get("window") as string) : undefined;
        const display = typeof flags.get("display") === "string" ? Number(flags.get("display")) : undefined;
        const maxWidth = typeof flags.get("max-width") === "string" ? Number(flags.get("max-width")) : undefined;
        const gridStep = typeof flags.get("grid-step") === "string" ? Number(flags.get("grid-step")) : undefined;
        const grid = flags.get("no-grid") === true ? false : true;
        const showMouse = flags.get("no-mouse") === true ? false : true;
        const highlightDiff = flags.get("highlight-diff") === true;
        const marks = flags.get("marks") === true;
        const maxMarks = typeof flags.get("max-marks") === "string" ? Number(flags.get("max-marks")) : undefined;

        const shot = await controller.see({
          display,
          region,
          window: windowQuery,
          maxWidth,
          gridStep,
          grid,
          showMouse,
          highlightDiff,
          marks,
          maxMarks,
        });
        writeFileSync(outPath, shot.pngBuffer);

        const payload = {
          ok: true,
          path: outPath,
          mouse: shot.mouse,
          pixelUnderMouse: shot.pixelUnderMouse,
          activeWindow: shot.activeWindow,
          screenDiff: shot.screenDiff,
          screen: shot.screen,
          region: shot.region,
          imageSize: { width: shot.imageWidth, height: shot.imageHeight },
          gridStep: shot.gridStep,
          captureMs: shot.captureMs,
          ...(shot.elements ? { elementCount: shot.elements.length, elements: shot.elements } : {}),
          ...(shot.marksError ? { marksError: shot.marksError } : {}),
        };

        if (jsonOut) {
          process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        } else {
          process.stdout.write(
            `Saved ${shot.imageWidth}x${shot.imageHeight} screenshot -> ${outPath} (mouse=${shot.mouse.x},${shot.mouse.y}${shot.pixelUnderMouse ? ` ${shot.pixelUnderMouse}` : ""}, ${shot.captureMs}ms)\n` +
              (shot.marksError
                ? `Mark detection failed (screenshot is still valid; use ruler coordinates): ${shot.marksError}\n`
                : "") +
              (shot.elements
                ? `Detected ${shot.elements.length} UI element mark(s):\n` +
                  shot.elements
                    .map(
                      (e) =>
                        `  #${String(e.index).padStart(2)} ${e.kind.padEnd(7)} (${e.centerX},${e.centerY})  ${e.width}x${e.height} @ ${e.x},${e.y}  score=${e.score.toFixed(2)}`,
                    )
                    .join("\n") +
                  "\n"
                : ""),
          );
        }
        return EXIT_OK;
      }

      // Direct convenience commands + chained `act`
      let steps: ActionStep[] | null = null;

      if (subcommand === "act") {
        const rawChain = positional.slice(1).join(" ");
        if (!rawChain) {
          process.stderr.write(`Error: 'handy act' requires a chain expression or JSON array.\n`);
          return EXIT_USAGE;
        }
        const rawSteps = parseChainInput(rawChain);
        steps = z.array(ActionStepSchema).min(1).max(100).parse(rawSteps);
      } else if (subcommand === "move") {
        const x = Number(positional[1]);
        const y = Number(positional[2]);
        if (Number.isNaN(x) || Number.isNaN(y)) {
          process.stderr.write(`Usage: handy move <x> <y>\n`);
          return EXIT_USAGE;
        }
        steps = [{ type: "move", x, y }];
      } else if (subcommand === "click") {
        const button: MouseButton = flags.has("right") ? "right" : flags.has("middle") ? "middle" : "left";
        const count = flags.has("triple") ? 3 : flags.has("double") ? 2 : 1;
        if (positional[1] !== undefined && positional[2] !== undefined) {
          const x = Number(positional[1]);
          const y = Number(positional[2]);
          if (Number.isNaN(x) || Number.isNaN(y)) {
            process.stderr.write(`Usage: handy click [x] [y]\n`);
            return EXIT_USAGE;
          }
          steps = [{ type: "click", x, y, button, count }];
        } else {
          steps = [{ type: "click", button, count }];
        }
      } else if (subcommand === "type") {
        const text = positional.slice(1).join(" ");
        if (!text) {
          process.stderr.write(`Usage: handy type <text> [--submit]\n`);
          return EXIT_USAGE;
        }
        steps = [{ type: "type", text, submit: flags.get("submit") === true }];
      } else if (subcommand === "paste") {
        const text = positional.slice(1).join(" ");
        if (!text) {
          process.stderr.write(`Usage: handy paste <text> [--submit]\n`);
          return EXIT_USAGE;
        }
        steps = [{ type: "paste", text, submit: flags.get("submit") === true }];
      } else if (subcommand === "key" || subcommand === "press") {
        const key = positional[1];
        if (!key) {
          process.stderr.write(`Usage: handy key <key-or-chord>\n`);
          return EXIT_USAGE;
        }
        steps = [{ type: "key", key }];
      } else if (subcommand === "scroll") {
        const dir = positional[1]?.toLowerCase();
        if (dir !== "up" && dir !== "down" && dir !== "left" && dir !== "right") {
          process.stderr.write(`Usage: handy scroll <up|down|left|right> [amount]\n`);
          return EXIT_USAGE;
        }
        const amount = positional[2] ? Number(positional[2]) : 3;
        steps = [{ type: "scroll", direction: dir, amount }];
      } else {
        process.stderr.write(`Unknown command "${subcommand}". Run 'handy --help' for usage.\n`);
        return EXIT_USAGE;
      }

      const stepDelayMs =
        typeof flags.get("step-delay") === "string" ? Number(flags.get("step-delay")) : undefined;
      const afterPath =
        typeof flags.get("screenshot-after") === "string" ? resolve(flags.get("screenshot-after") as string) : undefined;
      const showTrail = flags.get("no-trail") !== true;
      const failsafe = flags.get("no-failsafe") !== true;
      const highlightDiff = flags.get("highlight-diff") === true;

      const result = await controller.act({
        actions: steps,
        stepDelayMs,
        screenshotAfter: Boolean(afterPath),
        showTrail,
        highlightDiff,
        failsafe,
      });

      if (afterPath && result.screenshots[0]) {
        writeFileSync(afterPath, result.screenshots[0].pngBuffer);
      }

      const summary = {
        ok: true,
        stepsCompleted: result.stepsCompleted,
        totalDurationMs: result.totalDurationMs,
        mouse: result.mouse,
        activeWindow: result.activeWindow,
        receipts: result.receipts,
        screenshotPath: afterPath,
      };

      if (jsonOut) {
        process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      } else {
        process.stdout.write(
          `Executed ${result.stepsCompleted} step${result.stepsCompleted === 1 ? "" : "s"} in ${result.totalDurationMs}ms — mouse at (${result.mouse.x}, ${result.mouse.y})\n`,
        );
        if (afterPath) {
          process.stdout.write(`Saved post-action screenshot -> ${afterPath}\n`);
        }
      }
      return EXIT_OK;
    } finally {
      await controller.close();
    }
  } catch (err) {
    if (err instanceof HandyPermissionError) {
      if (jsonOut) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, error: err.code, message: err.message, permission: err.state }, null, 2)}\n`,
        );
      } else {
        process.stderr.write(`Permission denied: ${err.message}\n`);
      }
      return EXIT_PERMISSION;
    }

    const message = err instanceof Error ? err.message : String(err);
    if (jsonOut) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: "HANDY_ERROR", message }, null, 2)}\n`);
    } else {
      process.stderr.write(`Error: ${message}\n`);
    }
    return EXIT_ERROR;
  }
}

const isDirectEntry = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return (
    argv1.endsWith("handy.js") ||
    argv1.endsWith("cli.ts") ||
    argv1.endsWith("cli.js") ||
    /[/\\]handy(?:\.cmd|\.exe)?$/i.test(argv1)
  );
})();

if (isDirectEntry) {
  runCli().then(
    (code) => {
      const sub = process.argv[2]?.toLowerCase();
      const isMcp =
        sub === "mcp" ||
        sub === "serve" ||
        process.argv.includes("--stdio") ||
        (!sub && !process.stdin.isTTY && !process.argv.includes("--help") && !process.argv.includes("--version"));
      if (!isMcp) {
        process.exitCode = code;
      }
    },
    (err) => {
      process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
