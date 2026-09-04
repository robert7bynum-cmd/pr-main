"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (sent) {
    return (
      <div className="rounded-xl border border-black/10 bg-white px-5 py-6 text-center">
        <p className="text-[15px] font-medium">Check your email</p>
        <p className="mt-2 text-[14px] leading-relaxed text-black/55">
          We sent a sign-in link to <span className="text-black/80">{email}</span>.
          Open it on this device.
        </p>
      </div>
    );
  }

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const supabase = createClient();
        const { error } = await supabase.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
        });
        setBusy(false);
        if (error) setError(error.message);
        else setSent(true);
      }}
      className="space-y-3"
    >
      <input
        type="email"
        required
        autoFocus
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@club.com"
        className="w-full rounded-xl border border-black/15 bg-white px-4 py-3.5 text-[16px]
                   outline-none focus:border-black/35"
      />
      {error && <p className="text-[13px] text-red-600">{error}</p>}
      <button
        disabled={busy || !email}
        className="w-full rounded-xl bg-black px-4 py-3.5 text-[16px] font-medium text-white
                   disabled:opacity-40"
      >
        {busy ? "Sending…" : "Send me a link"}
      </button>
    </form>
  );
}
