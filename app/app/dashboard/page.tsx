import { redirect } from "next/navigation";
import { getMe } from "@/lib/queue/actions-db";
import { getDashboard, getHealth } from "@/lib/dashboard/queries";
import { VolumeChart } from "@/components/dashboard/volume-chart";
import { Badge } from "@/components/ui/badge";

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

  const [{ today, daily, byDept, recurring, byPerson }, health] = await Promise.all([
    getDashboard(),
    getHealth(),
  ]);

  return (
    <main>
      <div className="mx-auto max-w-[62rem] px-6 pb-24">
        <header className="flex items-baseline justify-between pt-10 pb-7">
          <div>
            <h1 className="font-display text-[1.75rem] tracking-tight">Course status</h1>
            <p className="mt-1.5 text-[13px] text-ink-muted">Last 30 days</p>
          </div>
        </header>

        {/* Only rendered when something is wrong, so its presence is the
            signal. A permanent green tick teaches people to ignore it. */}
        {health.length > 0 && (
          <div className="mb-5 space-y-3">
            {health.map((h) => (
              <div
                key={h.issue}
                className={`rounded-card border px-5 py-4 shadow-card ${
                  h.severity === "critical"
                    ? "border-urgent-border bg-urgent-surface"
                    : "border-tone-high-border bg-tone-high-fill"
                }`}
              >
                {/* The severity is a word, not a hue: this gets read on a phone
                    in a cart, and "critical" has to survive the sun. */}
                <Badge variant={h.severity === "critical" ? "urgent" : "high"} size="sm">
                  {h.severity === "critical" ? "Critical" : "Warning"}
                </Badge>
                <p className={`mt-2.5 text-[14px] font-medium ${
                  h.severity === "critical" ? "text-urgent" : "text-tone-high-ink"
                }`}>
                  {h.issue}
                </p>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{h.detail}</p>
              </div>
            ))}
          </div>
        )}

        {/* Headline figures are numbers, not charts — four values do not need
            axes to be understood. */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Stat label="Open right now" value={today?.open_now ?? 0} />
          <Stat label="Filed today" value={today?.filed_today ?? 0} />
          <Stat label="Median time to respond" value={mins(today?.median_ack_minutes ?? null)} />
          <Stat label="Median time to resolve" value={mins(today?.median_resolve_minutes ?? null)} />
        </div>

        <Section title="Reports filed" sub="Last 30 days">
          <VolumeChart data={daily} />
        </Section>

        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <Section title="By department" sub="Open now, and how fast they close">
            <table className="w-full text-[14px]">
              <thead>
                <tr className="text-left text-[12px] uppercase tracking-wide text-ink-subtle">
                  <th className="pb-3 font-medium">Department</th>
                  <th className="pb-3 text-right font-medium">Open</th>
                  <th className="pb-3 text-right font-medium">30 days</th>
                  <th className="pb-3 text-right font-medium">Median</th>
                </tr>
              </thead>
              <tbody>
                {byDept.map((d) => (
                  <tr key={d.key} className="border-t border-line">
                    <td className="py-3">{d.name}</td>
                    <td className="py-3 text-right tabular-nums font-medium">{d.open_now}</td>
                    <td className="py-3 text-right tabular-nums text-ink-muted">{d.total_30d}</td>
                    <td className="py-3 text-right tabular-nums text-ink-muted">
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
            <ul className="space-y-3">
              {recurring.map((r) => (
                <li key={`${r.location}-${r.category}`} className="flex flex-wrap items-center gap-2.5 border-b border-line pb-3 last:border-0 last:pb-0">
                  <span className="min-w-[2.4rem] text-[16px] font-semibold tabular-nums">
                    {r.occurrences}×
                  </span>
                  <span className="text-[14px] font-medium">{r.location}</span>
                  <Badge variant="department">
                    {CATEGORY_LABEL[r.category] ?? r.category}
                  </Badge>
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
                <th className="pb-3 font-medium">Name</th>
                <th className="pb-3 text-right font-medium">Resolved</th>
                <th className="pb-3 text-right font-medium">Median handling</th>
              </tr>
            </thead>
            <tbody>
              {byPerson.map((p) => (
                <tr key={p.profile_id} className="border-t border-line">
                  <td className="py-3">{p.full_name}</td>
                  <td className="py-3 text-right tabular-nums font-medium">{p.resolved_30d}</td>
                  <td className="py-3 text-right tabular-nums text-ink-muted">
                    {mins(p.median_handling_minutes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* Stated plainly, because the fairness of this number is the reason
              staff will or won't trust the whole system. */}
          <p className="mt-5 border-t border-line pt-4 text-[12px] leading-relaxed text-ink-subtle">
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
    <div className="rounded-card border border-line bg-surface-raised px-5 py-5 shadow-card">
      <p className="text-[12px] leading-snug text-ink-muted">{label}</p>
      <p className="mt-3 font-display text-[2rem] leading-none tabular-nums">{value}</p>
    </div>
  );
}

function Section({ title, sub, children }: {
  title: string; sub?: string; children: React.ReactNode;
}) {
  return (
    <section className="mt-5 rounded-card border border-line bg-surface-raised px-6 py-6 shadow-card">
      <div className="mb-5">
        <h2 className="font-display text-[17px] tracking-tight">{title}</h2>
        {sub && <p className="mt-1 text-[12px] text-ink-muted">{sub}</p>}
      </div>
      {children}
    </section>
  );
}
