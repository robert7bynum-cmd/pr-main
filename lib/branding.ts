/**
 * Turning a club's stored branding into design tokens.
 *
 * Everything visual is a CSS custom property (see app/globals.css), so a club
 * is rebranded by overriding a handful of them on a wrapper element. Nothing in
 * any component changes — which is the whole point: club #2 should be a config
 * row, not a pull request.
 */
export interface Branding {
  primary: string;   // the club's accent
  ink: string;       // body text
  surface: string;   // page background
  logoUrl: string | null;
}

export const DEFAULT_BRANDING: Branding = {
  primary: "#e2af47",
  ink: "#111111",
  surface: "#ffffff",
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
 */
export function brandStyle(b: Branding): React.CSSProperties {
  return {
    "--accent": b.primary,
    "--c-black": b.ink,
    "--surface": b.surface,
  } as React.CSSProperties;
}
