# Set-of-Mark Elements, Click-by-Mark & Motion Reference

## Why Marks Beat Coordinates

Reading `(x, y)` off a screenshot works, but it is fragile: the number is only right for the exact frame you read it from, and a dense UI invites off-by-20px mistakes on small controls. Marks remove both problems. `handy_see({ marks: true })` detects the interactive elements itself, numbers them on the image, and returns their bounds — so you reference *the Submit button* rather than *the pixel at 195,325*. The reference resolves to that element's own centre at execution time.

```json
// handy_see
{ "marks": true }
```

```json
// handy_act — mark 13 was "Submit" in the capture above
{
  "actions": [
    { "type": "click", "mark": 5 },
    { "type": "paste", "text": "Sam" },
    { "type": "click", "mark": 13 }
  ],
  "verifyChange": true
}
```

## The `elements` Result

Each detected element is a `Region` (`x`, `y`, `width`, `height`) plus:

| Field | Meaning |
|---|---|
| `index` | 1-based mark number, matching the badge drawn on the screenshot. Contiguous, no gaps. |
| `kind` | `control` \| `text` \| `icon` \| `region` (see below). |
| `centerX`, `centerY` | Global logical screen coordinates of the click point — pass these as `x`/`y` if you prefer explicit coordinates. |
| `score` | Confidence `0..1` that this is a genuine interactive element. |

Coordinates are **global logical screen coordinates**: frame origins are already applied (so a `window` or `region` capture yields absolute screen positions, no offset addition), and HiDPI frames are mapped back from physical pixels to logical points.

## Element Kinds

| Kind | Badge colour | What it is | Typical use |
|---|---|---|---|
| `control` | Violet | Buttons, text fields, checkboxes, sliders — a bordered or filled region with high interior/surround contrast | Click, type into, toggle |
| `text` | Slate | A merged line of glyphs | Read, or `triple_click` to select |
| `icon` | Pink | Small dense graphic — toolbar icon, status glyph | Click |
| `region` | Light slate | Large panel, window, or grouped container | Scroll within, or narrow a search |

`control` marks are deliberately scored above `text` marks, so a button wins over the label drawn on it. Filter with `markKinds: ["control"]` when you only want clickable widgets — this also speeds detection up and keeps `maxMarks` from being spent on paragraph text.

## Tuning Detection

| Parameter | Default | Notes |
|---|---|---|
| `marks` | `false` | Enable detection. Off by default so ordinary captures stay cheap. |
| `maxMarks` | `40` | Range `1..200`. Highest-scoring elements are kept, then renumbered in reading order. |
| `markKinds` | all | Restrict to a subset of kinds. |
| `minMarkScore` | `0.3` | Range `0..1`. Raise to `0.5`–`0.6` on cluttered screens to drop speculative detections. |

Detection cost is DPI-independent — roughly 18ms at 1280x800, 22ms at 2560x1440, 49ms at 4K — because the analysis runs on an area-capped work buffer rather than at native resolution. On a photographic screen with no coherent structure (a video, a game, a dense photo) detection returns an empty list rather than churning.

## Mark Lifetime

Marks are a property of **one capture**. They remain valid for subsequent `handy_act` calls — so a single marked `handy_see` can drive several chains — but re-capture with `marks: true` after anything that changes the layout:

- scrolling or paginating
- window resize, move, maximize, or focus change
- navigation, tab switch, or a modal opening/closing
- theme or dark-mode change, font scaling

Mark indices are assigned per capture, so `mark 5` after a re-capture may be a different element. When a chain is long enough that the UI mutates partway through, split it: act, re-capture, act again.

## Error Behaviour

Marks fail loudly, never silently:

- **Out-of-range index** — the error names the requested mark and lists what *is* available.
- **No prior marked capture** — not an error. A mark reference resolves itself: with nothing cached the controller captures the current screen, runs detection, and resolves against that. This is what makes marks usable across CLI invocations, where each command is a fresh process and nothing can be carried over. Detection is deterministic for an unchanged screen, so `handy see --marks` and a later `handy act "click mark 5"` agree on the numbering. If the screen may change in between, keep both in one chain (`[{"type":"screenshot","marks":true},{"type":"click","mark":5}]`) so the indices cannot drift, or pass explicit coordinates.
- **Detection found nothing** — a blank or unrecognisable screen yields no elements, so there is no mark to resolve. The error says so and points at explicit coordinates; it also reports a capture or detection failure separately rather than failing opaquely. A warm cache is never re-detected, so a marked chain does not pay for capture and detection per step, and indices stay stable across every step in that chain.
- **Malformed chain text** — `click mark` with no number, `click mark 0`, or `click 12` (one coordinate) all throw, quoting the offending segment. A malformed pointer step never degrades into "click wherever the cursor happens to be".

## Chain DSL Forms

Marks work everywhere the text DSL is accepted (`handy act '<chain>'`, the Control Panel chain runner):

```
click mark 5        click #5         move mark 3
drag mark 3 mark 7  drag mark 3 300 400   drag 100 200 mark 7
scroll down 4 mark 9      double_click mark 5      right_click mark 5
```

Coordinate forms are unchanged: `click 400 300`, `click 400,300`, `drag x1 y1 x2 y2`, `drag x2 y2`, `scroll 5 10`. A bare `click` still acts at the current cursor position.

## Dragging and Scrolling by Mark

`drag` accepts a mark on either endpoint via `fromMark` / `toMark`:

```json
{ "type": "drag", "fromMark": 4, "toMark": 11, "durationMs": 250, "steps": 24 }
```

`scroll` positions the cursor over a mark before scrolling, which is what you want for a scrollable panel:

```json
{ "type": "scroll", "mark": 22, "direction": "down", "amount": 4 }
```

## Motion Profiles

`motion` selects the interpolation curve, and it only has an effect when the move actually interpolates:

| Profile | Path | Timing curve |
|---|---|---|
| `ease` (default) | Straight line | Quadratic ease-out: fast start, decelerating finish |
| `linear` | Straight line | Constant speed |
| `human` | Arc bowed perpendicular to the travel direction | Cubic ease-in-out along the line |

**When interpolation happens at all** differs by step:

- **`move`** does *not* interpolate by default — it goes straight to the target in one call. Pass `durationMs` to interpolate, or set `motion: "human"`, which derives a duration for you.
- **`drag`** *always* interpolates, defaulting to 160ms and 16 steps so the drag reads as a continuous gesture rather than a teleport.

```json
{ "type": "move", "x": 1200, "y": 700, "motion": "human" }
```

With `motion: "human"` and no `durationMs`, the duration comes from a Fitts's-law model of travel distance and target width — `a + b * log2(distance / width + 1)`, with `a = 60`, `b = 110`, default `targetWidth = 24` — so a long move to a small target takes measurably longer than a short move to a large one. The result is clamped to 0–1200ms, and distances under 2px return 0. A drag floors this at 160ms. Pass an explicit `durationMs` to override; `steps` controls how many intermediate positions are emitted (default `durationMs / 10`, capped at 60, or 90 for `human`).

The `human` bow is shallow — at most 14px, scaled to 3.5% of travel distance — and its direction is derived deterministically from the start point's parity, so repeating the same drag traces the same arc.

Use `human` when a visible, plausibly-paced cursor path matters (demonstrations, recordings, or software that filters instant teleporting motion). Use `linear` for a predictable constant-speed path, and leave the default alone when you just want the cursor to get there.

## Verifying an Action Took Effect

`verifyChange: true` captures a baseline before the chain and diffs the screen afterwards:

```json
{ "ok": true, "stepsCompleted": 3, "changed": true, "change": { "changedPercent": 1.659, "changedPixels": 16989, "changedBounds": { "x": 120, "y": 305, "width": 152, "height": 44 } } }
```

`changed: false` after a click that should have done something means the click landed but nothing happened — a disabled control, an unfocused window, or a mark that resolved to a label instead of a button. Re-capture with `marks: true` and inspect the element list rather than retrying the same coordinates.

## When to Fall Back to Coordinates

Detection is structural, not semantic: it finds coherent bordered or filled regions with contrast against their surround. It will miss or mis-shape:

- **Custom-drawn surfaces** — canvas apps, games, video players, terminal emulators, PDFs
- **Borderless flat controls** — a text-only link with no fill or outline on a matching background
- **Overlapping or tightly packed elements** — adjacent controls may merge into one region
- **Detected bounds that lag the truth by a few pixels** — the outline is grown by dilation, so a box can read ~3–5px larger than the visual control

For these, read `(x, y)` from the coordinate rulers and interior pills as before (`references/coordinates.md`), or zoom first with `window` / `region` to give detection a cleaner, higher-resolution frame to work on. The centre of a mark is always safe to click even when its bounds are slightly oversized — that is the point of resolving to the centre.

## Programmatic API

The detector is exported for direct use:

```ts
import { detectUiElements, resolveMarkCenter } from "@miisodev/handy";

const elements = detectUiElements(rawFrame, {
  maxMarks: 40,
  kinds: ["control", "icon"],
  minScore: 0.4,
  searchRegion: { x: 0, y: 0, width: 800, height: 600 }, // library-only
});
const { x, y } = resolveMarkCenter(elements, 5);
```

`detectUiElements` takes a `RawFrame` and returns `UiElement[]`; `resolveMarkCenter` throws for an index that is not present. Also exported: the `UiElement` and `UiElementKind` types, `MarkRefSchema`, `UiElementKindSchema`, and `fittsDurationMs(from, to, targetWidth = 24, a = 60, b = 110)`.
