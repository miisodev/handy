---
description: Immediately disable Handy computer control permissions (turn OFF screen vision and mouse/keyboard control)
allowed-tools: Bash(node *)
---

Turn Handy computer control **OFF** immediately by running the plugin CLI:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/handy.js" off
```

Confirm to the user that Handy is now **OFF** and all LLM screen capture and mouse/keyboard controls are blocked until re-enabled.
