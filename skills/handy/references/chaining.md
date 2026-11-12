# Chained Controls Reference

`handy_act` executes an ordered array of `actions` sequentially inside a serialized lock, checking the user's permission toggle and top-left `(0, 0)` human failsafe before every step and automatically releasing any held mouse buttons or modifier keys if a chain aborts.

## Supported Step Types (19 Variants)

- **Window Focus**:
  - `{ "type": "focus_window", "title": "Visual Studio Code" }` (or match by `"app"` or `"id"` from `handy_windows`)
- **Mouse Movement**:
  - `{ "type": "move", "x": 420, "y": 260, "relative": false, "durationMs": 0 }`
  - Set `durationMs` (e.g. `150`) when hovering over menus that expect smooth pointer motion.
- **Clicks**:
  - `{ "type": "click", "x": 420, "y": 260, "button": "left", "count": 1, "modifiers": ["shift"] }`
  - `{ "type": "double_click", "x": 420, "y": 260 }`
  - `{ "type": "triple_click", "x": 420, "y": 260 }` (selects an entire line/paragraph)
  - `{ "type": "right_click", "x": 420, "y": 260 }`
- **Drag and Drop**:
  - `{ "type": "drag", "fromX": 820, "fromY": 190, "toX": 500, "toY": 420, "durationMs": 200 }`
- **Mouse Wheel Scroll**:
  - `{ "type": "scroll", "x": 350, "y": 500, "direction": "down", "amount": 5 }`
- **Instant Clipboard Paste** *(fastest & most reliable for long/Unicode/multi-line text)*:
  - `{ "type": "paste", "text": "Hello 🌍\nLine 2", "submit": false, "restoreClipboard": true }`
  - Preserves and restores the user's prior clipboard text automatically.
- **Character-by-Character Typing**:
  - `{ "type": "type", "text": "Sam", "submit": false, "delayMs": 0 }`
- **Keys & Shortcuts**:
  - `{ "type": "key", "key": "Enter" }`, `{ "type": "key", "key": "mod+a" }`, `{ "type": "key", "key": "ctrl+shift+t" }`, `{ "type": "key", "key": "ArrowDown", "count": 3 }`
- **Explicit Hold / Release**:
  - `{ "type": "mouse_down", "button": "left" }` / `{ "type": "mouse_up", "button": "left" }`
  - `{ "type": "key_down", "key": "shift" }` / `{ "type": "key_up", "key": "shift" }`
- **Smart Visual Synchronization & Checkpoints**:
  - `{ "type": "wait_for_change", "timeoutMs": 5000, "thresholdPercent": 0.25, "region": { ... } }` — continues the instant the screen (or region) visibly updates!
  - `{ "type": "wait_for_settled", "timeoutMs": 5000, "quietMs": 250, "region": { ... } }` — waits until animations, transitions, or smooth scrolling finish settling!
  - `{ "type": "wait", "ms": 250 }`
  - `{ "type": "screenshot", "label": "menu-open", "region": { "x": 100, "y": 40, "width": 320, "height": 400 } }`

## High-Reliability Recipes

### Focus Window + Replace Existing Input Text + Wait for UI Settle
```json
{
  "actions": [
    { "type": "focus_window", "title": "Browser" },
    { "type": "click", "x": 280, "y": 175 },
    { "type": "key", "key": "mod+a" },
    { "type": "paste", "text": "https://example.com", "submit": true },
    { "type": "wait_for_settled", "timeoutMs": 4000, "quietMs": 300 }
  ],
  "screenshotAfter": true
}
```

### Numbered Action Trail Verification (`showTrail: true`)
When `screenshotAfter: true` is set, Handy renders numbered amber markers (`#1`, `#2`, plus drag vector lines) at every click/drag target from the chain so you can immediately spot if a click landed 10px off a button without guessing.
