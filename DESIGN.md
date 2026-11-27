# Design

The look every screen of Shijiri Payroll follows: the admin app, the employee
portal, the kiosk and the emails. Read this before changing UI. Tokens live in
`client/src/index.css` (CSS variables) and `tailwind.config.ts`; the shared
components in `client/src/components/ui/` are the vocabulary.

## Direction

**Payroll by Shijiri Group: a calm tool under a bright, confident logo.**

Owners and managers of Shijiri's restaurants run payroll here between shifts,
often on a phone. Staff clock in on a wall tablet with wet hands. The product
should feel like a well-made native utility: quiet warm-neutral surfaces, one
deep-orange accent, real numbers in tabular figures, and status colour only where
something needs attention. Familiar beats clever. The logo's gold, orange and red
appear in full only in the logo itself and at brand moments (sign-in, kiosk
header, app icon, email header); the product carries one orange accent and
precision everywhere else.

### Brand

- **Logo**: "Payroll" in gold (#e6b422, "Pay") and orange (#fe5721, "roll"),
  then two blocks (gold square, orange bar), "By SHIJIRI GROUP" and a red
  (#e33a3a) dot. The "By SHIJIRI GROUP" line is ink on light and white on dark;
  the colours never change. `components/Logo.tsx` exports `Wordmark` (full
  lockup, text in currentColor), `ProductWordmark` ("Payroll" + dot, for app
  chrome), `Mark` (the blocks + dot, for small sizes) and `Logo` (app icon:
  the mark on warm ink). Path data is in `components/logo-art.ts`, traced from
  the supplied artwork.
- **Mark / favicon**: the gold square, the orange bar and the red dot.
  `public/favicon.svg` (transparent, reads on light and dark tabs) and
  `public/icons/*` (mark on ink #1b1714). Never redraw, recolour or rotate it.
- **Names**: the product is "Payroll by Shijiri Group" (short: Payroll);
  installed apps keep Shijiri Payroll, Shijiri Time Clock and Shijiri for staff.
  In running text write "Shijiri"; "SHIJIRI" in caps lives only inside the logo.
- **Brand colours**: Gold `#e6b422`, Orange `#fe5721`, Red `#e33a3a` (logo
  only). UI accent is Payroll orange deepened for contrast: `#c2410c` (white
  text 5.2:1), hover `#9a3412`; dark mode uses `#fe5721` itself with ink text
  (5.6:1). Ink `#1b1714` for brand panels. The logo red is never used in UI,
  so it can't be mistaken for an error. Orange is never a status colour:
  "Clock in" stays green, errors stay red, info stays blue.
- **Voice**: talk like the shift manager: warm, brief, on your side. Name the
  thing (hours, pay, shift, tips). Confirm with facts (the time and the name).
  One idea per line. No exclamation marks, puns or "Oops".
  Signature line: "Every shift counted. Every hour paid."

Modes: the admin app and portal are **Operate** (scan, decide, act). Emails are
**Read** (one message, one action). The kiosk is **Operate at arm's length**:
huge targets, one decision per screen.

## Colour

Restrained. Neutrals carry the page; the accent marks the primary action, the
current selection and focus, nothing else.

| Role | Token | Use |
|---|---|---|
| Canvas | `--background` (#fbfaf9, warm) | page behind cards |
| Surface | `--card` (white) + `--card-border` | cards, lists, dialogs (`.surface`) |
| Chrome | `--sidebar` (#f6f5f3) | sidebar, toolbars; active row `--sidebar-accent` orange tint |
| Text | `--foreground` (#201d1f) | body, figures |
| Secondary text | `--muted-foreground` (#6a6266, 5.9:1 on white) | captions, meta |
| Accent | `--primary` (deep Payroll orange #c2410c; logo orange #fe5721 with ink text in dark) | primary button, active nav, links, focus ring |
| Status | `success` / `warning` / `danger` / `info` / `neutral`, each with `-soft` | badges, notices, flags |

Rules:
- Never hard-code a hex or a Tailwind palette colour (`text-gray-500`,
  `bg-blue-600`) in the admin app or portal. Use the tokens. The kiosk and the
  emails are the deliberate exceptions (see below).
- Icon tiles (Settings list, Home quick actions, import sources) are neutral
  (`bg-foreground/[0.06] text-foreground/70`), never a rainbow of hues.
- Charts: `chart-1` is slate for single-series data; the brand orange is never a data colour.
- Brand-moment colours are tokens too: `brand-ink`, `brand-rice`, `brand-tonal`,
  `brand-muted` (Tailwind `bg-brand-ink` etc.). Use them only on brand panels.
- Status colour means status. A green number is "good / paid", amber is "needs a
  look", red is "wrong or blocked". Don't use them for decoration or for
  category colour; categories use `chart-*`.
- Text on a tinted surface uses that tint's strong colour (`text-warning` on
  `bg-warning-soft`), never grey.
- Every pair ships in dark mode too. Check both.

## Type

Product text uses the system UI font (`--font-sans`). One brand face, **Poppins
SemiBold 600** (`font-display font-semibold`, OFL, self-hosted in
`client/src/assets/fonts`), matches the geometric "Payroll" in the logo. It sets
the sign-in heading and voice line, the kiosk greeting and employee names, and
the portal greeting: 22px or larger, tracking -0.02em, weight 600 only (the only
weight shipped). Everything else, including the kiosk clock, money and tables,
stays in the system font.

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

- One primary (filled orange) button per view region. Everything else outline,
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

**Kiosk** (`client/src/kiosk/`): light, no theme variables on purpose (it must
look the same on any tablet). Warm `stone-*` greys (text stone-950, body
stone-700, secondary no lighter than stone-600), the full-colour mark top-left,
deep orange `#c2410c` (`--kiosk-accent` in `kiosk.css`) for the primary key, filled
PIN dots and focus. Greetings and names in
`font-display`; the clock in the system font, light, tabular. Action colours are
fixed in `ACTION_STYLE` (clock in emerald-700, break amber-400, back sky-700,
out stone-900), each AA on its fill. Minimum target 64px; PIN keys ≥ 80px. One
idea per screen, words at 20px+.

**Emails** (`server/email.ts`, `brandedHtml`, colours in its `C` map): table
layout, inline styles, light only, system font. Page #f4f1ee, card white with
#e6e2de border, radius 18. Text #1f1b18, body #3b3632, secondary #6b6561
(≥5.2:1 on page and card). Button deep orange #c2410c with white text (5.2:1).
Header: the logo's gold and orange blocks and red dot built from table cells (no
images, so it shows in every mail app), then the brand name. One button per email.

**Portal** (`client/src/portal/`): same tokens and components as the admin app
(`portal.css` imports `index.css`), phone-first.

**Sign-in** (`pages/Login.tsx`): split screen. Ink brand panel on the left with
the full logo (white "By SHIJIRI GROUP") and the voice line in Poppins, its
second half in gold; the form on the right, 380px column, 48px fields and a
full-width orange button. On phones the panel becomes a header band. No photos,
gradients or carousels.

## Copy

Plain, short, friendly, in the person's words ("Clock in", "Pay period",
"Timesheet"). Sentence case. Buttons name the action ("Save rates", not "OK").
No exclamation marks in errors. Numbers with units ("7.5 h", "$18.00/h").
