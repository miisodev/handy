# Security Policy

## Supported Versions

| Version | Supported |
| --- | --- |
| 1.3.x | ✅ |
| 1.2.x | ✅ |
| 1.1.x | ✅ |
| 1.0.x | ✅ |

## Security Model

Handy gives local MCP-connected agents native mouse, keyboard, clipboard, window, and screen access on the host PC. Its security boundaries are enforced in code:

1. **Live User Permission Toggle (`~/.handy/permissions.json`, `0600`)**: Checked synchronously before every `handy_see` screen capture, `handy_windows` / `handy_clipboard` call, `handy://screen/current` resource read, and before **every individual step** in a `handy_act` chain. Running `handy off` (or `/handy:off`) immediately halts active chains and releases any held keys or mouse buttons.
2. **Physical Corner-Slam Failsafe**: Slamming the physical mouse cursor into the top-left `(0, 0)` screen corner immediately aborts any in-flight `handy_act` chain and releases held inputs.
3. **One-Way MCP Disable**: An agent may call `handy_permission({ action: "off" })` to disable Handy, but once turned OFF by the user, MCP **cannot** re-enable Handy unless `HANDY_ALLOW_MCP_ENABLE=true` is explicitly configured by the host owner.
4. **Zero Shell Interpolation**: All native OS helper invocations (`osascript`, `screencapture`, `powershell.exe`, `xdotool`, `grim`, `maim`, `ydotool`, `wtype`, `xclip`, `xsel`, `wl-copy`) pass strict argument arrays (`shell: false`).
5. **Loopback + CSRF-Protected Control Panel**: `handy ui` binds strictly to `127.0.0.1` by default and requires a per-session random `X-Handy-Token` header on all `/api/*` endpoints to prevent drive-by browser CSRF or DNS-rebinding attacks.

## Reporting a Vulnerability

Please report security vulnerabilities privately via [GitHub Security Advisories](https://github.com/miisodev/handy/security/advisories/new) or by emailing `miisodev@gmail.com`. Do not open public issues for undisclosed vulnerabilities.
