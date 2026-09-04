import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { brandingFrom, brandStyle } from "@/lib/branding";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your report" };

/**
 * The member's view of their own report.
 *
 * Deliberately narrow: status, their own words, and the message staff chose to
 * send them. Never the internal resolution note, never staff names, never
 * anything about the club's other reports. The tracking token is the only
 * credential and grants read access to exactly one row.
 */
interface Status {
  status: string;
  location_name: string;
  hole_number: number | null;
  body: string;
  member_message: string | null;
  created_at: string;
  resolved_at: string | null;
  course_name: string;
  settings: { branding?: { primary?: string } } | null;
}

const STAGE: Record<string, { label: string; note: string }> = {
  new:              { label: "Received",    note: "We have your report." },
  triaged:          { label: "Sent to the team", note: "The right team has been notified." },
  acknowledged:     { label: "Someone's on it", note: "A member of our team has picked this up." },
  in_progress:      { label: "Being handled", note: "Our team is working on it now." },
  scheduled:        { label: "Scheduled",    note: "This is booked in with our team." },
  resolved:         { label: "Resolved",     note: "This has been taken care of." },
  verified:         { label: "Resolved",     note: "This has been taken care of." },
  closed_no_action: { label: "Closed",       note: "We looked into this." },
};

export default async function StatusPage({
  params,
}: {
  params: Promise<{ trackingToken: string }>;
}) {
  const { trackingToken } = await params;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_report_status", {
    p_tracking_token: trackingToken,
  });

  const row = (Array.isArray(data) ? data[0] : data) as Status | undefined;
  if (error || !row) notFound();

  const branding = brandingFrom(row.settings);
  const stage = STAGE[row.status] ?? STAGE.new;
  const done = ["resolved", "verified", "closed_no_action"].includes(row.status);

  return (
    <main className="min-h-dvh bg-surface-raised text-ink antialiased" style={brandStyle(branding)}>
      <div className="mx-auto max-w-[30rem] px-6 py-10">
        <p className="text-[11px] uppercase tracking-[0.2em] text-ink-muted">
          {row.course_name}
        </p>
        <div className="mt-4 h-px w-10 bg-accent" />

        <h1 className="mt-6 text-[1.8rem] font-medium leading-tight tracking-tight">
          {stage.label}
        </h1>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-secondary">{stage.note}</p>

        {/* What staff chose to tell them. Never the internal note. */}
        {row.member_message && (
          <div
            className="mt-6 rounded-xl border-l-2 border-accent bg-surface-sunken px-5 py-4"
          >
            <p className="text-[15px] leading-relaxed text-ink">
              {row.member_message}
            </p>
            <p className="mt-2 text-[12px] text-ink-muted">
              — {row.course_name}
            </p>
          </div>
        )}

        <div className="mt-8 rounded-xl border border-line px-5 py-4">
          <p className="text-[11px] uppercase tracking-[0.14em] text-ink-subtle">
            What you reported
          </p>
          <p className="mt-2 text-[15px] leading-relaxed text-ink-secondary">{row.body}</p>
          <p className="mt-3 text-[12px] text-ink-muted">
            {row.hole_number ? `Hole ${row.hole_number}` : row.location_name} ·{" "}
            {new Date(row.created_at).toLocaleString("en-US", {
              month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
            })}
          </p>
        </div>

        {!done && (
          <p className="mt-6 text-center text-[13px] text-ink-subtle">
            Keep this page — it updates as our team works on it.
          </p>
        )}
      </div>
    </main>
  );
}
