import { redirect } from "next/navigation";
import { getMe } from "@/lib/queue/actions-db";
import { getDashboard } from "@/lib/dashboard/queries";
import { VolumeChart } from "@/components/dashboard/volume-chart";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard — ProResponse" };

const mins = (v: number | null) =>
  v == null ? "—" : v < 60 ? `${v}m` : `${Math.floor(v / 60)}h ${Math.round(v % 60)}m`;

const CATEGORY_LABEL: Record<string, string> = {
  course_maintenance: "Course maintenance", pace_of_play: "Pace of play",
  cart_issue: "Cart", pro_shop: "Pro shop", f_and_b: "Food & beverage",
  restroom_facilities: "Restrooms", practice_facility: "Practice facility",
  safety: "Safety", caddie_valet: "Caddie & valet", needs_review: "Needs review",
};

export default async function DashboardPage() {
  const me = await getMe();
  if (!me) redirect("/login");
  // Per-person performance is management-only by default; a club is a small
  // place and this data is sensitive in it.
  if (!["manager", "owner"].includes(me.role)) redirect("/app");

  const { today, daily, byDept, recurring, byPerson } = await getDashboard();

  return (
    <main className="min-h-dvh bg-surface-app text-ink antialiased">
      <div className="mx-auto max-w-[62rem] px-6 pb-20">
        <header className="flex items-baseline justify-between pt-9 pb-6">
          <div>
            <h1 className="text-[1.5rem] font-semibold tracking-tight">Course status</h1>
            <p className="mt-1 text-[13px] text-ink-muted">{me.course_name} · last 30 days</p>
          </div>
          <div className="flex items-center gap-4">
            <a href="/app/staff" className="text-[14px] text-ink-muted underline underline-offset-4">
              Staff
            </a>
            <a href="/app/placards" className="text-[14px] text-ink-muted underline underline-offset-4">
              Placards
            </a>
            <a href="/app" className="text-[14px] text-ink-muted underline underline-offset-4">
              Open reports
            </a>
          </div>
        </header>

        {/* Headline figures are numbers, not charts — four values do not need
            axes to be understood. */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Open right now" value={today?.open_now ?? 0} />
          <Stat label="Filed today" value={today?.filed_today ?? 0} />
          <Stat label="Median time to respond" value={mins(today?.median_ack_minutes ?? null)} />
          <Stat label="Median time to resolve" value={mins(today?.median_resolve_minutes ?? null)} />
        </div>

        <Section title="Reports filed" sub="Last 30 days">
          <VolumeChart data={daily} />
        </Section>

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Section title="By department" sub="Open now, and how fast they close">
            <table className="w-full text-[14px]">
              <thead>
                <tr className="text-left text-[12px] uppercase tracking-wide text-ink-subtle">
                  <th className="pb-2 font-medium">Department</th>
                  <th className="pb-2 text-right font-medium">Open</th>
                  <th className="pb-2 text-right font-medium">30 days</th>
                  <th className="pb-2 text-right font-medium">Median</th>
                </tr>
              </thead>
              <tbody>
                {byDept.map((d) => (
                  <tr key={d.key} className="border-t border-line">
                    <td className="py-2.5">{d.name}</td>
                    <td className="py-2.5 text-right tabular-nums font-medium">{d.open_now}</td>
                    <td className="py-2.5 text-right tabular-nums text-ink-muted">{d.total_30d}</td>
                    <td className="py-2.5 text-right tabular-nums text-ink-muted">
                      {mins(d.median_resolve_minutes)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          {/* The view that earns the renewal: a month of complaints turned into
              something a superintendent can act on. */}
          <Section title="Recurring problems" sub="Same issue, same place, 3+ times in 30 days">
            <ul className="space-y-2.5">
              {recurring.map((r) => (
                <li key={`${r.location}-${r.category}`} className="flex items-baseline gap-3">
                  <span className="min-w-[2.2rem] text-[15px] font-semibold tabular-nums">
                    {r.occurrences}×
                  </span>
                  <span className="text-[14px]">{r.location}</span>
                  <span className="text-[13px] text-ink-muted">
                    {CATEGORY_LABEL[r.category] ?? r.category}
                  </span>
                </li>
              ))}
              {!recurring.length && (
                <li className="text-[14px] text-ink-muted">Nothing recurring — a good sign.</li>
              )}
            </ul>
          </Section>
        </div>

        <Section title="Team" sub="Resolved in the last 30 days, and typical handling time">
          <table className="w-full text-[14px]">
            <thead>
              <tr className="text-left text-[12px] uppercase tracking-wide text-ink-subtle">
                <th className="pb-2 font-medium">Name</th>
                <th className="pb-2 text-right font-medium">Resolved</th>
                <th className="pb-2 text-right font-medium">Median handling</th>
              </tr>
            </thead>
            <tbody>
              {byPerson.map((p) => (
                <tr key={p.profile_id} className="border-t border-line">
                  <td className="py-2.5">{p.full_name}</td>
                  <td className="py-2.5 text-right tabular-nums font-medium">{p.resolved_30d}</td>
                  <td className="py-2.5 text-right tabular-nums text-ink-muted">
                    {mins(p.median_handling_minutes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* Stated plainly, because the fairness of this number is the reason
              staff will or won't trust the whole system. */}
          <p className="mt-3 text-[12px] leading-relaxed text-ink-subtle">
            Handling time runs from when someone picked the report up, not when the
            member filed it — nobody is charged for routing delay.
          </p>
        </Section>
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-line bg-surface-raised px-4 py-4">
      <p className="text-[12px] leading-tight text-ink-muted">{label}</p>
      <p className="mt-1.5 text-[1.75rem] font-semibold leading-none tabular-nums">{value}</p>
    </div>
  );
}

function Section({ title, sub, children }: {
  title: string; sub?: string; children: React.ReactNode;
}) {
  return (
    <section className="mt-4 rounded-xl border border-line bg-surface-raised px-5 py-5">
      <div className="mb-4">
        <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
        {sub && <p className="mt-0.5 text-[12px] text-ink-muted">{sub}</p>}
      </div>
      {children}
    </section>
  );
}
