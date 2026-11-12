# handy

![version](https://img.shields.io/badge/version-1.0.0-0ea5e9)
![license](https://img.shields.io/badge/license-MIT-10b981)
![platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-334155)

**Real-time native mouse, keyboard, and coordinate-mapped screen control for LLMs and agents.**

Handy lets LLMs see your computer screen in real-time with mapped `(x, y)` coordinate rulers and a live cursor reticle, and control the mouse and keyboard natively with **chained multi-step actions** (for example: *move mouse -> click -> type `"Sam"`* in a single call). It installs cleanly on any PC with zero C++ addon compilation (`node-gyp` free) and ships prepackaged as a stdio MCP server and agent plugin with operational skills and an instant **on/off permission toggle**.

---

## Highlights

- **Chained Real-Time Controls (`handy_act`)**: Execute sequential steps (`move`, `click`, `double_click`, `triple_click`, `right_click`, `drag`, `scroll`, `type`, `key`, `mouse_down`/`up`, `key_down`/`up`, `wait`, `screenshot`) in one atomic call, plus `screenshotAfter: true` to execute and visually verify in a single LLM turn.
- **Coordinate-Mapped Vision (`handy_see`)**: Renders exact OS screen coordinate rulers, subtle `(x, y)` intersection pills, and a high-contrast `MOUSE (x,y)` reticle onto captured screenshots — preventing DPI/Retina scaling drift and model image-resizing offsets. Supports `region` zoom at 1:1 resolution while preserving global screen coordinates.
- **Instant On/Off Permission Toggle**: Toggle LLM access live at any time via CLI (`handy off` / `handy on` / `handy toggle`), plugin slash commands (`/handy:off` / `/handy:on` / `/handy:toggle`), `--view-only` mode, or `--ttl` auto-expiring timers — without restarting your MCP client.
- **Works on Any PC Out of the Box**:
  - **Windows 10/11**: Persistent Win32 `SendInput` (`KEYEVENTF_UNICODE`, `MOUSEEVENTF_VIRTUALDESK`) + GDI `CopyFromScreen` with Per-Monitor V2 DPI awareness.
  - **macOS (Apple Silicon & Intel)**: Persistent CoreGraphics `CGEvent` bridge + `screencapture` with Retina `2x` logical-point mapping.
  - **Linux (X11 & Wayland)**: Pure native X11 wire-protocol client (`XTEST` + `GetImage` + `BIG-REQUESTS` + `RANDR` over `/tmp/.X11-unix/X0`, zero external packages required) plus Wayland/CLI support (`grim`, `ydotool`, `wtype`, `xdotool`).
  - **Virtual Desktop (`HANDY_BACKEND=virtual`)**: Built-in `1280x800` interactive desktop workbench for headless CI and safe agent sandboxing.

---

## Install on Any PC

Requires **Node.js 20+**.

### 1. Prepackaged Plugin (Claude Code / Agent Marketplaces)

Installs the stdio MCP server, the `handy` operational skill (`skills/handy/SKILL.md`), and the `/handy:on`, `/handy:off`, `/handy:toggle`, and `/handy:status` permission commands together:

```bash
claude plugin marketplace add miisodev/handy
claude plugin install handy
```

### 2. Global CLI + Stdio MCP

```bash
npm install -g @miisodev/handy
handy doctor
```

Or run directly from GitHub / npx without global install:

```bash
npx -y @miisodev/handy mcp
```

### 3. Stdio MCP Configuration (Claude Desktop, Cursor, Windsurf, OpenCode)

Add Handy to your client's `mcpServers` configuration (or run `handy config` to print it):

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

## Permission Controls (On/Off Toggle)

Handy stores its permission toggle at `~/.handy/permissions.json` (`0600`) and checks it synchronously before every `handy_see` screen capture and before **every individual step** of a `handy_act` chain.

```bash
handy off                 # Immediately block all LLM screen viewing & input control
handy on                  # Enable full screen vision & mouse/keyboard control
handy toggle              # Flip between ON and OFF
handy on --view-only      # Allow screen viewing (handy_see), block mouse & keyboard
handy on --ttl 30m        # Auto-disable after 30 minutes
handy status              # Check current toggle state, active OS backend & displays
```

Inside plugin-capable agents, use `/handy:off`, `/handy:on`, `/handy:toggle`, and `/handy:status`.
When turned OFF by the user, an MCP client **cannot** re-enable Handy on its own (protecting against prompt injection), while calling `handy_permission({ "action": "off" })` is always permitted as a one-way agent stop switch.

---

## MCP Tools

| Tool | Description |
| --- | --- |
| `handy_see` | Capture the live screen (or a zoomed `region`) with mapped `(x, y)` rulers, grid badges, and a red `MOUSE (x,y)` reticle. |
| `handy_act` | Execute single or chained native mouse and keyboard controls sequentially in real-time, with optional `screenshotAfter: true`. |
| `handy_status` | Inspect live permission toggle state (`ON`/`OFF`), mode (`full`/`view_only`), OS backend, displays, and cursor coordinates. |
| `handy_permission` | Query permission status or immediately turn Handy `off`. |

### Example: Chained Mouse + Keyboard Call (`handy_act`)

Move the mouse to `(250, 172)`, click to focus the input field, type `"Sam"`, press `Enter`, and return a fresh coordinate-mapped screenshot in a single MCP tool call:

```json
{
  "actions": [
    { "type": "move", "x": 250, "y": 172 },
    { "type": "click" },
    { "type": "type", "text": "Sam", "submit": true }
  ],
  "screenshotAfter": true
}
```

### Supported `handy_act` Step Types

- `move`: `{ "type": "move", "x": 420, "y": 260, "relative": false, "durationMs": 0, "coordinateSpace": "screen" }`
- `click` / `double_click` / `triple_click` / `right_click`: `{ "type": "click", "x": 420, "y": 260, "button": "left", "count": 1, "modifiers": ["mod"] }`
- `drag`: `{ "type": "drag", "fromX": 820, "fromY": 190, "toX": 500, "toY": 420, "durationMs": 180 }`
- `scroll`: `{ "type": "scroll", "x": 350, "y": 500, "direction": "down", "amount": 5 }`
- `type`: `{ "type": "type", "text": "Sam", "delayMs": 0, "submit": false }`
- `key`: `{ "type": "key", "key": "mod+a" }` (`mod` maps to `Command` on macOS, `Ctrl` on Windows/Linux)
- `mouse_down` / `mouse_up` and `key_down` / `key_up` (automatically released if a chain errors or is aborted)
- `wait`: `{ "type": "wait", "ms": 200 }`
- `screenshot`: `{ "type": "screenshot", "region": { "x": 100, "y": 80, "width": 400, "height": 300 } }`

---

## Standalone CLI Usage

Handy also works directly from any terminal or shell script:

```bash
# Capture coordinate-mapped screen image
handy see --out screen.png

# Zoom into a specific region at 1:1 resolution (coordinates remain global)
handy see --region 100,120,450,300 --out zoom.png

# Execute a chained control sequence using human shorthand or JSON
handy act 'move 250 172 -> click -> type "Sam" -> key Enter' --screenshot-after after.png

# Individual quick commands
handy move 500 320
handy click 500 320
handy type "Sam" --submit
handy key mod+s
handy scroll down 4
```

---

## Platform Notes

- **macOS**: On first use, grant **Accessibility** and **Screen Recording** permissions to your terminal or MCP host in *System Settings -> Privacy & Security*. Run `handy doctor` to check status.
- **Windows**: Works immediately on Windows 10 and 11 via built-in PowerShell/.NET P/Invoke. Running as a standard user cannot interact with elevated Administrator UAC windows unless the host itself runs elevated.
- **Linux**: Connects directly to X11 over `/tmp/.X11-unix/X<n>` with zero external dependencies. On pure Wayland compositors without X11 root access, install `grim` and `ydotool` / `wtype`.

---

## License

MIT © [Kevin Miiso Novo](https://github.com/miisodev)
