---
description: Run Handy native OS input, clipboard, window, and screen capture readiness diagnostics
allowed-tools: Bash(node *)
---

Run Handy's native OS readiness checks and report each capability:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/handy.js" doctor
```

Summarize whether input simulation, screen capture, window enumeration, and clipboard access passed, and share any OS permission steps if a check failed.
