"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { redeemInvite } from "@/app/actions/staff";
import { claimAfterEmailLink } from "@/app/actions/auth";

/**
 * The deliberate press that spends the invitation.
 *
 * The server hands back a one-time Supabase token, which is exchanged here for
 * a session and then gone. It never travels in a URL and never reaches a
 * mailbox, so neither of the two things that killed the old links — a second
 * link being generated, or a preview fetch spending it — can reach it.
 */
export function JoinButton({ token }: { token: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <div>
      <button
        disabled={pending}
        onClick={() =>
          start(async () => {
            setProblem(null);
            const res = await redeemInvite(token);
            if (!res.ok || !res.tokenHash) {
              setProblem(res.message ?? "Could not sign you in.");
              return;
            }
            const supabase = createClient();
            const { error } = await supabase.auth.verifyOtp({
              token_hash: res.tokenHash,
              type: "recovery",
            });
            if (error) { setProblem(error.message); return; }

            // Links the session to the profile their manager created. Without
            // this they are signed in and the club knows nothing about them.
            await claimAfterEmailLink();
            router.replace("/account/password");
          })
        }
        className="w-full rounded-control bg-accent-strong px-4 py-3.5 text-[15px] font-medium text-ink-on-accent shadow-card transition disabled:opacity-40"
      >
        {pending ? "Setting up…" : "Set up my account"}
      </button>
      {problem && <p className="mt-3 text-[13px] text-urgent">{problem}</p>}
    </div>
  );
}
