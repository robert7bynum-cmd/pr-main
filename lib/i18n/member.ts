/**
 * Every visible word on the member page, in both languages it speaks.
 *
 * Pure module — no server imports — so the form (a client component), the
 * server action, and the offline test can all read the same table. One table:
 * a string that exists in English and not in Spanish is a type error here,
 * not a blank label found by a groundskeeper at hole 9.
 *
 * Spanish is written formal (usted) with the vocabulary golfers actually use:
 * hoyo, calle, green, carrito. The register matters — this is a club, not an
 * app store.
 */
export type Lang = "en" | "es";

export const LANGS: readonly Lang[] = ["en", "es"] as const;

export interface MemberStrings {
  /** Browser-tab title before the club's name. */
  title: string;
  /** Under the location heading. The heading itself is the location name. */
  intro: string;
  bodyLabel: string;
  bodyPlaceholder: string;
  optionalToggle: string;
  optionalNote: string;
  privacyLink: string;
  namePlaceholder: string;
  memberNoPlaceholder: string;
  phonePlaceholder: string;
  emailPlaceholder: string;
  submit: string;
  sending: string;
  footer: string;
  doneHeading: string;
  /** `{location}` is replaced with the location name, lower-cased. */
  doneBody: string;
  /** What the action says when the description is too short to route. */
  errorDescribe: string;
  /** What the action says when the failure is ours, not the member's. */
  errorFallback: string;
  /** Accessible name of the EN | ES switch. */
  languageSwitch: string;
}

export const MEMBER_STRINGS: Record<Lang, MemberStrings> = {
  en: {
    title: "Report an issue",
    intro: "Something needs attention? Let us know and the right team is notified immediately.",
    bodyLabel: "What did you notice?",
    bodyPlaceholder: "Tell us what's wrong — a sentence is plenty.",
    optionalToggle: "Add your name or number (optional)",
    optionalNote: "Only used if the team needs to ask you something about this report.",
    privacyLink: "How we use this",
    namePlaceholder: "Name",
    memberNoPlaceholder: "Member number",
    phonePlaceholder: "Mobile number",
    emailPlaceholder: "Email",
    submit: "Send to the club",
    sending: "Sending…",
    footer: "No app, no account. Goes straight to the team on duty.",
    doneHeading: "Thank you — we're on it.",
    doneBody: "Our team has been notified about {location}. Someone is looking at it now.",
    errorDescribe: "Please describe the issue.",
    errorFallback: "Something went wrong. Please try again.",
    languageSwitch: "Language",
  },
  es: {
    title: "Reportar un problema",
    intro: "¿Algo necesita atención? Avísenos y el equipo indicado será notificado de inmediato.",
    bodyLabel: "¿Qué notó usted?",
    bodyPlaceholder: "Cuéntenos qué ocurre — con una frase basta.",
    optionalToggle: "Agregar su nombre o número (opcional)",
    optionalNote: "Solo se usa si el equipo necesita consultarle algo sobre este reporte.",
    privacyLink: "Cómo usamos sus datos",
    namePlaceholder: "Nombre",
    memberNoPlaceholder: "Número de socio",
    phonePlaceholder: "Número de celular",
    emailPlaceholder: "Correo electrónico",
    submit: "Enviar al club",
    sending: "Enviando…",
    footer: "Sin aplicación ni cuenta. Llega directo al equipo de turno.",
    doneHeading: "Gracias — ya nos ocupamos.",
    doneBody: "Nuestro equipo ya fue notificado sobre {location}. Alguien lo está revisando ahora.",
    errorDescribe: "Por favor, describa el problema.",
    errorFallback: "Algo salió mal. Por favor, inténtelo de nuevo.",
    languageSwitch: "Idioma",
  },
};

/** The strings for one language. */
export function t(lang: Lang): MemberStrings {
  return MEMBER_STRINGS[lang];
}

/** Anything that is not exactly one of ours is not a language we speak. */
export function isLang(v: unknown): v is Lang {
  return v === "en" || v === "es";
}

/**
 * Which language to show.
 *
 * An explicit `?lang=` wins, because the toggle on the page sets it and a
 * person who chose must not be overruled by their phone's settings. Otherwise
 * the browser's own preference, where a Spanish-first phone says so in
 * Accept-Language. Otherwise English — the club's staff surface is English
 * and the placard was printed in English.
 */
export function pickLang(
  param: string | string[] | undefined | null,
  acceptLanguage: string | null | undefined,
): Lang {
  const p = Array.isArray(param) ? param[0] : param;
  if (isLang(p)) return p;

  // Accept-Language: "es-MX,es;q=0.9,en;q=0.8" — the first entry is the
  // preferred one. Only its primary subtag matters.
  const first = (acceptLanguage ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
  if (first === "es" || first.startsWith("es-")) return "es";
  return "en";
}

/** Replace `{name}` placeholders. Unknown placeholders are left as written. */
export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}
