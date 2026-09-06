import { redirect } from "next/navigation";
import { getMe } from "@/lib/queue/actions-db";
import { getLocationsForFiling } from "@/lib/queue/reports";
import { FileReportForm } from "@/components/staff/file-report-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Report an issue — ProResponse" };

/**
 * Staff filing a report. Anyone signed in at the club: the superintendent on
 * the morning drive, the pro shop taking a call, the starter at the first tee.
 */
export default async function FileReportPage() {
  const me = await getMe();
  if (!me) redirect("/login");

  const locations = await getLocationsForFiling();

  return (
    <main>
      <div className="mx-auto max-w-[34rem] px-5 pb-28">
        <header className="pt-9 pb-5">
          <p className="text-[11px] uppercase tracking-[0.2em] text-ink-muted">
            {me.course_name}
          </p>
          <h1 className="mt-2 font-display text-[1.6rem] tracking-tight">Report an issue</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">
            Goes to the team the same way a member&apos;s scan does.
          </p>
        </header>

        {locations.length === 0 ? (
          <div className="rounded-card border border-line bg-surface-raised px-6 py-12 text-center shadow-card">
            <p className="text-[15px] leading-relaxed text-ink-muted">
              This club has no locations set up yet, so there is nothing to file against.
            </p>
          </div>
        ) : (
          <FileReportForm locations={locations} />
        )}
      </div>
    </main>
  );
}
