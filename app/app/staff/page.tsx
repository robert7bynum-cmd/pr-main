import { redirect } from "next/navigation";
import { getMe } from "@/lib/queue/actions-db";
import { getStaffPage } from "@/lib/staff/queries";
import { StaffTable } from "@/components/staff-admin/staff-table";
import { InviteForm } from "@/components/staff-admin/invite-form";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";
export const metadata = { title: "Staff — ProResponse" };

export default async function StaffPage() {
  const me = await getMe();
  if (!me) redirect("/login");
  if (!["manager", "owner"].includes(me.role)) redirect("/app");

  const { roster, departments, pending } = await getStaffPage();
  const active = roster.filter((r) => r.active).length;

  return (
    <main>
      <div className="mx-auto max-w-[48rem] px-5 pb-24">
        <header className="flex items-baseline justify-between pt-10 pb-6">
          <div>
            <h1 className="font-display text-[1.75rem] tracking-tight">Staff</h1>
            <p className="mt-1.5 text-[13px] text-ink-muted">
              {active} active
            </p>
          </div>
        </header>

        <div className="mb-5">
          <InviteForm departments={departments} canInviteOwner={me.role === "owner"} />
        </div>

        {/* Somebody invited who has never signed in is a gap a manager would
            otherwise not see — they believe that person is covered. */}
        {pending.length > 0 && (
          <div className="mb-5 rounded-card border border-tone-high-border bg-tone-high-fill px-5 py-4 shadow-card">
            <Badge variant="high" size="sm">Gap</Badge>
            <p className="mt-2.5 text-[13px] font-medium text-tone-high-ink">
              Invited, not signed in yet
            </p>
            <ul className="mt-2 space-y-1.5">
              {pending.map((p) => (
                <li key={p.id} className="text-[13px] text-ink-secondary">
                  {p.full_name} · {p.email} · {p.role}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[12px] leading-relaxed text-ink-secondary">
              They will not receive alerts until they sign in.
            </p>
          </div>
        )}

        <StaffTable
          roster={roster}
          departments={departments}
          myRole={me.role}
          myId={me.profile_id}
        />
      </div>
    </main>
  );
}
