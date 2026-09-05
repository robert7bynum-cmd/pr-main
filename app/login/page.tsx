import { LoginForm } from "@/components/staff/login-form";

export const metadata = { title: "Sign in — ProResponse" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <main className="app-ground flex min-h-dvh items-center justify-center px-6 py-12">
      <div className="w-full max-w-[25rem] rounded-card border border-line bg-surface-raised px-7 py-9 shadow-pop">
        <p className="text-[11px] uppercase tracking-[0.2em] text-ink-muted">ProResponse</p>
        <h1 className="mt-4 font-display text-[1.9rem] leading-tight tracking-tight">
          Sign in
        </h1>
        <div className="mt-4 h-0.5 w-8 rounded-pill bg-accent" />
        <p className="mt-5 text-[15px] leading-relaxed text-ink-secondary">
          Use the email and password your club set up for you.
        </p>
        {error && (
          <p className="mt-5 rounded-control border border-urgent-border bg-urgent-surface px-4 py-3.5 text-[14px] text-urgent">
            Please sign in again.
          </p>
        )}
        <div className="mt-6">
          <LoginForm />
        </div>
      </div>
    </main>
  );
}
