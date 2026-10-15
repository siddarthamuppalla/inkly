# Inkly design system: Paper & Ink

Inkly handles contracts, invoices and signatures. The interface borrows from the desk
those documents come from: warm paper, dark ink, a fountain-pen blue for things you can
act on, and one red seal. The live reference is the `/design` route in `apps/web`.

## Principles

1. **The document leads.** Chrome stays warm and quiet so the PDF is the loudest thing on
   screen.
2. **One seal.** Seal red marks signing, required fields and danger. Never decoration
   beyond the margin rule and the wordmark dot.
3. **Legible first.** WCAG 2.1 AA in both themes is a failing test, not a guideline.

## Where things live

| Concern | File |
|---------|------|
| Color tokens (light and dark) | `apps/web/src/styles/tokens.css`, the only place a color is defined |
| Tailwind theme, fonts, base styles | `apps/web/src/styles/index.css` |
| Components (shadcn/ui pattern, copied in) | `apps/web/src/components/ui/` |
| Brand marks | `apps/web/src/components/brand/` |
| Contrast proof | `apps/web/test/contrast.test.ts` and its pair list in `test/contrast.ts` |
| Rendered a11y proof | `verify-app` checkpoints run axe in light and dark (J-000, J-001) |

## Tokens

Token names follow shadcn/ui (`background`, `foreground`, `primary`, `muted-foreground`,
`ring`, and so on), so a component copied from shadcn/ui picks them up unchanged. Inkly adds
`seal`, `link`, `success`, `warning` and `rule`.

Tailwind's stock palette is switched off (`--color-*: initial`). `bg-blue-500` generates no
CSS, so every color on screen traces back to `tokens.css`.

When you add a token or put two tokens together in a new way, add the pair to
`CONTRAST_PAIRS`. Text needs 4.5:1 and UI edges and focus need 3:1, in both themes.

## Type

- **Fraunces** (variable, optical size axis) for headings. Its soft, slightly wonky serifs
  read as ink on paper rather than as a template.
- **Atkinson Hyperlegible Next** for everything else. The Braille Institute drew it for
  low-vision readers, so `0O`, `1lI` and `rn`/`m` stay distinct, which matters for
  amounts, codes and names on contracts.
- Fonts ship from our own static assets via `@fontsource-variable`; no font CDN.

## Signature details

- **Margin rule.** A thin red line down the left of the page body, like a legal pad.
- **Ink stamp.** The primary button carries a hard seal-red offset that presses flat when
  clicked.
- **Folded sheet.** `Sheet folded` dog-ears a card that stands for a document.
- **Signature stroke.** Empty states open with a hand-drawn line in pen blue.

## Accessibility rules the components already follow

- Visible 2px focus outline in `--ring` on every focusable element.
- Skip link is the first tab stop; client-side navigation moves focus to the new page's h1.
- Status badges always carry a text label; color only reinforces it.
- `Field` wires label, hint and error through `htmlFor` and `aria-describedby`, and sets
  `aria-invalid` on error.
- Motion collapses under `prefers-reduced-motion`.
