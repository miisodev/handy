# Permission Controls & Platform Setup

## The On/Off Permission Toggle

Handy enforces a live permission toggle stored atomically at `~/.handy/permissions.json` (mode `0600`) and checked before every `handy_see` call and before **every individual step** in `handy_act`.

### User Controls

- **CLI**:
  - `handy on` — Enable full computer vision and mouse/keyboard control
  - `handy on --view-only` — Allow `handy_see` screen viewing while blocking all mouse/keyboard actions
  - `handy on --ttl 30m` — Enable temporarily with automatic expiration
  - `handy off` — Immediately disable Handy (aborts in-flight chains and releases held keys/buttons)
  - `handy toggle` — Flip between ON and OFF
  - `handy status` — Inspect current toggle state, active backend, displays, and cursor position
- **Plugin Slash Commands**:
  - `/handy:on`, `/handy:off`, `/handy:toggle`, `/handy:status`
- **Desktop Extension / Host Environment**:
  - `HANDY_ENABLED=false` acts as a hard host-level OFF switch (wired to the boolean toggle in `manifest.json`).

### One-Way Agent Safety Rule

From MCP (`handy_permission`), the LLM may check `"status"` or turn Handy `"off"` when the user asks to stop. Once turned OFF by the user, MCP **cannot** re-enable Handy on its own (unless the user explicitly sets `HANDY_ALLOW_MCP_ENABLE=true`). This prevents prompt injection from re-granting desktop control after the user switches Handy off.

## Native OS Setup Diagnostics (`handy doctor`)

Run `handy doctor` on any PC to verify native readiness:

- **Windows 10/11**: Works out of the box via built-in `.NET` + Win32 `SendInput` and `CopyFromScreen` (zero extra downloads). Note: Windows UIPI blocks non-elevated processes from sending input to Administrator UAC prompts.
- **macOS**: Grant **Accessibility** (for mouse/keyboard control) and **Screen Recording** (for `handy_see`) to your terminal or MCP host application under *System Settings -> Privacy & Security*.
- **Linux (X11)**: Works natively out of the box over the X11 socket (`/tmp/.X11-unix/X0` + `XTEST` + `GetImage`) with zero external packages required.
- **Linux (Wayland)**: Uses `grim` for screen capture and `ydotool` / `wtype` for input when running on pure Wayland without X11 root access.
