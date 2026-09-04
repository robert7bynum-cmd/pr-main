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
    <main className="flex min-h-dvh items-center justify-center bg-surface-app px-6">
      <div className="w-full max-w-[24rem]">
        <p className="text-[11px] uppercase tracking-[0.2em] text-ink-muted">ProResponse</p>
        <h1 className="mt-4 text-[1.7rem] font-semibold leading-tight tracking-tight">
          Choose a password
        </h1>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-secondary">
          Your club set a temporary one. Pick your own — you&apos;ll use it every shift.
        </p>
        <div className="mt-6">
          <ChangePasswordForm />
        </div>
      </div>
    </main>
  );
}
