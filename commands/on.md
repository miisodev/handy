---
description: Enable Handy computer control permissions (turn ON screen vision and mouse/keyboard control)
allowed-tools: Bash(node *)
---

Turn Handy computer control **ON** by running the plugin CLI:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/handy.js" on $ARGUMENTS
```

Report the resulting permission state (`ON`, mode `full` or `view_only`, and any `--ttl` expiration) concisely to the user.
