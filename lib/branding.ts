/**
 * Turning a club's stored branding into design tokens.
 *
 * Everything visual is a CSS custom property (see app/globals.css), so a club
 * is rebranded by overriding a handful of them on a wrapper element. Nothing in
 * any component changes — which is the whole point: club #2 should be a config
 * row, not a pull request.
 *
 * Unset means unset. These fields are null when a club has not chosen, and
 * brandStyle then emits nothing for them, so the stylesheet's own values apply.
 * The earlier version repeated the default palette here as literal hexes, which
 * meant two files had to agree about what the product looks like — and the
 * house rule is that there is one of everything.
 *
 * The three tokens below are semantic, not primitives. Every tint, border and
 * muted variant in globals.css is mixed from them, so overriding ink alone
 * still produces a whole consistent ink ramp rather than one dark heading over
 * four stock greys.
 */
export interface Branding {
  primary: string | null;   // the club's accent   → --accent
  ink: string | null;       // body text           → --ink
  surface: string | null;   // page background     → --surface
  logoUrl: string | null;
}

/** Nothing chosen: app/globals.css decides. */
export const DEFAULT_BRANDING: Branding = {
  primary: null,
  ink: null,
  surface: null,
  logoUrl: null,
};

/** Merge a course's settings.branding over the defaults. */
export function brandingFrom(settings: unknown): Branding {
  const b = (settings as { branding?: Partial<Branding> } | null)?.branding ?? {};
  return {
    primary: b.primary ?? DEFAULT_BRANDING.primary,
    ink: b.ink ?? DEFAULT_BRANDING.ink,
    surface: b.surface ?? DEFAULT_BRANDING.surface,
    logoUrl: b.logoUrl ?? DEFAULT_BRANDING.logoUrl,
  };
}

/**
 * Inline style object overriding the semantic tokens for one club.
 * Spread onto a wrapper: <main style={brandStyle(branding)}>
 *
 * Only what the club actually set is written. An empty object here is the
 * correct, common case.
 */
export function brandStyle(b: Branding): React.CSSProperties {
  return {
    ...(b.primary ? { "--accent": b.primary } : {}),
    ...(b.ink ? { "--ink": b.ink } : {}),
    ...(b.surface ? { "--surface": b.surface } : {}),
  } as React.CSSProperties;
}
