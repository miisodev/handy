# Chained Controls Reference

`handy_act` executes an ordered array of `actions` sequentially inside a serialized lock, checking the user's permission toggle before every step and automatically releasing any held mouse buttons or modifier keys if a chain aborts.

## Supported Step Types

- **Mouse movement**: `{ "type": "move", "x": 420, "y": 260, "relative": false, "durationMs": 0 }`
  - Set `durationMs` (e.g. `150`) when hovering over menus that expect smooth pointer motion.
  - Set `relative: true` to move `(dx, dy)` pixels from the current cursor.
- **Clicks**:
  - `{ "type": "click", "x": 420, "y": 260, "button": "left", "count": 1, "modifiers": ["shift"] }` (`x`, `y` optional — omits move when already positioned)
  - `{ "type": "double_click", "x": 420, "y": 260 }`
  - `{ "type": "triple_click", "x": 420, "y": 260 }` (selects an entire line/paragraph in most inputs)
  - `{ "type": "right_click", "x": 420, "y": 260 }`
- **Drag and drop**:
  - `{ "type": "drag", "fromX": 820, "fromY": 190, "toX": 500, "toY": 420, "durationMs": 200 }`
- **Mouse wheel scroll**:
  - `{ "type": "scroll", "x": 350, "y": 500, "direction": "down", "amount": 5 }`
  - Or explicit ticks: `{ "type": "scroll", "deltaX": 0, "deltaY": 5 }`
- **Typing text**:
  - `{ "type": "type", "text": "Sam", "submit": false, "delayMs": 0 }`
  - Set `submit: true` to tap `Enter` immediately after typing.
- **Keys & shortcuts**:
  - `{ "type": "key", "key": "Enter" }`, `{ "type": "key", "key": "mod+a" }`, `{ "type": "key", "key": "ctrl+shift+t" }`, `{ "type": "key", "key": "ArrowDown", "count": 3 }`
- **Explicit hold / release**:
  - `{ "type": "mouse_down", "button": "left" }` / `{ "type": "mouse_up", "button": "left" }`
  - `{ "type": "key_down", "key": "shift" }` / `{ "type": "key_up", "key": "shift" }`
- **Timing & mid-chain visual checkpoints**:
  - `{ "type": "wait", "ms": 250 }`
  - `{ "type": "screenshot", "label": "menu-open", "region": { "x": 100, "y": 40, "width": 320, "height": 400 } }`

## High-Reliability Recipes

### Replace Existing Input Text Cleanly
Instead of guessing how many `Backspace` presses are needed, select all then type:

```json
{
  "actions": [
    { "type": "click", "x": 280, "y": 175 },
    { "type": "key", "key": "mod+a" },
    { "type": "key", "key": "Backspace" },
    { "type": "type", "text": "Sam", "submit": true }
  ],
  "screenshotAfter": true
}
```

### Fill Multiple Form Fields via Tab
When fields follow standard tab order, click the first input once and chain `Tab`:

```json
{
  "actions": [
    { "type": "click", "x": 260, "y": 175 },
    { "type": "type", "text": "Sam" },
    { "type": "key", "key": "Tab" },
    { "type": "type", "text": "Ready for review" },
    { "type": "key", "key": "Enter" }
  ],
  "screenshotAfter": true
}
```

### When NOT to Over-Chain
Stop a chain and inspect `screenshotAfter: true` whenever:
- Clicking opens a dynamic modal, network-loaded page, or OS file dialog whose layout is not yet visible.
- Performing an action with side effects where visual confirmation is required before proceeding.
