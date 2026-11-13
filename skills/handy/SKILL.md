---
name: handy
description: "Real-time native computer control, window/clipboard automation, coordinate-mapped screen vision, and Set-of-Mark UI element detection via the Handy MCP (`handy_see`, `handy_act`, `handy_windows`, `handy_clipboard`, `handy_status`, `handy_permission`). Activate whenever a task requires viewing the live desktop, identifying or clicking UI elements, focusing windows, dragging, scrolling, typing or pasting text, sending shortcuts, or chaining multi-step GUI workflows."
license: MIT
---

# Handy — Operational Skill

Real-time native mouse, keyboard, clipboard, window, and coordinate-mapped screen vision across Windows, macOS, and Linux. Operate through the **See -> Chain -> Verify** loop so every click hits on the first try and multi-step interactions complete in a single round-trip.

---

## Core Operating Loop

```
1. ORIENT   handy_status() / handy_windows("list")  check toggle, displays & open window bounds
2. SEE      handy_see(marks=true)                   get numbered UI elements with bounds & centres
   [ZOOM]   handy_see(window="...") / region={...}  1:1 window or region zoom while keeping global (x, y)
3. ACT      handy_act(actions=[{mark: N}, ...],     click elements by mark, chain focus/paste/smart-waits
                      verifyChange=true)            in ONE call, and confirm the screen really changed
4. STOP     handy_permission("off")                 when asked to relinquish control or on emergency stop
```

---

## The Five Rules

1. **Never click blind — and prefer a mark over a coordinate.** Call `handy_see({ marks: true })` before clicking an unfamiliar window or control. The numbered elements it returns are the target list: pass `{ "type": "click", "mark": 5 }` instead of transcribing pixels, and the mark resolves to that element's own centre at execution time. Fall back to reading `(x, y)` from the top/left rulers and interior intersection pills when the element you need was not detected (custom-drawn canvases, games, video) — those numbers are **exact OS screen coordinates**, even when the image is downscaled via `maxWidth` or zoomed via `region`. See `references/marks.md`.
2. **Focus target windows cleanly.** Use `handy_windows({ action: "focus", title: "..." })` or `{ "type": "focus_window", "title": "..." }` as the first step of `handy_act` instead of hunting for minimized/background windows on the taskbar.
3. **Prefer `paste` for long or Unicode text, and smart waits over blind sleeps.** Use `{ "type": "paste", "text": "..." }` for multi-line code, URLs, or emojis (it preserves the user's previous clipboard automatically), and `{ "type": "wait_for_change" }` / `{ "type": "wait_for_settled" }` instead of guessing `wait` durations. Add `verifyChange: true` to `handy_act` when you need proof the interaction took effect — the receipt then reports `changed` and a before/after frame diff.
4. **Chain deterministic sequences.** Combine related steps (`focus_window -> click -> paste -> key Enter -> wait_for_settled`) in a single `handy_act` call with `screenshotAfter: true`. Use `"mod+c"`, `"mod+v"`, `"mod+a"`, `"mod+s"` so shortcuts map automatically to `Command` on macOS and `Ctrl` on Windows/Linux.
5. **Respect permissions, the `(0,0)` failsafe, and irreversible boundaries.** If `HANDY_PERMISSION_DENIED` is returned, ask the user to run `handy on` or `/handy:on`. If the human slams the mouse to `(0,0)` to trigger the failsafe, stop immediately and check in with the user. Always confirm before irreversible actions (deleting files, submitting payments, sending external messages).

---

## Tool Quick Reference

| Tool | Purpose | Key Parameters |
|---|---|---|
| `handy_see` | Live screen or single-window capture with mapped `(x, y)` grid, `MOUSE (x,y)` reticle, `pixelUnderMouse`, `activeWindow`, `screenDiff`, and numbered UI element `marks` | `marks`, `maxMarks`, `markKinds`, `minMarkScore`, `display`, `window`, `region: { x, y, width, height }`, `highlightDiff`, `grid`, `gridStep`, `showMouse`, `maxWidth` |
| `handy_act` | Execute 1–100 native mouse, keyboard, paste, focus, and smart-wait steps sequentially; pointer steps accept a `mark` reference instead of `x`/`y` | `actions: [...]`, `verifyChange`, `stepDelayMs`, `screenshotAfter`, `showTrail`, `highlightDiff`, `failsafe` |
| `handy_windows` | List visible windows with bounds or focus a target window by `title`, `app`, or `id` | `action: "list" \| "focus"`, `title`, `app`, `id` |
| `handy_clipboard` | Read or write plain-text system clipboard directly | `action: "read" \| "write"`, `text` |
| `handy_status` | Read permission toggle (`ON`/`OFF`), mode (`full`/`view_only`), displays, active window, mouse | *(none)* |
| `handy_permission` | Inspect toggle state or immediately turn Handy `off` | `action: "status" \| "off" \| "on"` |

---

## Canonical Chained Action Example

First take a marked capture and read the element list. Suppose `handy_see({ marks: true })` reported mark `5` as the name input and mark `13` as the Submit button. Then focus the target app window, click the input **by mark**, paste `"Sam"`, click Submit **by mark**, wait for the UI to settle, verify the screen actually changed, and return the annotated screenshot with numbered `#1`, `#2` trail markers:

```json
{
  "actions": [
    { "type": "focus_window", "title": "Workbench" },
    { "type": "click", "mark": 5 },
    { "type": "paste", "text": "Sam" },
    { "type": "click", "mark": 13 },
    { "type": "wait_for_settled", "quietMs": 200 }
  ],
  "screenshotAfter": true,
  "verifyChange": true
}
```

The same chain in the text DSL is `focus "Workbench" -> click mark 5 -> paste "Sam" -> click mark 13 -> wait_for_settled`.

Marks stay valid until your next marked capture, so a single `handy_see({ marks: true })` can drive several `handy_act` calls. Re-capture after anything that changes the layout — scrolling, resizing, navigation, or a theme change — because mark indices are assigned per capture.

---

## Reference Guides

- Set-of-Mark element detection, `mark` references, element `kind`s and scoring, motion profiles, and when to fall back to coordinates: `references/marks.md`
- Chained control patterns, instant clipboard paste, window focus, smart visual waits, and drag/scroll recipes: `references/chaining.md`
- Coordinate spaces (`screen` vs `normalized`), Retina/DPI scaling, multi-monitor layouts, and `region` zoom: `references/coordinates.md`
- Permission toggle (`on` / `off` / `toggle` / `view-only`), `(0,0)` failsafe, OS Accessibility/Screen Recording setup, and safety rules: `references/permissions.md`
