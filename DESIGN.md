# DESIGN

The actual Orbit design system. Dark, quiet, precise. Hierarchy comes
from type, spacing, and comparison — never from glow, gradients, or glass.

## Foundation

Dark neutral foundation, one warm action accent, semantic status hues.
Depth is flat: hairline borders and one inset tone, no diffuse shadows.

| Token | Value | Use |
| --- | --- | --- |
| `--bg-space` | `#0b0b0f` | page |
| `--bg-panel` | `#0f0f14` | section surface |
| `--bg-inset` | `#0a0a0e` | group inside a section |
| `--border-glass` | `rgba(255,255,255,.08)` | hairline |
| `--primary` | `#d9a441` | action (buttons, links, focus) |
| `--accent` | `#3ecfae` | live / together (semantic) |
| `--secondary` | `#e07bb4` | person B (semantic, sparse) |
| `--danger` | `#f87171` | failure |
| text | `#f2f2f3 / #a8a8b2 / #80808a` | primary / secondary / muted (muted ≥ 4.5:1 on panels) |

Primary buttons carry dark text on the amber accent for contrast.

## Typography

System stack (`-apple-system, BlinkMacSystemFont, Segoe UI, Roboto`),
mono voice for time. Two families, four weights (400/500/600/700) —
nothing between.

| Voice | Size | Weight | Notes |
| --- | --- | --- | --- |
| Display | 32–42 (clamp) | 600 | first-run title only |
| Heading | 17 | 600 | one per panel (`.section-title`) |
| Subheading | 15 | 600 | panel sub-blocks |
| Body | 14 | 400 |  |
| Label | 13 | 500 | form labels, controls |
| Meta | 12 | 400 | helper text |
| Time | 22–26 | 600 | tabular numerals |
| Metric | 36–44 | 600 | the shared-time number, tabular |

Uppercase exists only as the 11px `.eyebrow` and the chat "simulated" tag.

## Spacing

4px scale (`--space-1…7` = 4/8/12/16/20/24/32). Sections breathe at
`--section-gap: 28px`. Panels pad 20 (16 on mobile). Rhythm is varied,
never one repeated value.

## Surfaces

page → panel (`.glass-panel`) → group (`.group`) → control.
A section becomes a card only when grouping aids comprehension. Groups
are inset tone + hairline; no cards inside cards. Modals use the panel
surface with hairline only (the dimmed overlay provides separation —
no wide shadows).

## Layout

Single 1000px column, top-to-bottom narrative: participants (quiet) →
shared time signature → shared moment → activity strip → plan/converse →
measured footer line. Two-column grid only for paired secondary tools.
Mobile (≤900px) collapses to one column; the time signature stacks
vertically (YOU / clock / metric / THEM / clock).

## Motion

Only state changes: modal rise (220ms), message/peer arrival (260ms,
`arrive-in`), connecting pulse. Opacity and small transforms only.
`prefers-reduced-motion` neutralizes all of it.

## Components

- **Status language**: Local · Joining… · Connected · waiting for your
  person · your person is online · Reconnecting… · Connection lost ·
  Session unavailable. Never transport terminology.
- **Time signature**: two clocks flank the shared-time metric (tabular,
  hairline dividers). Own side is marked *you*.
- **Activity strip**: verbs (Watch · Draw · Focus · Talk) in one quiet
  row; the open activity carries `aria-pressed` and modal focus.
- **Modals**: one chrome — 560px (media 720px), heading + close +
  focus trap + Escape + `100dvh`-safe scrolling.
- **Chat**: calm bubbles (own = amber tint, peer = hairline inset),
  one meta line (name · time), arrival animation, simulated replies
  tagged `SIMULATED`.

## Anti-slop rules (enforced)

No gradients, no glows, no nested cards, no identical card grids, no
icon tiles, no fake metrics, no decorative animation, no purple AI
palette, no buzzword copy, minimal em-dashes, honest labeling of
simulated content.
