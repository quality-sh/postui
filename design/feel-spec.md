# postui feel pass — design spec

Goal: every action the user takes visibly lands. The TUI is already fast
(keypress → paint in 10–40 ms, measured in a live PTY); what it lacks is
acknowledgement. Sending the same request twice today produces a
byte-identical screen, and the `sending…` state never appears for a fast
request. After this pass, nothing the user does may leave the screen
unchanged.

References:
- opencode's TUI (`~/Documents/repos/opencode/packages/opencode/src/cli/cmd/tui/`):
  `ui/spinner.ts`, `ui/toast.tsx`, `ui/dialog.tsx`, `component/border.tsx`,
  `routes/session/footer.tsx`, `context/theme/opencode.json`.
- provenance web's diffusion hero
  (`~/Documents/repos/provenance-web-app/src/hero/heroEngine.ts`): an image
  resolves in stages — faint grey dot fog → larger lavender-grey "engraved"
  dots → colour blooms through the dots (Rosé Pine: `#eb6f92 #c4a56a
  #908caa #ea9a97 #935e6d`) → dots shrink and refine into the final image.
  postui borrows the motif, not the image: loaders and reveals are halftone
  glyph fields that "develop" into content.

## 1. Palette — aether-rose (the owner's desktop theme)

postui follows the owner's Omarchy theme, aether-rose
(`~/.config/aether/theme/colors.toml`, `~/.config/opencode/themes/aether-rose.json`):
black ground, grey chrome, grey text, one light-grey accent. Rosé Pine
colours appear only where they carry meaning. Drifting from this (violet
grounds, a coloured accent) counts as "off theme".

| Token | Hex | Use |
|---|---|---|
| `bg` | `#000000` | app background |
| `panel` | `#0a0a0a` | pane interiors |
| `element` | `#1a1a1a` | inputs, pills, code gutter |
| `elementHover` | `#242424` | mouse hover on rows and pills |
| `border` | `#525252` | pane frames at rest, rules |
| `borderActive` | `#908caa` | hover/secondary emphasis on frames |
| `text` | `#b9b9b9` | body text |
| `muted` | `#8b8b8b` | labels, hint text |
| `dim` | `#6e6a86` | decoration, placeholders, gutters |
| `fog` | `#2e2e2e` | halftone fog stage, skeletons |
| `accent` | `#cbcbcb` | focus, selection bar, cursor, primary buttons |
| `accentSoft` | `#262626` | selected-row / focused-control fill |
| `gold` | `#f6c177` | JSON strings, warnings |
| `sage` | `#8fa77a` | success (2xx), GET |
| `iris` | `#c4a7e7` | info, JSON literals |
| `rose` | `#ebbcba` | PUT/PATCH, the wordmark's warm end |
| `love` | `#eb6f92` | errors, 4xx/5xx, DELETE — nothing else |

Method badges: GET sage, POST gold, PUT/PATCH rose, DELETE love,
HEAD/OPTIONS muted. JSON: keys `text`, strings `gold`, literals `iris`,
punctuation `dim`.

Bloom palette (develop effect): `#eb6f92 #c4a56a #908caa #ea9a97 #935e6d`
plus `accent`. Wordmark: `accent` fading to `rose`.

## 2. Shape

- Pane frames: `borderStyle: "rounded"`, `border` colour at rest, sweep to
  `accent` on focus (keep motion.ts sweeps). Pane interiors `panel`.
- No boxes inside panes. Inner controls are filled pills on `element`:
  method pill, URL field, SEND button (filled `accent` bg with `bg` text
  when focused/pressed; `element` bg otherwise). The selected collection row
  is a left bar `▌` in `accent` + `accentSoft` fill, not a box. The response
  code block is a gutter on `element` + content on `panel`, no box.
- Status bar: ONE row, no border, no cells. Left: hints as `key` (text) +
  `label` (muted), separated by two spaces. Right: live status slot.
- Header: one row inside a rounded frame or borderless on `panel`; wordmark
  `P O S T U I` letters coloured across the bloom palette; halftone strip
  kept.
- Overlays (import prompt): full-screen dim scrim (`RGBA(0,0,0,150)` like
  opencode `ui/dialog.tsx`), rounded panel centred at ~1/4 height.

## 3. Motion and feedback rules

1. Every action produces a visible acknowledgement that stays ≥ 300 ms.
2. Send lifecycle (the centrepiece):
   - t=0 (keypress): SEND pill shows pressed (accent fill) and its label
     becomes a halftone spinner; response header shows spinner +
     `GET /path` + live elapsed ms ticking; body shows a skeleton fog.
   - Minimum busy display 220 ms: if the response lands sooner, hold the
     busy state until 220 ms, then reveal.
   - Reveal: the body "develops" over ~300 ms — each cell starts as a fog
     halftone glyph, passes through a bloom-palette colour, and settles to
     its real character and token colour; rows resolve top-down with jitter.
   - Header then shows status chip + `ms` + size + `#N · HH:MM:SS` (send
     counter per session, so a repeat send always looks different).
   - Errors: same lifecycle, reveal in `love`, plus a toast.
3. Save (ctrl+s): toast `saved <name>.ts` (foam), dirty dot fades out.
   Refused save: toast in love with the reason.
4. Import: toast `imported <name>`; new row flashes in with the develop
   effect.
5. Toasts: top-right, `panel` bg, `▌` bars in variant colour, auto-hide
   1.8 s (opencode `ui/toast.tsx`). Stack up to 3.
6. Skeletons instead of false empty states: collections before the first
   workspace read shows 3–5 fog rows that drift; never flash "no saved
   requests" before the read completes.
7. Hover: rows and pills swap to `elementHover` on mouse over.
8. Spinner: a 3–5 cell halftone pulse using glyphs `·∙•●` (or braille
   density `⠁⠃⠇⡇⣇⣧⣷⣿`), colour cycling fog → muted → accent, ~80 ms/frame;
   `staticFallback` for tests/headless. Implemented as one small Renderable
   that calls `requestRender()` on an interval and clears it in
   `destroySelf` (opencode's `opentui-spinner`), never a pane rebuild.

## 4. Engine hygiene

- `run.ts`: `createCliRenderer({ targetFps: 60, maxFps: 60, gatherStats:
  false, useKittyKeyboard: {}, ... })`.
- Removed renderables are destroyed (`destroyRecursively`), not just
  detached — the current `clearChildren` leaks native text buffers.
- Animations stop when nothing moves (`requestLive` only while animating).
- Tests: effects must be deterministic under the test renderer: every fx
  takes an injectable clock or exposes `finish()`; with the timeline engine
  detached, effects land their end state synchronously (like motion.ts).

## 5. fx module interface (src/tui/fx/)

```ts
// spinner.ts
export function halftoneSpinner(renderer, opts?: { width?: number; color?: string }): Renderable & { stop(): void };
// skeleton.ts
export function skeletonLines(renderer, opts: { lines: number; width: number | "100%"; widths?: number[] }): Renderable & { stop(): void };
// develop.ts — reveal StyledText-like lines from halftone noise
export interface Cell { char: string; fg: string }
export function developLines(renderer, lines: Cell[][], opts?: { durationMs?: number; onDone?: () => void }): Renderable & { finish(): void };
// toast.ts
export function mountToasts(renderer, root): { show(text: string, variant: "success" | "error" | "info"): void };
// clock.ts — the animation clock (real in the app, manual in tests)
```
