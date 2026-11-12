---
name: handy
description: "Real-time native computer control, window/clipboard automation, and coordinate-mapped screen vision via the Handy MCP (`handy_see`, `handy_act`, `handy_windows`, `handy_clipboard`, `handy_status`, `handy_permission`). Activate whenever a task requires viewing the live desktop, focusing windows, clicking UI elements, dragging, scrolling, typing or pasting text, sending shortcuts, or chaining multi-step GUI workflows."
license: MIT
---

# Handy — Operational Skill

Real-time native mouse, keyboard, clipboard, window, and coordinate-mapped screen vision across Windows, macOS, and Linux. Operate through the **See -> Chain -> Verify** loop so every click hits on the first try and multi-step interactions complete in a single round-trip.

---

## Core Operating Loop

```
1. ORIENT   handy_status() / handy_windows("list")  check toggle, displays & open window bounds
2. SEE      handy_see(...)                          read mapped (x, y) coordinates, pixel hex & frame diff
   [ZOOM]   handy_see(region={...})                 for dense toolbars, small icons, or ambiguous targets
3. ACT      handy_act(actions=[...],                chain focus/click/paste/smart-waits in ONE call
                      screenshotAfter=true)         and verify numbered #1, #2 trail markers
4. STOP     handy_permission("off")                 when asked to relinquish control or on emergency stop
```

---

## The Five Rules

1. **Never click blind.** Call `handy_see` before clicking an unfamiliar window or control. Read `(x, y)` directly from the top/left coordinate rulers and interior `x,y` intersection pills — those numbers are **exact OS screen coordinates**, even when the image is downscaled via `maxWidth` or zoomed via `region`.
2. **Focus target windows cleanly.** Use `handy_windows({ action: "focus", title: "..." })` or `{ "type": "focus_window", "title": "..." }` as the first step of `handy_act` instead of hunting for minimized/background windows on the taskbar.
3. **Prefer `paste` for long or Unicode text, and smart waits over blind sleeps.** Use `{ "type": "paste", "text": "..." }` for multi-line code, URLs, or emojis (it preserves the user's previous clipboard automatically), and `{ "type": "wait_for_change" }` / `{ "type": "wait_for_settled" }` instead of guessing `wait` durations.
4. **Chain deterministic sequences.** Combine related steps (`focus_window -> click -> paste -> key Enter -> wait_for_settled`) in a single `handy_act` call with `screenshotAfter: true`. Use `"mod+c"`, `"mod+v"`, `"mod+a"`, `"mod+s"` so shortcuts map automatically to `Command` on macOS and `Ctrl` on Windows/Linux.
5. **Respect permissions, the `(0,0)` failsafe, and irreversible boundaries.** If `HANDY_PERMISSION_DENIED` is returned, ask the user to run `handy on` or `/handy:on`. If the human slams the mouse to `(0,0)` to trigger the failsafe, stop immediately and check in with the user. Always confirm before irreversible actions (deleting files, submitting payments, sending external messages).

---

## Tool Quick Reference

| Tool | Purpose | Key Parameters |
|---|---|---|
| `handy_see` | Live screen capture with mapped `(x, y)` grid, `MOUSE (x,y)` reticle, `pixelUnderMouse`, `activeWindow`, and `screenDiff` | `display`, `region: { x, y, width, height }`, `grid`, `gridStep`, `showMouse`, `maxWidth` |
| `handy_act` | Execute 1–100 native mouse, keyboard, paste, focus, and smart-wait steps sequentially | `actions: [...]`, `stepDelayMs`, `screenshotAfter`, `showTrail`, `failsafe` |
| `handy_windows` | List visible windows with bounds or focus a target window by `title`, `app`, or `id` | `action: "list" \| "focus"`, `title`, `app`, `id` |
| `handy_clipboard` | Read or write plain-text system clipboard directly | `action: "read" \| "write"`, `text` |
| `handy_status` | Read permission toggle (`ON`/`OFF`), mode (`full`/`view_only`), displays, active window, mouse | *(none)* |
| `handy_permission` | Inspect toggle state or immediately turn Handy `off` | `action: "status" \| "off" \| "on"` |

---

## Canonical Chained Action Example

Focus the target app window, click the input at `(250, 172)`, paste `"Sam"`, click Submit at `(195, 325)`, wait for the UI to settle, and return the annotated screenshot with numbered `#1`, `#2` trail markers:

```json
{
  "actions": [
    { "type": "focus_window", "title": "Workbench" },
    { "type": "click", "x": 250, "y": 172 },
    { "type": "paste", "text": "Sam" },
    { "type": "click", "x": 195, "y": 325 },
    { "type": "wait_for_settled", "quietMs": 200 }
  ],
  "screenshotAfter": true
}
```

---

## Reference Guides

- Chained control patterns, instant clipboard paste, window focus, smart visual waits, and drag/scroll recipes: `references/chaining.md`
- Coordinate spaces (`screen` vs `normalized`), Retina/DPI scaling, multi-monitor layouts, and `region` zoom: `references/coordinates.md`
- Permission toggle (`on` / `off` / `toggle` / `view-only`), `(0,0)` failsafe, OS Accessibility/Screen Recording setup, and safety rules: `references/permissions.md`
