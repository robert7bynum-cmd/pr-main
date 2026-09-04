import { redirect } from "next/navigation";
import { getMe } from "@/lib/queue/actions-db";
import { getStaffPage } from "@/lib/staff/queries";
import { StaffTable } from "@/components/staff-admin/staff-table";
import { InviteForm } from "@/components/staff-admin/invite-form";

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
      <div className="mx-auto max-w-[48rem] px-5 pb-20">
        <header className="flex items-baseline justify-between pt-9 pb-5">
          <div>
            <h1 className="text-[1.5rem] font-semibold tracking-tight">Staff</h1>
            <p className="mt-1 text-[13px] text-ink-muted">
              {active} active
            </p>
          </div>
        </header>

        <div className="mb-4">
          <InviteForm departments={departments} canInviteOwner={me.role === "owner"} />
        </div>

        {/* Somebody invited who has never signed in is a gap a manager would
            otherwise not see — they believe that person is covered. */}
        {pending.length > 0 && (
          <div className="mb-4 rounded-card border border-line bg-surface-raised px-4 py-3">
            <p className="text-[13px] font-medium">Invited, not signed in yet</p>
            <ul className="mt-1.5 space-y-1">
              {pending.map((p) => (
                <li key={p.id} className="text-[13px] text-ink-muted">
                  {p.full_name} · {p.email} · {p.role}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[12px] text-ink-subtle">
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
