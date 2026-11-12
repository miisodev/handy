# Mapped Coordinates, Zoom & Multi-Monitor Reference

## Reading `handy_see` Overlays

Every `handy_see` capture renders two visual aids directly onto the PNG image:

1. **Mapped Coordinate Rulers & Grid**:
   - **Top strip**: X-axis ticks and screen pixel badges (e.g. `200`, `400`, `600`...).
   - **Left strip**: Y-axis ticks and screen pixel badges.
   - **Top-left corner**: Origin badge `originX,originY` (e.g. `0,0` for primary display, or `400,250` when zoomed into a `region`).
   - **Interior intersections**: Subtle `x,y` badges so coordinates can be read right beside the target element without tracing across wide monitors.
2. **Live Mouse Reticle**:
   - A red-and-white bullseye ring + crosshair centered on the exact live OS cursor position, with an open 3px center and a `MOUSE (x,y)` badge.
   - If the cursor appears slightly off a small button after moving, compare `MOUSE (x,y)` against the button's visual position for instant sub-10px correction.

## Why Drawn Coordinates Prevent Scaling Drift

High-DPI displays (4K Windows laptops, macOS Retina 2x screens) and vision-model image resizing often cause raw pixel estimates to drift by `1.5x–2x`. Handy solves this natively:
- On **macOS Retina**, Handy maps physical `2x` pixels onto CoreGraphics logical point coordinates so the grid numbers match `CGEvent` mouse coordinates `1:1`.
- On **Windows**, Handy initializes `Per-Monitor V2` DPI awareness so `CopyFromScreen`, `GetCursorPos`, and `SendInput` share identical coordinates.
- When `maxWidth` downscales a large frame, Handy draws the coordinate labels *after* resizing, using true OS screen coordinates. Always trust the numbers printed on the rulers and grid badges.

## Precision Targeting with `window` or `region` Zoom

When targeting dense UI controls or focusing exclusively on one app window without desktop clutter:

```json
{
  "window": "Visual Studio Code",
  "highlightDiff": true
}
```

Or crop an exact rectangle:

```json
{
  "region": { "x": 360, "y": 120, "width": 320, "height": 220 },
  "gridStep": 50
}
```

The cropped window or region is returned at native 1:1 resolution while its rulers and grid badges remain in **global screen `(x, y)` coordinates** (`360..680`, `120..340`). Pass the coordinate you read directly to `handy_act` — no offset addition required.

## Window-Relative Coordinates (`coordinateSpace: "window"`)

When executing reusable workflows inside a movable desktop window, pass `"coordinateSpace": "window"` on any step (`move`, `click`, `drag`, `scroll`, `wait_for_color`). Handy offsets `(x, y)` automatically from the currently active window's top-left `{ x, y }` bounds.

## Normalized Coordinates (`0..1000`)

If you prefer display-relative `0..1000` coordinates on a step, pass `"coordinateSpace": "normalized"`:
- `(0, 0)` maps to top-left of the selected `display`
- `(500, 500)` maps to the exact center of the selected `display`
- `(1000, 1000)` maps to bottom-right of the selected `display`
