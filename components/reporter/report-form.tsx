"use client";

import { useState, useTransition } from "react";
import { submitReport, type SubmitResult } from "@/app/actions/submit-report";
import type { ScanContext } from "@/lib/scan/context";

/**
 * The member's entire experience: one field, one button.
 *
 * Everything optional stays collapsed behind a single disclosure, because the
 * design constraint is a member standing on a tee box with a group waiting.
 */
export function ReportForm({
  ctx,
  token,
  nonce,
}: {
  ctx: ScanContext;
  token: string;
  /** Null when the placard is flood-limited; submit reports the real reason. */
  nonce: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [showOptional, setShowOptional] = useState(false);
  const [body, setBody] = useState("");

  if (result?.ok) {
    return (
      <div className="rounded-card border border-line bg-surface-raised px-7 py-12 text-center shadow-card">
        <div className="mx-auto mb-7 flex h-16 w-16 items-center justify-center rounded-full bg-accent-strong text-ink-on-accent shadow-card">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2.5"
              strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h2 className="font-display text-[1.6rem] leading-tight tracking-tight">
          Thank you — we&apos;re on it.
        </h2>
        <p className="mt-4 text-[15px] leading-relaxed text-ink-secondary">
          Our team has been notified about {ctx.locationName.toLowerCase()}.
          Someone is looking at it now.
        </p>
        <p className="mt-9 text-xs uppercase tracking-[0.16em] text-ink-subtle">
          {ctx.courseName}
        </p>
      </div>
    );
  }

  return (
    <form
      action={(fd) => {
        fd.set("token", token);
        fd.set("nonce", nonce ?? "");
        startTransition(async () => setResult(await submitReport(fd)));
      }}
      className="space-y-6"
    >
      <div className="rounded-card border border-line bg-surface-raised p-5 shadow-card">
        <label htmlFor="body" className="block text-[14px] font-medium text-ink">
          What did you notice?
        </label>
        <textarea
          id="body"
          name="body"
          required
          autoFocus
          rows={4}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Tell us what's wrong — a sentence is plenty."
          className="mt-3 w-full resize-none rounded-control border border-line bg-surface
                     px-4 py-3.5 text-[17px] leading-relaxed shadow-inset outline-none
                     placeholder:text-ink-subtle
                     focus:border-accent-border focus:ring-4 focus:ring-accent-surface"
        />

        {!showOptional ? (
          <button
            type="button"
            onClick={() => setShowOptional(true)}
            className="mt-4 text-[14px] text-ink-muted underline underline-offset-4 hover:text-ink-secondary"
          >
            Add your name or number (optional)
          </button>
        ) : (
          <div className="mt-4 space-y-3 rounded-control border border-line bg-surface-sunken p-4">
            <p className="text-[12px] leading-relaxed text-ink-muted">
              Only used if the team needs to ask you something about this report.
            </p>
            <input name="name" placeholder="Name" autoComplete="name"
              className="w-full rounded-control border border-line bg-surface px-3.5 py-3 text-[16px]
                         outline-none placeholder:text-ink-subtle focus:border-accent-border" />
            <input name="memberNo" placeholder="Member number"
              className="w-full rounded-control border border-line bg-surface px-3.5 py-3 text-[16px]
                         outline-none placeholder:text-ink-subtle focus:border-accent-border" />
            <input name="phone" type="tel" placeholder="Mobile number" autoComplete="tel"
              className="w-full rounded-control border border-line bg-surface px-3.5 py-3 text-[16px]
                         outline-none placeholder:text-ink-subtle focus:border-accent-border" />
            <input name="email" type="email" placeholder="Email" autoComplete="email"
              className="w-full rounded-control border border-line bg-surface px-3.5 py-3 text-[16px]
                         outline-none placeholder:text-ink-subtle focus:border-accent-border" />
          </div>
        )}
      </div>

      {result?.error && (
        <p className="rounded-control border border-urgent-border bg-urgent-surface px-4 py-3.5 text-[14px] text-urgent">
          {result.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending || body.trim().length < 3}
        className="w-full rounded-control bg-accent-strong px-6 py-4.5 text-[17px] font-medium
                   text-ink-on-accent shadow-card transition
                   disabled:cursor-not-allowed disabled:opacity-35 disabled:shadow-none"
      >
        {pending ? "Sending…" : "Send to the club"}
      </button>

      <p className="text-center text-[12px] leading-relaxed text-ink-subtle">
        No app, no account. Goes straight to the team on duty.
      </p>
    </form>
  );
}
