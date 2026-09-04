import { getQueue, getDepartmentCounts } from "@/lib/queue/reports";
import { QueueCard } from "@/components/staff/queue-card";

export const dynamic = "force-dynamic";
export const metadata = { title: "Queue — ProResponse" };

export default async function StaffQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ dept?: string }>;
}) {
  const { dept } = await searchParams;
  const [rows, departments] = await Promise.all([
    getQueue(dept),
    getDepartmentCounts(),
  ]);

  const overdue = rows.filter((r) => r.ack_overdue).length;

  return (
    <main className="min-h-dvh bg-[#f6f6f5] text-black antialiased">
      <div className="mx-auto max-w-[34rem] px-4 pb-24">
        <header className="pt-8 pb-4">
          <div className="flex items-baseline justify-between">
            <h1 className="text-[1.35rem] font-semibold tracking-tight">Open reports</h1>
            <span className="text-[13px] tabular-nums text-black/50">
              {rows.length} open{overdue > 0 ? ` · ${overdue} overdue` : ""}
            </span>
          </div>

          {/* Department filter. Staff see their own departments in the real
              build; showing all of them is a demo affordance. */}
          <nav className="mt-4 -mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
            <FilterChip href="/app" label="All" count={null} active={!dept} />
            {departments.map((d) => (
              <FilterChip
                key={d.key}
                href={`/app?dept=${d.key}`}
                label={d.name}
                count={d.open}
                active={dept === d.key}
              />
            ))}
          </nav>
        </header>

        {rows.length === 0 ? (
          <p className="rounded-2xl border border-black/10 bg-white px-5 py-10 text-center text-[15px] text-black/45">
            Nothing open here. The course is quiet.
          </p>
        ) : (
          <div className="space-y-2.5">
            {rows.map((row) => (
              <QueueCard key={row.id} row={row} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function FilterChip({
  href, label, count, active,
}: { href: string; label: string; count: number | null; active: boolean }) {
  return (
    <a
      href={href}
      className={`shrink-0 rounded-full px-3.5 py-2 text-[13px] font-medium transition ${
        active ? "bg-black text-white" : "bg-white text-black/65 border border-black/10"
      }`}
    >
      {label}
      {count !== null && <span className="ml-1.5 tabular-nums opacity-60">{count}</span>}
    </a>
  );
}
