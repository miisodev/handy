---
name: handy
description: "Real-time native computer control and coordinate-mapped screen vision via the Handy MCP (`handy_see`, `handy_act`, `handy_status`, `handy_permission`). Activate whenever a task requires viewing the live desktop, clicking UI elements, dragging, scrolling, typing text, sending keyboard shortcuts, or chaining multi-step GUI workflows."
license: MIT
---

# Handy — Operational Skill

Real-time native mouse, keyboard, and coordinate-mapped screen vision across Windows, macOS, and Linux. Operate through the **See -> Chain -> Verify** loop so every click hits on the first try and multi-step interactions complete in a single round-trip.

---

## Core Operating Loop

```
1. ORIENT   handy_status()             when unsure whether Handy is ON or what displays exist
2. SEE      handy_see(...)             read mapped (x, y) coordinates and the live MOUSE reticle
   [ZOOM]   handy_see(region={...})    for dense toolbars, small icons, or ambiguous targets
3. ACT      handy_act(actions=[...],   chain sequential controls in ONE call + verify immediately
                      screenshotAfter=true)
4. STOP     handy_permission("off")    when asked to relinquish control or on emergency stop
```

---

## The Four Rules

1. **Never click blind.** Call `handy_see` before clicking an unfamiliar window or control. Read `(x, y)` directly from the top/left coordinate rulers and interior `x,y` intersection pills — those numbers are **exact OS screen coordinates**, even when the image is downscaled via `maxWidth` or zoomed via `region`.
2. **Chain deterministic sequences.** When steps belong to one interaction — moving to an input field, clicking to focus it, typing `"Sam"`, and pressing `Enter` — send them together in a single `handy_act` call with `screenshotAfter: true` instead of spending four separate turns. Break a chain only at points where the UI layout is unknown until something loads.
3. **Use `mod` for shortcuts.** Write `"mod+c"`, `"mod+v"`, `"mod+a"`, `"mod+s"`, `"mod+w"` in `key` steps so Handy automatically dispatches `Command` on macOS and `Ctrl` on Windows and Linux.
4. **Respect permissions and irreversible boundaries.** If `handy_see` or `handy_act` reports `HANDY_PERMISSION_DENIED`, stop and ask the user to run `handy on` or `/handy:on` — never attempt to bypass user permission controls. Ask the user before executing irreversible GUI actions (deleting files, submitting payments, sending external messages, or altering security settings).

---

## Tool Quick Reference

| Tool | Purpose | Key Parameters |
|---|---|---|
| `handy_see` | Live screen capture with mapped `(x, y)` grid & red `MOUSE (x,y)` reticle | `display`, `region: { x, y, width, height }`, `grid`, `gridStep`, `showMouse`, `maxWidth` |
| `handy_act` | Execute 1–100 native mouse/keyboard steps sequentially in real-time | `actions: [...]`, `stepDelayMs` (default `15`), `screenshotAfter`, `settleMs` |
| `handy_status` | Read permission toggle (`ON`/`OFF`), mode (`full`/`view_only`), displays, mouse | *(none)* |
| `handy_permission` | Inspect toggle state or immediately turn Handy `off` | `action: "status" \| "off" \| "on"` |

---

## Canonical Chained Action Example

Move to a text input at `(250, 172)`, click to focus, type `"Sam"`, click Submit at `(195, 325)`, and return the updated screen in one call:

```json
{
  "actions": [
    { "type": "move", "x": 250, "y": 172 },
    { "type": "click" },
    { "type": "type", "text": "Sam" },
    { "type": "click", "x": 195, "y": 325 }
  ],
  "screenshotAfter": true
}
```

---

## Reference Guides

- Chained control patterns, form entry, text replacement, drag-and-drop, and scroll recipes: `references/chaining.md`
- Coordinate spaces (`screen` vs `normalized`), Retina/DPI scaling, multi-monitor layouts, and `region` zoom: `references/coordinates.md`
- Permission toggle (`on` / `off` / `toggle` / `view-only`), OS Accessibility/Screen Recording setup, and safety rules: `references/permissions.md`
