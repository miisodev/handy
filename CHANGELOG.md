# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
