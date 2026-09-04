import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getMe } from "@/lib/queue/actions-db";
import { getPlacards } from "@/lib/placards/queries";
import { PlacardSheet } from "@/components/placards/placard-sheet";

export const dynamic = "force-dynamic";
export const metadata = { title: "Placards — ProResponse" };

export default async function PlacardsPage() {
  const me = await getMe();
  if (!me) redirect("/login");
  if (!["manager", "owner", "supervisor"].includes(me.role)) redirect("/app");

  // The origin the manager is actually on. A code printed against the wrong
  // host is a sign that has to be physically replaced.
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "http";
  const host = h.get("host") ?? "localhost:3000";
  const origin = `${proto}://${host}`;

  const set = await getPlacards(origin);
  if (!set) redirect("/app");

  return (
    <main>
      <div className="no-print mx-auto max-w-[62rem] px-6 pt-9 pb-4">
        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="text-[1.5rem] font-semibold tracking-tight">Placards</h1>
            <p className="mt-1 text-[13px] text-ink-muted">
              {set.placards.length} codes for {set.courseName}
            </p>
          </div>
        </div>

        {/* The single most expensive mistake here is printing against the wrong
            host, because it means replacing physical signs. */}
        <div className="mt-4 rounded-card border border-line bg-surface-raised px-4 py-3">
          <p className="text-[13px] leading-relaxed text-ink-secondary">
            These codes point at <span className="font-medium text-ink">{origin}</span>.
            Print them from the address members will actually use — a code printed
            against the wrong one has to be physically replaced.
          </p>
          <p className="mt-2 text-[13px] text-ink-muted">
            Print from your browser (⌘P). One placard per page, sized for a
            standard tee marker.
          </p>
        </div>
      </div>

      <div className="mx-auto max-w-[62rem] px-6 pb-16">
        <PlacardSheet set={set} />
      </div>
    </main>
  );
}
