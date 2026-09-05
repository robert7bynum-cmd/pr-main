"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "@/app/actions/auth";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

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
        className="w-full rounded-control border border-line bg-surface-raised px-4 py-4
                   text-[16px] shadow-inset outline-none placeholder:text-ink-subtle
                   focus:border-accent-border focus:ring-4 focus:ring-accent-surface"
      />
      <input
        type="password"
        required
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password"
        className="w-full rounded-control border border-line bg-surface-raised px-4 py-4
                   text-[16px] shadow-inset outline-none placeholder:text-ink-subtle
                   focus:border-accent-border focus:ring-4 focus:ring-accent-surface"
      />
      {error && <p className="text-[13px] text-urgent">{error}</p>}
      <button
        disabled={pending || !email || !password}
        className="w-full rounded-control bg-accent-strong px-4 py-4 text-[16px] font-medium
                   text-ink-on-accent shadow-card transition disabled:opacity-40 disabled:shadow-none"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
      <p className="pt-2 text-center text-[12px] leading-relaxed text-ink-muted">
        Your club creates your account. Forgotten your password? Ask your manager
        to reset it.
      </p>
    </form>
  );
}
