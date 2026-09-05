"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { changePassword } from "@/app/actions/auth";

export function ChangePasswordForm() {
  const router = useRouter();
  const [pw, setPw] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const res = await changePassword(pw);
          if (!res.ok) setError(res.error ?? "Could not set password");
          // Straight to the queue skipped the only good moment to ask about
          // alerts. A browser asks for notification permission once and
          // remembers the answer, so the ask has to land while someone is being
          // set up and paying attention — not from a card competing with a
          // fairway full of work. The step itself is skippable; the timing is
          // the part that matters.
          else router.push("/account/notifications");
        });
      }}
      className="space-y-3.5"
    >
      <input
        type="password"
        required
        autoFocus
        autoComplete="new-password"
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        placeholder="New password"
        className="w-full rounded-control border border-line bg-surface-raised px-4 py-4
                   text-[16px] shadow-inset outline-none placeholder:text-ink-subtle
                   focus:border-accent-border focus:ring-4 focus:ring-accent-surface"
      />
      {error && <p className="text-[13px] text-urgent">{error}</p>}
      <button
        disabled={pending || pw.length < 10}
        className="w-full rounded-control bg-accent-strong px-4 py-4 text-[16px] font-medium
                   text-ink-on-accent shadow-card transition disabled:opacity-40 disabled:shadow-none"
      >
        {pending ? "Saving…" : "Save and continue"}
      </button>
      <p className="pt-1 text-center text-[12px] text-ink-muted">At least 10 characters.</p>
    </form>
  );
}
