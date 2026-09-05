import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ChangePasswordForm } from "@/components/staff/change-password-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Set a password — ProResponse" };

export default async function PasswordPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login");

  return (
    <main className="app-ground flex min-h-dvh items-center justify-center px-6 py-12">
      <div className="w-full max-w-[25rem] rounded-card border border-line bg-surface-raised px-7 py-9 shadow-pop">
        <p className="text-[11px] uppercase tracking-[0.2em] text-ink-muted">ProResponse</p>
        <h1 className="mt-4 font-display text-[1.9rem] leading-tight tracking-tight">
          Choose a password
        </h1>
        <div className="mt-4 h-0.5 w-8 rounded-pill bg-accent" />
        <p className="mt-5 text-[15px] leading-relaxed text-ink-secondary">
          You came in through an emailed link. Pick a password — you&apos;ll use it every shift.
        </p>
        <div className="mt-6">
          <ChangePasswordForm />
        </div>
      </div>
    </main>
  );
}
