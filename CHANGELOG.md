# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-11-12

### Added
- **Desktop Window Awareness & Focus (`handy_windows`, `focus_window`)**: List visible desktop windows with titles, owning apps, PIDs, and screen bounds `{ x, y, width, height }`, or bring a window to the foreground across Windows (`EnumWindows`/`SetForegroundWindow`), macOS (`CGWindowListCopyWindowInfo`/`NSRunningApplication`), Linux X11 (pure EWMH `_NET_CLIENT_LIST`/`_NET_ACTIVE_WINDOW` wire protocol), and Virtual Desktop.
- **Native Clipboard & Instant Paste (`handy_clipboard`, `paste`)**: Read/write Unicode clipboard text natively on Windows (MTA-safe Win32 `OpenClipboard`/`CF_UNICODETEXT`), macOS (`NSPasteboard`), Linux (`wl-clipboard`/`xclip`/`xsel`), and Virtual Desktop, plus a `paste` action step in `handy_act` with automatic clipboard preservation.
- **Smart Visual Synchronization (`wait_for_change`, `wait_for_settled`)**: Sub-2ms RGBA frame diffing lets chains wait until a UI region visibly updates or finishes animating instead of relying on fixed `wait` sleeps.
- **Richer Visual Perception (`handy_see`)**:
  - `pixelUnderMouse` (`#rrggbb` sampled from the raw unannotated frame before drawing the cursor reticle).
  - `activeWindow` metadata attached to `handy_see`, `handy_act`, and `handy_status`.
  - `screenDiff` (`changedPercent`, `changedPixels`, `changedBounds`) computed automatically between consecutive captures.
  - Dual-contrast coordinate grid lines (legible on both `#000000` dark and `#ffffff` light apps) and numbered amber **action-trail markers** (`#1`, `#2`, drag vectors) on `screenshotAfter` captures.
- **Physical Corner-Slam Failsafe**: Slamming the mouse cursor into the top-left `(0, 0)` corner aborts any active `handy_act` chain immediately and releases held inputs.
- **One-Command Host Installer (`handy install` / `handy uninstall`)**: Automatically registers or removes Handy in Claude Desktop, Cursor, Windsurf, and Claude Code with `--dry-run` and `.handy.bak` backups.
- **Local Live Control Panel (`handy ui`)**: Loopback (`127.0.0.1`) web dashboard with CSRF token protection, instant `ON` / `View Only` / `OFF` switches, live coordinate-mapped screen viewer, window switcher, and chain runner.
- **Faster Zero-Temp-File Captures**: In-memory CoreGraphics `CGWindowListCreateImage` PNG encoding on macOS (with `screencapture` fallback) and direct stdout PNG streaming for `grim`, `maim`, and `import` on Linux.

## [1.0.0] - 2026-11-12

### Added
- **Stdio MCP Server (`handy mcp`)**: Exposes `handy_see`, `handy_act`, `handy_status`, and `handy_permission`, plus `handy://status` and `handy://screen/current` resources and the `computer-control` workflow prompt.
- **Chained Real-Time Controls (`handy_act`)**: Execute sequential multi-step mouse and keyboard chains (move, click, double/triple/right click, drag, scroll, type, key chords, hold/release, wait, and mid/post-chain screenshots) in a single call with automatic held-input failsafe cleanup.
- **Coordinate-Mapped Screen Vision (`handy_see`)**: Real-time PNG screen capture annotated with exact OS screen coordinate rulers, interior `(x, y)` grid badges, `region` 1:1 zoom, and a high-contrast `MOUSE (x,y)` reticle.
- **Cross-Platform Native Backends**:
  - **Linux**: Pure native X11 wire-protocol backend (`XTEST` + `GetImage` + `BIG-REQUESTS` + `RANDR`, zero external packages required) plus Wayland/CLI backend (`grim`, `ydotool`, `wtype`, `xdotool`, `scrot`, `import`).
  - **macOS**: Persistent CoreGraphics JXA + `screencapture` backend with Retina logical-point coordinate mapping and Accessibility/Screen Recording diagnostics.
  - **Windows**: Persistent PowerShell + C# P/Invoke `SendInput` (`KEYEVENTF_UNICODE`, `MOUSEEVENTF_VIRTUALDESK`) and GDI `CopyFromScreen` backend with Per-Monitor V2 DPI awareness.
  - **Virtual**: Interactive `1280x800` virtual desktop (`HANDY_BACKEND=virtual`) for headless testing and CI.
- **Live Permission Toggle**: Atomic `~/.handy/permissions.json` on/off switch (`handy on`, `handy off`, `handy toggle`, `--view-only`, `--ttl`), enforced before every capture and every individual step in a chain.
- **Prepackaged Plugin & Skills**: Ships `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.mcp.json`, MCPB `manifest.json`, MCP Registry `server.json`, `skills/handy/SKILL.md`, and `/handy:on`, `/handy:off`, `/handy:toggle`, `/handy:status` commands.
