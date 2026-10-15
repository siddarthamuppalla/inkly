# Components: handoff spec

Specs for the Paper & Ink components in `apps/web/src/components/`. Every value below is a
token from `apps/web/src/styles/tokens.css` or the Tailwind theme in `styles/index.css`.
The live reference is `/design`.

## Layout (AppShell)

| Breakpoint | Layout |
|------------|--------|
| < 768px | Wordmark, then the primary nav as a wrapping row; page body below with the margin rule. API status and the design-system link are hidden. |
| ≥ 768px | 15rem sticky sidebar (wordmark, vertical nav, design-system link and API status at the bottom) beside the page body. |

- Page body: `margin-rule` utility (2px `--rule` line), left padding 1.5rem, 2.5rem from 768px.
- Reflow is tested at 320px wide in J-001; nothing may scroll horizontally.
- Focus order: skip link, wordmark, nav items, design-system link, page content.
- After client-side navigation focus moves to the page's `h1` (`tabIndex=-1`), and React 19 sets
  `<title>` to `<Page> · Inkly`.
- The active nav item gets `aria-current="page"` from React Router, `bg-muted`, semibold text and
  the `shadow-margin` red tick. Active state never relies on color alone.

## Button

| Prop | Type | Default | Notes |
|------|------|---------|-------|
| `variant` | `primary \| secondary \| ghost \| destructive \| link` | `primary` | |
| `size` | `sm \| md \| lg` | `md` | heights 36 / 44 / 48px |
| `loading` | `boolean` | `false` | disables the button, sets `aria-busy`, shows a pulsing ink drop |
| `type` | button type | `button` | never submits a form by accident |

| Variant | Use when | Look |
|---------|----------|------|
| primary | The one main action on a screen | `bg-primary`, `shadow-stamp` |
| secondary | Supporting actions | `bg-card`, `border-input` |
| ghost | Low-emphasis actions such as Cancel | text only, `bg-muted` on hover |
| destructive | Irreversible actions (void, delete) | `bg-destructive`; the label names the action |
| link | Navigation that looks like a link | `text-link`, underlined |

| State | Behavior |
|-------|----------|
| Hover | primary lifts 1px to `shadow-stamp-lift`; others tint to `bg-secondary`/`bg-muted` |
| Active | primary presses flat (translates 3px, no shadow) |
| Focus | 2px `--ring` outline, 2px offset |
| Disabled | 50% opacity, no shadow, no pointer events |
| Loading | disabled plus `aria-busy`; keep the label and change it to a present participle ("Sending…") |
| Forced colors | the transparent border becomes the system border so the button keeps an edge |

Do use one primary button per view. Don't use `destructive` for Cancel, or `link` for an
action that changes data.

## Badge

| Prop | Type | Default |
|------|------|---------|
| `variant` | `neutral \| info \| success \| warning \| danger` | `neutral` |

Text, dot and border share `currentColor`, so each variant passes 4.5:1 on `background` and
`card`. The label must say the status in words ("Waiting on 1 signer"); the color only repeats it.
Envelope mapping: Draft → neutral, Sent → info, Waiting → warning, Signed → success, Voided → danger.

## Sheet

| Prop | Type | Default | Notes |
|------|------|---------|-------|
| `folded` | `boolean` | `false` | dog-ears the top-right corner by `--fold` |

Parts: `SheetHeader`, `SheetTitle` (an `h3`; pass another level via `className` only if the
outline needs it), `SheetBody`. Use `folded` only when the sheet stands for a document.
Elevation is `shadow-sheet`.

## Field

| Prop | Type | Notes |
|------|------|-------|
| `label` | `string` | required; rendered as a `<label for>` |
| `hint` | `string` | linked with `aria-describedby` |
| `error` | `string` | linked with `aria-describedby`; sets `aria-invalid` and a 2px `--destructive` border |
| `required` | `boolean` | native `required`; the visual `*` is `aria-hidden`, so say "Fields marked * are required" above the form |

Error copy says what is wrong and how to fix it: "This password is too short. Use at least 8
characters."

## EmptyState

| Prop | Type | Notes |
|------|------|-------|
| `title` | `string` | plain words: "No envelopes yet" |
| `children` | `ReactNode` | what will appear here and why it is empty |
| `action` | `ReactNode` | the one action that fills the page; omit until that feature exists |

Opens with the decorative `Signature` stroke in `--link`.

## Motion

| Element | Trigger | Change | Duration | Easing |
|---------|---------|--------|----------|--------|
| Button | hover / active | transform, shadow, background | `--duration-fast` (150ms) | `--ease-ink` |
| Loading drop | `loading` | pulse | Tailwind `animate-pulse` | |

Under `prefers-reduced-motion` all transitions and animations collapse to near zero.

## Edge cases

- **Long labels:** buttons don't wrap (`whitespace-nowrap`); keep labels to a verb and an object.
  Badges wrap inside narrow containers.
- **Translation:** allow about 40% longer strings. Copy avoids idioms so it translates cleanly.
- **Slow API:** the status reads "API: checking" until `/health` answers.
