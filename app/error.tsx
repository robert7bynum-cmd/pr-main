"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * Fallback for the member and sign-in surfaces. The staff app has its own
 * under app/app. As there, error.message is logged and never shown: a member
 * scanning a placard should see a sentence, not an exception.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("public surface error", error.digest ?? "", error);
  }, [error]);

  return (
    <main className="app-ground flex min-h-dvh items-center justify-center px-6 py-12">
      <div className="w-full max-w-[25rem] rounded-card border border-line bg-surface-raised px-7 py-9 shadow-pop">
        <h1 className="font-display text-[1.9rem] leading-tight tracking-tight">
          Something went wrong
        </h1>
        <div className="mt-4 h-0.5 w-8 rounded-pill bg-accent" />
        <p className="mt-5 text-[15px] leading-relaxed text-ink-secondary">
          The page could not be loaded. Please try again.
        </p>
        <div className="mt-7 flex flex-wrap items-center gap-4">
          <button
            type="button"
            onClick={() => reset()}
            className="rounded-control bg-accent-strong px-4 py-3.5 text-[15px] font-medium text-ink-on-accent shadow-card"
          >
            Try again
          </button>
          <Link
            href="/"
            className="text-[15px] text-ink-muted underline-offset-4 hover:text-ink-secondary hover:underline"
          >
            Back to the start
          </Link>
        </div>
      </div>
    </main>
  );
}
