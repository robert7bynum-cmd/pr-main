import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { getScanContext, issueScanNonce } from "@/lib/scan/context";
import { ReportForm } from "@/components/reporter/report-form";
import { brandStyle } from "@/lib/branding";
import { LANGS, pickLang, t } from "@/lib/i18n/member";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ lang?: string | string[] }>;

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: SearchParams;
}) {
  const [{ token }, { lang: langParam }, h] = await Promise.all([params, searchParams, headers()]);
  const ctx = await getScanContext(token);
  const s = t(pickLang(langParam, h.get("accept-language")));
  return { title: ctx ? `${s.title} — ${ctx.courseName}` : s.title };
}

export default async function ReporterPage({
  params,
  searchParams,
}: {
  params: Promise<{ courseSlug: string; token: string }>;
  searchParams: SearchParams;
}) {
  const [{ courseSlug, token }, { lang: langParam }, h] = await Promise.all([
    params,
    searchParams,
    headers(),
  ]);
  const ctx = await getScanContext(token);

  // An unknown or retired placard token. Never guess a location — a report
  // filed against the wrong hole is worse than one never filed.
  if (!ctx) notFound();

  // Minted here and only here. generateMetadata above deliberately does not
  // mint: it runs as a separate invocation, and minting in both was doubling
  // every placard's nonce consumption.
  const nonce = await issueScanNonce(token);

  // The page's language, not the document's: <html lang> is set once in the
  // root layout for the whole app, so the member page marks itself instead.
  const lang = pickLang(langParam, h.get("accept-language"));
  const s = t(lang);

  return (
    <main lang={lang} className="min-h-dvh bg-surface text-ink antialiased" style={brandStyle(ctx.branding)}>
      <div className="mx-auto flex min-h-dvh max-w-[30rem] flex-col px-6">
        <header className="pt-12 pb-9">
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
                      href={`/r/${courseSlug}/${token}?lang=${l}`}
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
          <p className="mt-4 text-[15px] leading-relaxed text-ink-secondary">
            {s.intro}
          </p>
        </header>

        <div className="flex-1 pb-12">
          <ReportForm ctx={ctx} token={token} nonce={nonce} lang={lang} />
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
