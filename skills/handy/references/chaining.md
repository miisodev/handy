# Chained Controls Reference

`handy_act` executes an ordered array of `actions` sequentially inside a serialized lock, checking the user's permission toggle and top-left `(0, 0)` human failsafe before every step and automatically releasing any held mouse buttons or modifier keys if a chain aborts.

## Supported Step Types (20 Variants)

- **Window Focus**:
  - `{ "type": "focus_window", "title": "Visual Studio Code" }` (or match by `"app"` or `"id"` from `handy_windows`)
> **Every pointer step below accepts `{ "mark": N }` in place of `x`/`y`** — targeting a detected UI element from the last `handy_see({ marks: true })` instead of raw coordinates. This applies to `move`, `click`, `double_click`, `triple_click`, `right_click`, `scroll`, and both `drag` endpoints (`fromMark` / `toMark`). Prefer it whenever the element was detected; see `references/marks.md`.

- **Mouse Movement**:
  - `{ "type": "move", "x": 420, "y": 260, "relative": false, "durationMs": 0 }` or `{ "type": "move", "mark": 5 }`
  - Set `durationMs` (e.g. `150`) when hovering over menus that expect smooth pointer motion.
  - `motion: "linear" | "ease" | "human"` selects the interpolation curve when `durationMs > 0`. `"human"` bows the path into a shallow arc and derives its own Fitts's-law duration when `durationMs` is omitted.
- **Clicks**:
  - `{ "type": "click", "x": 420, "y": 260, "button": "left", "count": 1, "modifiers": ["shift"] }`
  - `{ "type": "double_click", "x": 420, "y": 260 }`
  - `{ "type": "triple_click", "x": 420, "y": 260 }` (selects an entire line/paragraph)
  - `{ "type": "right_click", "x": 420, "y": 260 }`
  - By mark: `{ "type": "click", "mark": 13 }`
- **Drag and Drop**:
  - `{ "type": "drag", "fromX": 820, "fromY": 190, "toX": 500, "toY": 420, "durationMs": 200 }`
  - `{ "type": "drag", "fromMark": 4, "toMark": 11 }` — either endpoint may be a mark, mixed with coordinates freely.
  - Drags always interpolate (160ms / 16 steps by default) so the gesture reads as continuous motion.
- **Mouse Wheel Scroll**:
  - `{ "type": "scroll", "x": 350, "y": 500, "direction": "down", "amount": 5 }`
  - `{ "type": "scroll", "mark": 22, "direction": "down", "amount": 4 }` — positions the cursor over a scrollable panel first.
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
  - `{ "type": "wait_for_color", "x": 420, "y": 260, "color": "#10b981", "tolerance": 24, "timeoutMs": 5000 }` — polls a tiny `3x3` patch around `(x, y)` until the pixel matches the target hex color!
  - `{ "type": "wait", "ms": 250 }`
  - `{ "type": "screenshot", "label": "menu-open", "window": "Code", "highlightDiff": true }`

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

### Mark-Driven Form Fill + Verified Submit
Take one marked capture, then drive the whole form by element index. No coordinate transcription, and `verifyChange` proves the submit did something:
```json
{
  "actions": [
    { "type": "focus_window", "title": "Workbench" },
    { "type": "click", "mark": 5 },
    { "type": "paste", "text": "Sam — ready for review 🚀" },
    { "type": "click", "mark": 13 },
    { "type": "wait_for_settled", "timeoutMs": 4000, "quietMs": 300 }
  ],
  "screenshotAfter": true,
  "verifyChange": true
}
```
The chain-DSL equivalent is `focus "Workbench" -> click mark 5 -> paste "Sam" -> click mark 13 -> wait_for_settled`.

### Post-Action Verification (`verifyChange: true`)
Handy captures a baseline frame before the chain and diffs the screen afterwards, adding two fields to the receipt:
- `changed` — `true` when the screen moved at all.
- `change` — `{ changedPercent, changedPixels, changedBounds }`, with `changedBounds` in global logical screen coordinates.

`changed: false` after a click that should have done something is a strong signal: the click landed but nothing happened. That usually means a disabled control, an unfocused window, or a mark that resolved to a label rather than the button itself. Re-capture with `marks: true` and re-read the element list instead of retrying the same coordinates.

### Numbered Action Trail Verification (`showTrail: true`)
When `screenshotAfter: true` is set, Handy renders numbered amber markers (`#1`, `#2`, plus drag vector lines) at every click/drag target from the chain so you can immediately spot if a click landed 10px off a button without guessing. Marks that resolved from detection are drawn at their resolved centre, so the trail also confirms where each mark actually pointed.
