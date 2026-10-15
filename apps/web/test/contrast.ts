export type Tokens = Readonly<Record<string, string>>;

const TEXT = 4.5;
const UI = 3;

const surfaces = ["background", "card"] as const;
const onSurfaces = (fg: string, min: number) => surfaces.map((bg) => ({ fg, bg, min }));

/** Every token pair the components put together; WCAG 1.4.3 for text, 1.4.11 for UI parts. */
export const CONTRAST_PAIRS: readonly { fg: string; bg: string; min: number }[] = [
  ...onSurfaces("foreground", TEXT),
  { fg: "card-foreground", bg: "card", min: TEXT },
  ...onSurfaces("muted-foreground", TEXT),
  { fg: "muted-foreground", bg: "muted", min: TEXT },
  { fg: "foreground", bg: "muted", min: TEXT },
  { fg: "primary-foreground", bg: "primary", min: TEXT },
  { fg: "secondary-foreground", bg: "secondary", min: TEXT },
  { fg: "accent-foreground", bg: "accent", min: TEXT },
  { fg: "seal-foreground", bg: "seal", min: TEXT },
  { fg: "destructive-foreground", bg: "destructive", min: TEXT },
  ...onSurfaces("seal", TEXT),
  ...onSurfaces("destructive", TEXT),
  ...onSurfaces("link", TEXT),
  ...onSurfaces("success", TEXT),
  ...onSurfaces("warning", TEXT),
  ...onSurfaces("input", UI),
  ...onSurfaces("ring", UI),
  { fg: "ring", bg: "accent", min: UI },
];

/** Splits tokens.css into the light `:root` block and the dark-scheme override. */
export function parseThemes(css: string): { light: Tokens; dark: Tokens } {
  const darkAt = css.indexOf("@media (prefers-color-scheme: dark)");
  if (darkAt < 0) throw new Error("tokens.css has no dark-scheme block");
  return { light: readVars(css.slice(0, darkAt)), dark: readVars(css.slice(darkAt)) };
}

function readVars(block: string): Tokens {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6});/gi)) {
    const [, name, value] = m;
    if (name && value) out[name] = value.toLowerCase();
  }
  return out;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r = 0, g = 0, b = 0] = channels.map((c) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
