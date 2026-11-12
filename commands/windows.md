---
description: List visible desktop windows with their titles, owning apps, focus state, and screen bounds
allowed-tools: Bash(node *)
---

List all visible desktop windows and their screen coordinates:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/handy.js" windows
```

Present the open windows clearly, noting which window is currently focused and its `{ x, y, width, height }` bounds.
