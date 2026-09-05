"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { claimAfterEmailLink } from "@/app/actions/auth";

/**
 * Where an emailed link lands.
 *
 * Supabase verifies the one-time token and redirects here with the session in
 * the URL fragment — the part after '#', which a server never receives. So this
 * has to be a client page: the browser client reads the fragment, stores the
 * session in cookies the server can see, and only then can the server link the
 * session to the profile the manager created and send the person on.
 *
 * `next` is confined to a path on this site. An open redirect on an auth
 * callback is the classic phishing hop, and there is no reason for it here.
 */
export default function AuthCallbackPage() {
  const router = useRouter();
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    // Read from the browser rather than useSearchParams: this page is only ever
    // meaningful in a browser holding a fragment, and useSearchParams would
    // force a Suspense boundary for a value that is never server-rendered.
    const raw = new URLSearchParams(window.location.search).get("next") ?? "/account/password";
    const next = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/app";
    const supabase = createClient();
    let done = false;

    const proceed = async () => {
      if (done) return;
      done = true;
      const res = await claimAfterEmailLink();
      if (!res.ok) { setProblem(res.error ?? "Could not sign you in."); return; }
      router.replace(res.mustChangePassword ? next : "/app");
    };

    // Supabase puts the session in the URL fragment. The browser client is
    // configured for the PKCE flow and does not read an implicit-grant
    // fragment by itself — the first version of this page waited for a
    // SIGNED_IN event that never came, hash still in the address bar, nothing
    // in cookies. So the fragment is read here, explicitly, and handed to
    // setSession, which is what writes the cookies the server can see.
    const frag = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const access_token = frag.get("access_token");
    const refresh_token = frag.get("refresh_token");
    const linkError = frag.get("error_description");

    if (linkError) { setProblem(decodeURIComponent(linkError.replace(/\+/g, " "))); return; }
    if (!access_token || !refresh_token) {
      setProblem("That link didn't work. It may have expired — ask your manager to send another.");
      return;
    }

    void supabase.auth.setSession({ access_token, refresh_token }).then(({ error }) => {
      if (error) { setProblem(error.message); return; }
      // The tokens have done their job; do not leave them in the history.
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      void proceed();
    });
  }, [router]);

  return (
    <main className="app-ground flex min-h-dvh items-center justify-center px-6 py-12">
      <div className="w-full max-w-[25rem] rounded-card border border-line bg-surface-raised px-7 py-9 shadow-pop">
        <p className="text-[11px] uppercase tracking-[0.2em] text-ink-muted">ProResponse</p>
        <h1 className="mt-4 font-display text-[1.9rem] leading-tight tracking-tight">
          {problem ? "This link didn't work" : "Signing you in…"}
        </h1>
        <div className="mt-4 h-0.5 w-8 rounded-pill bg-accent" />
        <p className="mt-5 text-[15px] leading-relaxed text-ink-secondary">
          {problem ?? "One moment."}
        </p>
        {problem && (
          <a href="/login" className="mt-6 inline-block rounded-control border border-line bg-surface px-4 py-3 text-[14px] text-ink-secondary">
            Go to sign in
          </a>
        )}
      </div>
    </main>
  );
}
