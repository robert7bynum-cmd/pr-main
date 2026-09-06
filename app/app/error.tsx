"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * A staff action that did not go through.
 *
 * The usual cause is mundane: a colleague closed the report first, so the
 * server function said "report not found" and the action threw. Without this
 * file that surfaced as Next's default error page — a groundskeeper reading a
 * stack trace. The message never includes error.message, which can carry SQL
 * text; it goes to console.error so it reaches the Vercel logs instead.
 */
export default function StaffError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("staff surface error", error.digest ?? "", error);
  }, [error]);

  return (
    <main className="app-ground flex min-h-dvh items-center justify-center px-6 py-12">
      <div className="w-full max-w-[25rem] rounded-card border border-line bg-surface-raised px-7 py-9 shadow-pop">
        <h1 className="font-display text-[1.9rem] leading-tight tracking-tight">
          That didn&apos;t go through
        </h1>
        <div className="mt-4 h-0.5 w-8 rounded-pill bg-accent" />
        <p className="mt-5 text-[15px] leading-relaxed text-ink-secondary">
          The report may have been closed by someone else while you had it
          open, or the connection dropped.
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
            href="/app"
            className="text-[15px] text-ink-muted underline-offset-4 hover:text-ink-secondary hover:underline"
          >
            Back to open reports
          </Link>
        </div>
      </div>
    </main>
  );
}
