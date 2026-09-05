import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isPreview, deploymentRef } from "@/lib/deployment";
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

  const preview = isPreview();
  const branch = deploymentRef().branch;

  const set = await getPlacards(origin);
  if (!set) redirect("/app");

  return (
    <main>
      <div className="no-print mx-auto max-w-[62rem] px-6 pt-10 pb-5">
        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="font-display text-[1.75rem] tracking-tight">Placards</h1>
            <p className="mt-1 text-[13px] text-ink-muted">
              {set.placards.length} codes for {set.courseName}
            </p>
          </div>
        </div>

        {/* The single most expensive mistake here is printing against the wrong
            host, because it means replacing physical signs. A preview
            deployment is that mistake by construction: its URL belongs to a
            branch and stops resolving when the branch is deleted, so this
            warns on screen and on paper rather than relying on the reader to
            recognise a vercel.app hostname. */}
        {/* A warning is not a control when the output is a physical object bolted
            to a tee box. An address that cannot survive printing blocks the
            sheet outright — @media print hides it too, so ⌘P produces nothing
            rather than a page of dead codes. */}
        {set.unprintable ? (
          <div className="mt-5 rounded-card border border-urgent-border bg-urgent-surface px-5 py-4 shadow-card">
            <p className="text-[13px] font-medium text-urgent">
              These codes cannot be printed.
            </p>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">
              They point at <span className="font-medium text-ink">{origin}</span>
              {origin.includes("localhost") || origin.includes("127.0.0.1")
                ? ", which only exists on the computer rendering this page. A member scanning it on the course would reach nothing."
                : ", a preview address that stops resolving when its branch is deleted."}{" "}
              Set the club&rsquo;s real address in its settings, then print from here.
            </p>
            {preview && (
              <p className="mt-2.5 text-[13px] leading-relaxed text-ink-muted">
                This is the preview build for branch{" "}
                <span className="font-medium text-ink">{branch ?? "unknown"}</span>.
              </p>
            )}
          </div>
        ) : (
          <div className="mt-5 rounded-card border border-line bg-surface-raised px-5 py-4 shadow-card">
            <p className="text-[13px] leading-relaxed text-ink-secondary">
              These codes point at <span className="font-medium text-ink">{origin}</span>
              {set.originSource === "configured"
                ? ", the address set for this club."
                : ", taken from this deployment because no address is set for the club. Set one before printing, so a future move does not kill every sign."}
            </p>
            <p className="mt-2.5 text-[13px] leading-relaxed text-ink-muted">
              Print from your browser (⌘P). One placard per page, sized for a
              standard tee marker.
            </p>
          </div>
        )}
      </div>

      <div className="mx-auto max-w-[62rem] px-6 pb-20">
        {set.unprintable ? (
          <p className="rounded-card border border-line bg-surface-raised px-5 py-10 text-center text-[14px] text-ink-muted">
            The sheet is hidden until this club has a printable address.
          </p>
        ) : (
          <PlacardSheet set={set} />
        )}
      </div>
    </main>
  );
}
