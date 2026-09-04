import { notFound } from "next/navigation";
import { getScanContext } from "@/lib/scan/context";
import { ReportForm } from "@/components/reporter/report-form";
import { brandStyle } from "@/lib/branding";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const ctx = await getScanContext(token);
  return { title: ctx ? `Report an issue — ${ctx.courseName}` : "Report an issue" };
}

export default async function ReporterPage({
  params,
}: {
  params: Promise<{ courseSlug: string; token: string }>;
}) {
  const { token } = await params;
  const ctx = await getScanContext(token);

  // An unknown or retired placard token. Never guess a location — a report
  // filed against the wrong hole is worse than one never filed.
  if (!ctx) notFound();

  return (
    <main className="min-h-dvh bg-surface-raised text-ink antialiased" style={brandStyle(ctx.branding)}>
      <div className="mx-auto flex min-h-dvh max-w-[30rem] flex-col px-6">
        <header className="pt-10 pb-8">
          <p className="text-[11px] uppercase tracking-[0.2em] text-ink-muted">
            {ctx.courseName}
          </p>
          <div className="mt-4 h-px w-10 bg-accent" />
          {/* The scan already established where they are. Showing it as a
              statement rather than a form field is the whole point: the
              member never types or picks a hole number. */}
          <h1 className="mt-6 text-[2.1rem] font-medium leading-none tracking-tight">
            {ctx.locationName}
          </h1>
          <p className="mt-3 text-[15px] text-ink-muted">
            Something needs attention? Let us know and the right team is notified
            immediately.
          </p>
        </header>

        <div className="flex-1 pb-10">
          <ReportForm ctx={ctx} token={token} />
        </div>

        <footer className="border-t border-line py-5">
          <p className="text-center text-[11px] tracking-wide text-ink-subtle">
            ProResponse
          </p>
        </footer>
      </div>
    </main>
  );
}
