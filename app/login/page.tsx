import { LoginForm } from "@/components/staff/login-form";
import { DemoSignIn } from "@/components/staff/demo-signin";
import { demoEnabled } from "@/app/actions/demo-signin";

export const metadata = { title: "Sign in — ProResponse" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const showDemo = await demoEnabled();

  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface-app px-6">
      <div className="w-full max-w-[24rem]">
        <p className="text-[11px] uppercase tracking-[0.2em] text-ink-muted">ProResponse</p>
        <h1 className="mt-4 text-[1.7rem] font-semibold leading-tight tracking-tight">
          Sign in
        </h1>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-muted">
          Enter the email your club uses for you. We&apos;ll send a link — no password
          to remember.
        </p>
        {error && (
          <p className="mt-4 rounded-lg bg-urgent-surface px-4 py-3 text-[14px] text-urgent">
            That link didn&apos;t work. Request a new one below.
          </p>
        )}
        <div className="mt-6">
          <LoginForm />
        </div>
        {showDemo && <DemoSignIn />}
      </div>
    </main>
  );
}
