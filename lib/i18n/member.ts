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
  /** The club needs the member number for this kind of request. */
  errorMemberNo: string;
  /** Accessible name of the EN | ES switch. */
  languageSwitch: string;

  // -- Choosing what to do. Shown only when the club has ordering switched on;
  // -- a club without it sees exactly the page it saw before ordering existed.
  /** Header line above the two choices. */
  chooseIntro: string;
  chooseIssue: string;
  chooseIssueHint: string;
  chooseOrder: string;
  chooseOrderHint: string;
  /** Link back from either form to the two choices. */
  back: string;

  // -- Ordering food and drink.
  orderIntro: string;
  orderBodyLabel: string;
  orderBodyPlaceholder: string;
  orderMemberNoLabel: string;
  orderMemberNoHint: string;
  orderNameHint: string;
  orderSubmit: string;
  orderSending: string;
  orderDoneHeading: string;
  /** `{location}` is replaced with the location name, lower-cased. */
  orderDoneBody: string;
  orderFooter: string;
  /** What the action says when the description is too short to send. */
  errorOrderBody: string;
  /** What the action says when no member number was given. */
  errorOrderMemberNo: string;
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
    errorMemberNo: "Food and drink requests need your member number — please add it below and send again.",
    languageSwitch: "Language",
    chooseIntro: "What can we help with?",
    chooseIssue: "Report an issue",
    chooseIssueHint: "Something out here needs attention",
    chooseOrder: "Order food & drink",
    chooseOrderHint: "Brought out to you where you are",
    back: "Back",
    orderIntro: "Tell us what you'd like and we'll bring it out to you.",
    orderBodyLabel: "What would you like?",
    orderBodyPlaceholder: "Two hot dogs and a lemonade",
    orderMemberNoLabel: "Member number",
    orderMemberNoHint: "So the club knows whose order this is. We need this to send it.",
    orderNameHint: "Your name and number, if you'd like the team to be able to check something with you.",
    orderSubmit: "Send my order",
    orderSending: "Sending…",
    orderDoneHeading: "Order received.",
    orderDoneBody: "The team has your order for {location} and is getting it ready now.",
    orderFooter: "The club puts this on your member account. No payment here.",
    errorOrderBody: "Please say what you would like.",
    errorOrderMemberNo: "We need your member number so the club knows whose order this is.",
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
    errorMemberNo: "Los pedidos de comida y bebida necesitan su número de socio — agréguelo abajo y envíe de nuevo.",
    languageSwitch: "Idioma",
    chooseIntro: "¿En qué podemos ayudarle?",
    chooseIssue: "Reportar un problema",
    chooseIssueHint: "Algo en el campo necesita atención",
    chooseOrder: "Pedir comida o bebida",
    chooseOrderHint: "Se lo llevamos hasta donde usted está",
    back: "Volver",
    orderIntro: "Díganos qué desea y se lo llevamos hasta donde está.",
    orderBodyLabel: "¿Qué desea pedir?",
    orderBodyPlaceholder: "Dos hot dogs y una limonada",
    orderMemberNoLabel: "Número de socio",
    orderMemberNoHint: "Para que el club sepa de quién es el pedido. Lo necesitamos para enviarlo.",
    orderNameHint: "Su nombre y número, por si el equipo necesita consultarle algo.",
    orderSubmit: "Enviar mi pedido",
    orderSending: "Enviando…",
    orderDoneHeading: "Pedido recibido.",
    orderDoneBody: "El equipo ya tiene su pedido para {location} y lo está preparando.",
    orderFooter: "El club lo carga a su cuenta de socio. Aquí no se paga nada.",
    errorOrderBody: "Por favor, díganos qué desea.",
    errorOrderMemberNo: "Necesitamos su número de socio para saber de quién es el pedido.",
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
