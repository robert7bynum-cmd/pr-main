"use client";

import { useTransition, useState } from "react";
import { demoSignIn } from "@/app/actions/demo-signin";

const PERSONAS = [
  { email: "gm@beaconhilldemo.com",   name: "Katherine Ellis", role: "General Manager — sees every department" },
  { email: "supt@beaconhilldemo.com", name: "Efrain Reyes",    role: "Superintendent — course maintenance" },
  { email: "shop@beaconhilldemo.com", name: "Danny Whitfield", role: "Pro shop" },
];

export function DemoSignIn() {
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="mt-8 border-t border-black/10 pt-6">
      <p className="text-[11px] uppercase tracking-[0.16em] text-black/40">Demo</p>
      <p className="mt-2 text-[13px] leading-relaxed text-black/50">
        Sign in as a Beacon Hill staff member. No email needed.
      </p>
      <div className="mt-3 space-y-2">
        {PERSONAS.map((p) => (
          <button
            key={p.email}
            disabled={pending}
            onClick={() => {
              setBusy(p.email);
              setError(null);
              start(async () => {
                try {
                  await demoSignIn(p.email);
                } catch (e) {
                  const msg = e instanceof Error ? e.message : "sign-in failed";
                  // redirect() throws by design; only surface real failures.
                  if (!msg.includes("NEXT_REDIRECT")) setError(msg);
                }
              });
            }}
            className="w-full rounded-xl border border-black/12 bg-white px-4 py-3 text-left
                       transition hover:border-black/30 disabled:opacity-50"
          >
            <span className="block text-[15px] font-medium">
              {busy === p.email && pending ? "Signing in…" : p.name}
            </span>
            <span className="block text-[12px] text-black/50">{p.role}</span>
          </button>
        ))}
      </div>
      {error && <p className="mt-3 text-[13px] text-red-600">{error}</p>}
    </div>
  );
}
