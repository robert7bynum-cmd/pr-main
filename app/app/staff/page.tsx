import { redirect } from "next/navigation";
import { getMe } from "@/lib/queue/actions-db";
import { getStaffPage } from "@/lib/staff/queries";
import { StaffTable } from "@/components/staff-admin/staff-table";
import { InviteForm } from "@/components/staff-admin/invite-form";
import { PendingInvites } from "@/components/staff-admin/pending-invites";

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
        {pending.length > 0 && <PendingInvites invites={pending} />}

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
