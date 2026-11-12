# Privacy Policy

Handy executes **100% locally** on your computer.

- **No telemetry or analytics**: Handy collects no usage metrics, crash reports, or identifiers, and makes zero outbound network connections.
- **Screen and input data**: Screenshots captured by `handy_see` are generated in memory and returned solely over the local `stdio` Model Context Protocol pipe to the MCP client you explicitly configured (for example Claude Desktop, Claude Code, or Cursor).
- **Local state**: Only your on/off permission toggle state (`enabled`, `mode`, `expiresAt`, `updatedAt`) is stored locally at `~/.handy/permissions.json` with `0600` owner-only permissions.
- **Audit logging**: When `HANDY_LOG=1` is enabled for debugging, Handy writes operational metadata to `stderr` and redacts typed text payloads (recording character counts rather than raw keystrokes).
