# Design

The look every screen of Payroll Admin follows: the admin app, the employee
portal, the kiosk and the emails. Read this before changing UI. Tokens live in
`client/src/index.css` (CSS variables) and `tailwind.config.ts`; the shared
components in `client/src/components/ui/` are the vocabulary.

## Direction

**Calm, white, Apple-native. A tool that disappears into payroll.**

Owners and managers of small restaurants run payroll here between shifts, often
on a phone. Staff clock in on a wall tablet with wet hands. The app should feel
like a well-made macOS / iOS utility: quiet surfaces, one blue accent, real
numbers set in tabular figures, and status colour only where something needs
attention. Familiar beats clever. Brand shows in precision, not decoration.

Modes: the admin app and portal are **Operate** (scan, decide, act). Emails are
**Read** (one message, one action). The kiosk is **Operate at arm's length**:
huge targets, one decision per screen.

## Colour

Restrained. Neutrals carry the page; the accent marks the primary action, the
current selection and focus, nothing else.

| Role | Token | Use |
|---|---|---|
| Canvas | `--background` (#fbfbfd) | page behind cards |
| Surface | `--card` (white) + `--card-border` | cards, lists, dialogs (`.surface`) |
| Chrome | `--sidebar` (#f5f5f7) | sidebar, toolbars |
| Text | `--foreground` (#1d1d1f) | body, figures |
| Secondary text | `--muted-foreground` (≥4.5:1 on white and on canvas) | captions, meta |
| Accent | `--primary` (Apple blue) | primary button, active nav, links, focus ring |
| Status | `success` / `warning` / `danger` / `info` / `neutral`, each with `-soft` | badges, notices, flags |

Rules:
- Never hard-code a hex or a Tailwind palette colour (`text-gray-500`,
  `bg-blue-600`) in the admin app or portal. Use the tokens. The kiosk and the
  emails are the deliberate exceptions (see below).
- Status colour means status. A green number is "good / paid", amber is "needs a
  look", red is "wrong or blocked". Don't use them for decoration or for
  category colour; categories use `chart-*`.
- Text on a tinted surface uses that tint's strong colour (`text-warning` on
  `bg-warning-soft`), never grey.
- Every pair ships in dark mode too. Check both.

## Type

One family: the system UI font (`--font-sans`). No display faces.

| Step | Size / weight | Use |
|---|---|---|
| Display | `text-display` 28px / 700, -0.022em | page title (`PageHeader`) |
| Title | 17–20px / 600 | dialog and card titles |
| Body | 14px / 400 (base) | default |
| Control | 13px / 500 | buttons, tabs, inputs, nav |
| Caption | 12–13px, `text-muted-foreground` | meta lines |
| Label | `.section-label` 11px / 600 uppercase | group headings only (`SectionLabel`) |

- Money, hours, times and counts use `tabular-nums` and right-align in columns.
- Headings get more space above than below. Same role, same style, everywhere.
- No mono as decoration: mono is for codes, IDs and keys only.

## Space and shape

- 4px grid. Common steps: 4, 8, 12, 16, 24, 32. Card padding 16 (compact) or
  20–24. Gap between cards 12–16; between page sections 32.
- Radii (tailwind): `sm` 6, `md` 10 (buttons, inputs), `lg` 12, `xl` 14 (cards),
  `2xl` 18 (dialogs, hero cards). Nested radius = outer minus padding.
- Shadows: `shadow-card` at rest, `shadow-float` for menus/popovers, `shadow-pop`
  for dialogs. No coloured glows, no zero-blur offset shadows.
- Borders are 1px hairlines in `border` / `card-border`. No coloured side-stripe
  on a rounded box: use a tint, a full border or a leading icon.

## Components (use these, don't re-roll them)

`Button` (default / outline / secondary / tinted / ghost / destructive / link;
sizes sm / default / lg / icon), `Badge`, `Input`, `Select`, `Switch`,
`Checkbox`, `Tabs` / `SegmentedControl`, `Dialog`, `AlertDialog`
(`ConfirmDialog`), `Sheet`, `Tooltip`, `EmptyState`, `Skeleton`, `Page`,
`PageHeader`, `SectionLabel`, `grouped.tsx` (iOS grouped list rows), `toast`.

- One primary (filled blue) button per view region. Everything else outline,
  secondary, tinted or ghost.
- Icons: lucide only, 16px in controls (`[&_svg]:size-4`), 1.5–2 stroke. No emoji
  or Unicode glyphs as icons.
- Every interactive element: hover, `focus-visible` ring (`ring-ring/35`, 3px),
  active, disabled (`opacity-45`), and loading where it can be slow.
- Loading: `Skeleton` shaped like the content, not a centred spinner.
- Empty: `EmptyState` that says what will appear and how to make it appear.
- Errors: say what went wrong and what to do, next to the thing that failed.
- Touch targets ≥ 40px on mobile (44 preferred); ≥ 24px absolute minimum on
  desktop.

## Motion

150–200ms, `cubic-bezier(0.2, 0, 0, 1)` (the tailwind default). Motion shows a
state change (press, open, appear) and nothing else. No page-load choreography.
`prefers-reduced-motion` keeps state changes visible (fades) but drops movement.

## Layout

- Desktop: sidebar + content (`Page`, max 72rem; `wide` 90rem for tables).
- Mobile (<768px): top bar + bottom tab bar; content single column, 16px gutters,
  no horizontal page scroll. Tables become stacked rows or scroll inside their own
  card.
- Page header: title left, actions right; actions wrap under the title on mobile.

## Surfaces with their own rules

**Kiosk** (`client/src/kiosk/`): white, no theme variables on purpose (it must
look the same on any tablet). Neutral-950 text, neutral greys, one blue
(#0071e3 / #0a84ff for focus). Action colours are fixed in `ACTION_STYLE`
(clock in emerald-700, break amber-400, back sky-700, out neutral-900), each
AA on its fill. Minimum target 64px; PIN keys ≥ 80px. Secondary text no lighter
than neutral-600 on white. One idea per screen, words at 20px+.

**Emails** (`server/email.ts`, `brandedHtml`): table layout, inline styles,
light only. Page #f2f2f7, card white with #e5e5ea border, radius 18. Text
#1d1d1f, body #3a3a3c, secondary no lighter than #6e6e73 (≥4.5:1 on both white
and #f2f2f7). Button #0071e3 with white text (4.5:1+). One button per email.

**Portal** (`client/src/portal/`): same tokens and components as the admin app,
phone-first.

## Copy

Plain, short, friendly, in the person's words ("Clock in", "Pay period",
"Timesheet"). Sentence case. Buttons name the action ("Save rates", not "OK").
No exclamation marks in errors. Numbers with units ("7.5 h", "$18.00/h").
