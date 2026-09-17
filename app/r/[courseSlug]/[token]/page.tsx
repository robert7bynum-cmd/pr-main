import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { getScanContext, issueScanNonce } from "@/lib/scan/context";
import { ReportForm } from "@/components/reporter/report-form";
import { OrderForm } from "@/components/reporter/order-form";
import { brandStyle } from "@/lib/branding";
import { LANGS, pickLang, t } from "@/lib/i18n/member";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ lang?: string | string[]; ask?: string | string[] }>;

/**
 * Which of the two things the member is here to do.
 *
 * A plain query parameter rather than client state, for the same reason the
 * language switch is a link: the page re-renders on the server, mints one
 * nonce, and a member who taps back gets a working form rather than a stale
 * one. It also means a club can print a sign that goes straight to ordering.
 *
 * Absent means "ask them" — unless the club has ordering switched off, in
 * which case there is nothing to ask and the page is exactly what it was
 * before ordering existed.
 */
type Ask = "choose" | "issue" | "order";

function pickAsk(param: string | string[] | undefined, orderingEnabled: boolean): Ask {
  if (!orderingEnabled) return "issue";
  const v = Array.isArray(param) ? param[0] : param;
  if (v === "order") return "order";
  if (v === "issue") return "issue";
  return "choose";
}

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: SearchParams;
}) {
  const [{ token }, { lang: langParam, ask: askParam }, h] = await Promise.all([
    params, searchParams, headers(),
  ]);
  const ctx = await getScanContext(token);
  const s = t(pickLang(langParam, h.get("accept-language")));
  // The tab said "Report an issue" while a member was ordering a hot dog.
  const ask = pickAsk(askParam, ctx?.orderingEnabled ?? false);
  const title = ask === "order" ? s.chooseOrder : s.title;
  return { title: ctx ? `${title} — ${ctx.courseName}` : title };
}

export default async function ReporterPage({
  params,
  searchParams,
}: {
  params: Promise<{ courseSlug: string; token: string }>;
  searchParams: SearchParams;
}) {
  const [{ courseSlug, token }, { lang: langParam, ask: askParam }, h] = await Promise.all([
    params,
    searchParams,
    headers(),
  ]);
  const ctx = await getScanContext(token);

  // An unknown or retired placard token. Never guess a location — a report
  // filed against the wrong hole is worse than one never filed.
  if (!ctx) notFound();

  const ask = pickAsk(askParam, ctx.orderingEnabled);

  // Minted here and only here, and only when a form is actually on screen.
  // generateMetadata above deliberately does not mint: it runs as a separate
  // invocation, and minting in both was doubling every placard's nonce
  // consumption. The chooser mints nothing for the same reason — a member
  // reading two buttons has not started filling anything in.
  const nonce = ask === "choose" ? null : await issueScanNonce(token);

  // The page's language, not the document's: <html lang> is set once in the
  // root layout for the whole app, so the member page marks itself instead.
  const lang = pickLang(langParam, h.get("accept-language"));
  const s = t(lang);

  return (
    <main lang={lang} className="min-h-dvh bg-surface text-ink antialiased" style={brandStyle(ctx.branding)}>
      <div className="mx-auto flex min-h-dvh max-w-[30rem] flex-col px-6">
        {/* pb kept tight: the heading names where the member is standing and
            the form is the answer to it, so a wide gap reads as two unrelated
            screens stacked. */}
        <header className="pt-12 pb-4">
          <div className="flex items-start justify-between gap-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-ink-muted">
              {ctx.courseName}
            </p>
            {/* Plain links, not client navigation: the whole page re-renders
                in the other language and the nonce is minted once, exactly as
                a reload would. */}
            <nav
              aria-label={s.languageSwitch}
              className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-ink-subtle"
            >
              {LANGS.map((l, i) => (
                <span key={l} className="flex items-center gap-2">
                  {i > 0 && <span aria-hidden="true">|</span>}
                  {l === lang ? (
                    <span aria-current="true" className="font-medium text-ink">{l}</span>
                  ) : (
                    <a
                      href={`/r/${courseSlug}/${token}?lang=${l}${
                        ask === "choose" ? "" : `&ask=${ask}`
                      }`}
                      hrefLang={l}
                      className="underline underline-offset-4 hover:text-ink-secondary"
                    >
                      {l}
                    </a>
                  )}
                </span>
              ))}
            </nav>
          </div>
          <div className="mt-4 h-0.5 w-10 rounded-pill bg-accent" />
          {/* The scan already established where they are. Showing it as a
              statement rather than a form field is the whole point: the
              member never types or picks a hole number. */}
          <h1 className="mt-7 font-display text-[2.3rem] leading-none tracking-tight">
            {ctx.locationName}
          </h1>
          <p className="mt-3 text-[15px] leading-relaxed text-ink-secondary">
            {ask === "choose" ? s.chooseIntro : ask === "order" ? s.orderIntro : s.intro}
          </p>
        </header>

        <div className="flex-1 pb-12">
          {ask === "choose" ? (
            <div className="space-y-3">
              {/* Two links, not two tabs: each is a whole page, so the back
                  button does what a member expects and neither form is
                  rendered until it is wanted. */}
              <a
                href={`/r/${courseSlug}/${token}?lang=${lang}&ask=issue`}
                className="block rounded-card border border-line bg-surface-raised px-6 py-6 shadow-card transition hover:border-accent-border"
              >
                <span className="block font-display text-[1.35rem] leading-tight tracking-tight">
                  {s.chooseIssue}
                </span>
                <span className="mt-1.5 block text-[14px] leading-relaxed text-ink-secondary">
                  {s.chooseIssueHint}
                </span>
              </a>
              <a
                href={`/r/${courseSlug}/${token}?lang=${lang}&ask=order`}
                className="block rounded-card border border-line bg-surface-raised px-6 py-6 shadow-card transition hover:border-accent-border"
              >
                <span className="block font-display text-[1.35rem] leading-tight tracking-tight">
                  {s.chooseOrder}
                </span>
                <span className="mt-1.5 block text-[14px] leading-relaxed text-ink-secondary">
                  {s.chooseOrderHint}
                </span>
              </a>
            </div>
          ) : (
            <>
              {ask === "order" ? (
                <OrderForm ctx={ctx} token={token} nonce={nonce} lang={lang} />
              ) : (
                <ReportForm ctx={ctx} token={token} nonce={nonce} lang={lang} />
              )}
              {ctx.orderingEnabled && (
                <p className="mt-6 text-center text-[13px]">
                  <a
                    href={`/r/${courseSlug}/${token}?lang=${lang}`}
                    className="text-ink-muted underline underline-offset-4 hover:text-ink-secondary"
                  >
                    ← {s.back}
                  </a>
                </p>
              )}
            </>
          )}
        </div>

        <footer className="border-t border-line py-6">
          <p className="text-center text-[11px] tracking-[0.16em] uppercase text-ink-subtle">
            ProResponse
          </p>
        </footer>
      </div>
    </main>
  );
}
