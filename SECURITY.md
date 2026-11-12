# Security Policy

## Supported Versions

| Version | Supported |
| --- | --- |
| 1.0.x | ✅ |

## Security Model

Handy gives local MCP-connected agents native mouse, keyboard, and screen access on the host PC. Its security boundaries are enforced in code:

1. **Live User Permission Toggle (`~/.handy/permissions.json`, `0600`)**: Checked synchronously before every `handy_see` screen capture, `handy://screen/current` resource read, and before **every individual step** in a `handy_act` chain. Running `handy off` (or `/handy:off`) immediately halts active chains and releases any held keys or mouse buttons.
2. **One-Way MCP Disable**: An agent may call `handy_permission({ action: "off" })` to disable Handy, but once turned OFF by the user, MCP **cannot** re-enable Handy unless `HANDY_ALLOW_MCP_ENABLE=true` is explicitly configured by the host owner.
3. **Zero Shell Interpolation**: All native OS helper invocations (`osascript`, `screencapture`, `powershell.exe`, `xdotool`, `grim`, `ydotool`, `wtype`) pass strict argument arrays (`shell: false`).
4. **Local-Only Execution**: Handy runs purely over `stdio` and local OS IPC; it opens no network listeners and sends zero telemetry.

## Reporting a Vulnerability

Please report security vulnerabilities privately via [GitHub Security Advisories](https://github.com/miisodev/handy/security/advisories/new) or by emailing `miisodev@gmail.com`. Do not open public issues for undisclosed vulnerabilities.
