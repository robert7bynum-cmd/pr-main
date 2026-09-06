"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { signIn, requestPasswordReset } from "@/app/actions/auth";

const field =
  "w-full rounded-control border border-line bg-surface-raised px-4 py-4 " +
  "text-[16px] shadow-inset outline-none placeholder:text-ink-subtle " +
  "focus:border-accent-border focus:ring-4 focus:ring-accent-surface";

const primary =
  "w-full rounded-control bg-accent-strong px-4 py-4 text-[16px] font-medium " +
  "text-ink-on-accent shadow-card transition disabled:opacity-40 disabled:shadow-none";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // "Forgot your password?" swaps the form for one field. The reply is the
  // same whether or not the address is on staff, so this page cannot be used
  // to find out who works here.
  const [forgot, setForgot] = useState(false);
  const [sent, setSent] = useState<{ ok: boolean; message: string } | null>(null);

  if (forgot) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setSent(null);
          start(async () => {
            setSent(await requestPasswordReset(email));
          });
        }}
        className="space-y-3.5"
      >
        <p className="text-[14px] leading-relaxed text-ink-secondary">
          Enter the email your club uses for you and we&apos;ll send a link that
          signs you in and lets you choose a new password.
        </p>
        <input
          type="email"
          required
          autoFocus
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@club.com"
          className={field}
        />
        {sent && (
          <p
            className={`text-[13px] leading-relaxed ${sent.ok ? "text-ink-secondary" : "text-urgent"}`}
            role="status"
          >
            {sent.message}
          </p>
        )}
        <button disabled={pending || !email} className={primary}>
          {pending ? "Sending…" : "Send me a link"}
        </button>
        <button
          type="button"
          onClick={() => { setForgot(false); setSent(null); }}
          className="w-full pt-2 text-center text-[13px] text-ink-muted underline-offset-4 hover:underline"
        >
          Back to sign in
        </button>
      </form>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const res = await signIn(email, password);
          if (!res.ok) setError(res.error ?? "Sign-in failed");
          else router.push(res.mustChangePassword ? "/account/password" : "/app");
        });
      }}
      className="space-y-3.5"
    >
      <input
        type="email"
        required
        autoFocus
        autoComplete="username"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@club.com"
        className={field}
      />
      <input
        type="password"
        required
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password"
        className={field}
      />
      {error && <p className="text-[13px] text-urgent">{error}</p>}
      <button disabled={pending || !email || !password} className={primary}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
      <div className="pt-2 text-center text-[12px] leading-relaxed text-ink-muted">
        <button
          type="button"
          onClick={() => { setForgot(true); setError(null); }}
          className="text-[13px] text-ink-secondary underline underline-offset-4"
        >
          Forgot your password?
        </button>
        <p className="mt-2">Your club creates your account.</p>
      </div>
    </form>
  );
}
