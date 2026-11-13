# handy

![version](https://img.shields.io/badge/version-1.3.0-0ea5e9)
![license](https://img.shields.io/badge/license-MIT-10b981)
![platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-334155)

**Real-time native mouse, keyboard, window, clipboard, and coordinate-mapped screen control for LLMs and agents.**

Handy lets LLMs see your computer screen (or a single desktop window) in real-time with dual-contrast mapped `(x, y)` coordinate rulers, active window telemetry, pixel hex under the cursor, and sub-2ms frame-to-frame visual diffs — and control the mouse, keyboard, clipboard, and desktop windows natively with **chained multi-step actions** (`focus_window -> click -> paste -> wait_for_settled` in a single call). It installs cleanly on any PC with zero C++ addon compilation (`node-gyp` free) and ships prepackaged as a stdio MCP server and agent plugin with operational skills, a local SSE-powered live web **Control Panel (`handy ui`)**, a physical **`(0, 0)` corner-slam failsafe**, and an instant **on/off permission toggle**.

---

## Highlights

- **Set-of-Mark Vision + Click-by-Mark (`handy_see` `marks: true`)**: Instead of guessing pixel coordinates from a screenshot, Handy detects and numbers the interactive elements on screen — `control` (buttons, fields, checkboxes), `text`, `icon`, and `region` — and outlines each with a small numbered badge. Every pointer step (`move`, `click`, `double_click`, `triple_click`, `right_click`, `drag`, `scroll`) then accepts `{ "mark": 5 }` in place of `{ "x": …, "y": … }`, and the text chain DSL understands `click mark 5` / `click #5`. Marks survive layout shift and HiDPI scaling because they resolve to the element's own centre at execution time, and they work identically in the CLI (`handy see --marks`) and the Control Panel, where clicking an element on the screenshot inserts its mark reference instead of brittle coordinates.
- **Human-Like Pointer Motion (`motion: "human"`)**: Pointer steps can travel along a Fitts's-law-paced Bézier arc rather than a teleporting straight line, with the duration derived automatically from travel distance and target size when omitted. Useful where synthetic instant motion is filtered or where a visible cursor path helps a human follow along. `motion: "linear"` and `"ease"` are also available.
- **Chained Real-Time Controls (`handy_act`)**: Execute up to 100 sequential steps (`focus_window`, `move`, `click`, `double_click`, `triple_click`, `right_click`, `drag`, `scroll`, `paste`, `type`, `key`, `mouse_down`/`up`, `key_down`/`up`, `wait`, `wait_for_change`, `wait_for_settled`, `wait_for_color`, `screenshot`) in one atomic call, supporting global `screen`, `normalized` (`0..1000`), and `window`-relative coordinates, plus `screenshotAfter: true` with numbered amber **action-trail markers (`#1`, `#2`, drag vectors)**.
- **Coordinate-Mapped Vision + Window Zoom + Smart Diffing (`handy_see`)**: Renders exact OS screen coordinate rulers (dual-contrast so lines are legible on both `#000` dark and `#fff` light apps), `(x, y)` intersection pills, and a high-contrast `MOUSE (x,y)` reticle — plus `pixelUnderMouse` (`#rrggbb`), `activeWindow`, `screenDiff` (`changedPercent`, `changedBounds`), and `highlightDiff: true` (`CHANGED` outline). Supports `window` or `region` zoom at 1:1 resolution while preserving global screen coordinates. Downscales with area-average box filtering (so 1px text survives instead of being sampled away) and encodes with per-row filter selection, producing captures that are ~26% smaller and noticeably sharper than nearest-neighbour bilinear output.
- **Window & Clipboard Awareness (`handy_windows`, `handy_clipboard`)**: Inspect open desktop windows with `{ x, y, width, height }` bounds, bring target apps to the foreground cleanly, and paste multi-line Unicode text instantaneously while preserving the user's prior clipboard.
- **Instant On/Off Toggle + `(0, 0)` Failsafe + Live SSE UI**: Toggle LLM access live at any time via CLI (`handy off` / `handy on` / `handy toggle`), plugin slash commands (`/handy:off` / `/handy:on` / `/handy:toggle` / `/handy:status` / `/handy:doctor` / `/handy:windows`), `--view-only` mode, `--ttl` timers, or the loopback web Control Panel (`handy ui` with live Server-Sent Events push) — or slam your physical mouse to the top-left `(0, 0)` corner to abort an active chain immediately.
- **Works on Any PC Out of the Box**:
  - **Windows 10/11**: Persistent Win32 `SendInput` (`KEYEVENTF_UNICODE`, `MOUSEEVENTF_VIRTUALDESK`), `EnumWindows`/`SetForegroundWindow`, MTA-safe Win32 `OpenClipboard`, and GDI `CopyFromScreen` with Per-Monitor V2 DPI awareness and `GetDpiForMonitor` scale telemetry.
  - **macOS (Apple Silicon & Intel)**: Persistent CoreGraphics `CGEvent` + `NSWorkspace` + `NSPasteboard` + in-memory `CGWindowListCreateImage` PNG capture (with `screencapture` fallback) and Retina `2x` logical-point mapping.
  - **Linux (X11 & Wayland)**: Pure native X11 wire-protocol client (`XTEST` + `GetImage` + `BIG-REQUESTS` + `RANDR` + EWMH `_NET_CLIENT_LIST`/`_NET_ACTIVE_WINDOW`, zero external packages required) plus Wayland/CLI support (`grim`, `maim`, `ydotool`, `wtype`, `xdotool`, `wl-clipboard`, `xclip`, `xsel`).
  - **Virtual Desktop (`HANDY_BACKEND=virtual`)**: Built-in `1280x800` multi-window interactive desktop workbench for headless CI and safe agent sandboxing.

---

## Install on Any PC

Requires **Node.js 20+**.

### 1. One-Command Auto-Setup (Claude Desktop, Cursor, Windsurf, Claude Code)

```bash
npx -y @miisodev/handy install
```

Preview changes first with `--dry-run`, target a single host (`handy install cursor`), or remove cleanly (`handy uninstall`). Backups (`*.handy.bak`) are created automatically before modifying existing config files.

### 2. Prepackaged Plugin (Claude Code / Agent Marketplaces)

Installs the stdio MCP server, the `handy` operational skill (`skills/handy/SKILL.md`), and the `/handy:on`, `/handy:off`, `/handy:toggle`, `/handy:status`, `/handy:doctor`, and `/handy:windows` commands together:

```bash
claude plugin marketplace add miisodev/handy
claude plugin install handy
```

### 3. Global CLI + Live Control Panel

```bash
npm install -g @miisodev/handy
handy doctor
handy ui                  # Launch local Control Panel at http://127.0.0.1:7788
```

### 4. Manual Stdio MCP Configuration

```json
{
  "mcpServers": {
    "handy": {
      "command": "npx",
      "args": ["-y", "@miisodev/handy", "mcp"]
    }
  }
}
```

---

## Permission Controls & Human Failsafe

Handy stores its permission toggle at `~/.handy/permissions.json` (`0600`) and checks it synchronously before every `handy_see` screen capture, `handy_windows`/`handy_clipboard` call, and before **every individual step** of a `handy_act` chain.

```bash
handy off                 # Immediately block all LLM screen viewing & input control
handy on                  # Enable full screen vision & mouse/keyboard control
handy toggle              # Flip between ON and OFF
handy on --view-only      # Allow screen viewing (handy_see), block mouse & keyboard
handy on --ttl 30m        # Auto-disable after 30 minutes
handy ui                  # Open live browser switchboard + coordinate inspector
handy status              # Check current toggle state, backend, windows & displays
```

- **Physical Failsafe**: Slamming your mouse cursor into the top-left `(0, 0)` corner aborts any in-flight chain and releases held keys/buttons immediately.
- **Prompt-Injection Guard**: When turned OFF by the user, an MCP client **cannot** re-enable Handy on its own, while calling `handy_permission({ "action": "off" })` is always permitted as a one-way stop switch.

---

## MCP Tools

| Tool | Description |
| --- | --- |
| `handy_see` | Capture the live screen, a single `window`, or a zoomed `region` with dual-contrast `(x, y)` rulers, cursor reticle, `pixelUnderMouse`, `activeWindow`, `screenDiff`, and `highlightDiff`. With `marks: true` it also detects, numbers, and returns every interactive UI element (`elements`). |
| `handy_act` | Execute single or chained native mouse, keyboard, paste, window-focus, and smart visual-wait (`wait_for_change`, `wait_for_settled`, `wait_for_color`) controls with `screen`/`normalized`/`window` coordinates, `mark` element references, `motion` profiles, numbered trail markers, and optional `verifyChange` post-conditions. |
| `handy_windows` | List visible desktop windows (`title`, `app`, `bounds`, `focused`) or focus a window by `title`, `app`, or `id`. |
| `handy_clipboard` | Read or write plain-text system clipboard directly. |
| `handy_status` | Inspect live permission toggle state (`ON`/`OFF`), mode (`full`/`view_only`), OS backend, displays, active window, and cursor coordinates. |
| `handy_permission` | Query permission status or immediately turn Handy `off`. |

### Example: Chained Window Focus + Instant Paste + Smart Visual Settle (`handy_act`)

```json
{
  "actions": [
    { "type": "focus_window", "title": "Workbench" },
    { "type": "click", "x": 250, "y": 172 },
    { "type": "paste", "text": "Sam — ready for review 🚀", "submit": true },
    { "type": "wait_for_settled", "quietMs": 200 }
  ],
  "screenshotAfter": true
}
```

### Example: See the Screen as Numbered Elements, Then Click One (`marks`)

Two calls, no coordinate arithmetic. Ask for a marked capture, pick the element you want by index, and act on it:

```json
// handy_see
{ "marks": true, "maxMarks": 30 }
```

```json
// handy_act — mark 13 was the "Submit" button in the capture above
{
  "actions": [
    { "type": "click", "mark": 5 },
    { "type": "paste", "text": "Sam — ready for review 🚀" },
    { "type": "click", "mark": 13 },
    { "type": "wait_for_settled", "quietMs": 200 }
  ],
  "verifyChange": true
}
```

`handy_see` returns each element's `index`, `kind`, bounds, `centerX`/`centerY`, and a `score`, and the marks stay valid for subsequent `handy_act` calls until the next marked capture. In the CLI, where every command is a separate process, a mark reference detects elements from the live screen on demand instead — detection is deterministic for an unchanged screen, so `see --marks` and a later `act` agree on the numbering. To guarantee the indices cannot drift (if the screen may change between commands), do both in one chain: `handy act '[{"type":"screenshot","marks":true},{"type":"click","mark":5}]'`. `verifyChange: true` adds a before/after frame diff so the receipt reports whether the screen actually changed — a cheap post-condition check that catches clicks which landed but did nothing.

The equivalent chain-DSL form works everywhere a chain is accepted:

```bash
handy see --marks --out marked.png
handy act 'click mark 5 -> paste "Sam" -> click mark 13 -> wait_for_settled'
```

---

## Standalone CLI Usage

```bash
# Capture coordinate-mapped screen image — or zoom into a single window
handy see --out screen.png
handy see --window "Scratchpad" --highlight-diff --out scratchpad.png

# Detect & number interactive UI elements, printing each mark's centre, bounds, and score
handy see --marks --out marked.png
handy see --marks --max-marks 20 --json

# Inspect & focus desktop windows
handy windows
handy focus "Visual Studio Code"

# Read or write system clipboard
handy clipboard get
handy clipboard set "Copied from terminal"

# Execute a chained control sequence using human shorthand or JSON
handy act 'focus "Scratchpad" -> click 800 420 -> paste "Hello 🌍" -> wait_for_settled' --screenshot-after after.png

# Click a detected element by mark instead of by coordinate
handy act 'click mark 5 -> type "Sam" -> click #13' --json
```

---

## License

MIT © [Kevin Miiso Novo](https://github.com/miisodev)
