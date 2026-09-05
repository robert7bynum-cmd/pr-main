import { redirect } from "next/navigation";
import { getMe } from "@/lib/queue/actions-db";
import { createClient } from "@/lib/supabase/server";
import { AccountForm } from "@/components/staff/account-form";

/**
 * The person's own account.
 *
 * Everything a staff member could change about themselves lived on a manager's
 * screen: going on duty was only a badge on the roster, and there was no way to
 * correct your own name from your own phone. In a product about who is on duty,
 * clocking yourself in is the most-used action there is.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Your account — ProResponse" };

export default async function AccountPage() {
  const me = await getMe();
  if (!me) redirect("/login");

  const supabase = await createClient();
  const [{ data: auth }, { data: row }] = await Promise.all([
    supabase.auth.getUser(),
    supabase.from("profiles").select("full_name, phone").eq("id", me.profile_id).single(),
  ]);

  return (
    <main>
      <div className="mx-auto max-w-[34rem] px-4 pb-24 pt-8">
        <h1 className="font-display text-[1.6rem] leading-tight tracking-tight">Your account</h1>
        <div className="mt-3 h-0.5 w-8 rounded-pill bg-accent" />
        <p className="mt-4 text-[14px] leading-relaxed text-ink-secondary">
          {me.course_name} · <span className="capitalize">{me.role}</span>
          {auth.user?.email ? ` · ${auth.user.email}` : ""}
        </p>

        <div className="mt-7">
          <AccountForm
            fullName={row?.full_name ?? me.full_name}
            phone={row?.phone ?? ""}
            onDuty={me.on_duty}
          />
        </div>

        <div className="mt-6 rounded-card border border-line bg-surface-raised px-5 py-4 shadow-card">
          <p className="text-[14px] font-medium">Your sign-in</p>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">
            Your email address and role are set by the club. Ask a manager to change either.
          </p>
          <div className="mt-3.5 flex flex-wrap gap-2.5">
            <a href="/account/password"
              className="rounded-control border border-line bg-surface px-4 py-2.5 text-[13px] text-ink-secondary transition hover:border-line-strong">
              Change password
            </a>
            <a href="/account/notifications"
              className="rounded-control border border-line bg-surface px-4 py-2.5 text-[13px] text-ink-secondary transition hover:border-line-strong">
              Alerts on this device
            </a>
          </div>
        </div>
      </div>
    </main>
  );
}
