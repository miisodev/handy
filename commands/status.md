---
description: Inspect Handy permission toggle state, active native OS backend, displays, and mouse position
allowed-tools: Bash(node *)
---

Inspect the current Handy status and OS readiness checks:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/handy.js" status
node "${CLAUDE_PLUGIN_ROOT}/bin/handy.js" doctor
```

Summarize whether Handy is **ON** or **OFF**, the active OS backend, connected displays, and any OS permission setup needed.
