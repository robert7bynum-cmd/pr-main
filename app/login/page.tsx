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
  // Visible while one-click sign-in is live on a public deployment. A build
  // check alone is forgettable; a banner on the page people actually open is not.
  const demoOnProd = showDemo && process.env.VERCEL_ENV === "production";

  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface-app px-6">
      <div className="w-full max-w-[24rem]">
        <p className="text-[11px] uppercase tracking-[0.2em] text-ink-muted">ProResponse</p>
        <h1 className="mt-4 text-[1.7rem] font-semibold leading-tight tracking-tight">
          Sign in
        </h1>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-muted">
          Use the email and password your club set up for you.
        </p>
        {error && (
          <p className="mt-4 rounded-lg bg-urgent-surface px-4 py-3 text-[14px] text-urgent">
            Please sign in again.
          </p>
        )}
        <div className="mt-6">
          <LoginForm />
        </div>
        {demoOnProd && (
          <p className="mt-6 rounded-control border border-line bg-surface-sunken px-4 py-3
                        text-[12px] leading-relaxed text-ink-secondary">
            Demo mode: anyone with this link can sign in as staff. Fine for a
            demonstration, not for a club&apos;s real reports.
          </p>
        )}
        {showDemo && <DemoSignIn />}
      </div>
    </main>
  );
}
