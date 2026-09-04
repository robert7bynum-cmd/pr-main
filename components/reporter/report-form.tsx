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
export function ReportForm({ ctx, token }: { ctx: ScanContext; token: string }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [showOptional, setShowOptional] = useState(false);
  const [body, setBody] = useState("");

  if (result?.ok) {
    return (
      <div className="text-center py-10">
        <div
          className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-full bg-accent"
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M20 6L9 17l-5-5" stroke="#fff" strokeWidth="2.5"
              strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h2 className="text-xl font-medium tracking-tight">Thank you — we&apos;re on it.</h2>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-secondary">
          Our team has been notified about {ctx.locationName.toLowerCase()}.
          Someone is looking at it now.
        </p>
        {/* The tracking link is the member's only way back to this report —
            no account, nothing to remember. It is also where the club's reply
            appears once staff resolve it. */}
        {result.trackingToken && result.trackingToken !== "dev-preview" && (
          <a
            href={`/s/${result.trackingToken}`}
            className="mt-7 inline-block rounded-xl border border-line px-5 py-3
                       text-[15px] font-medium text-ink-secondary"
          >
            Check on this later
          </a>
        )}

        <p className="mt-8 text-xs uppercase tracking-[0.14em] text-ink-subtle">
          {ctx.courseName}
        </p>
      </div>
    );
  }

  return (
    <form
      action={(fd) => {
        fd.set("token", token);
        startTransition(async () => setResult(await submitReport(fd)));
      }}
      className="space-y-5"
    >
      <div>
        <label htmlFor="body" className="block text-sm font-medium text-ink">
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
          className="mt-2 w-full resize-none rounded-xl border border-line bg-surface-raised
                     px-4 py-3.5 text-[17px] leading-relaxed outline-none
                     placeholder:text-ink-subtle
                     focus:border-line-strong focus:ring-4 focus:ring-[color-mix(in_srgb,var(--ink)_5%,transparent)]"
        />
      </div>

      {!showOptional ? (
        <button
          type="button"
          onClick={() => setShowOptional(true)}
          className="text-sm text-ink-muted underline underline-offset-4 hover:text-ink-secondary"
        >
          Add your name or number (optional)
        </button>
      ) : (
        <div className="space-y-3 rounded-xl bg-surface-sunken p-4">
          <p className="text-xs text-ink-muted">
            Only used if the team needs to follow up on this report.
          </p>
          <input name="name" placeholder="Name" autoComplete="name"
            className="w-full rounded-lg border border-line px-3.5 py-2.5 text-[16px]
                       outline-none focus:border-line-strong" />
          <input name="memberNo" placeholder="Member number"
            className="w-full rounded-lg border border-line px-3.5 py-2.5 text-[16px]
                       outline-none focus:border-line-strong" />
          <input name="phone" type="tel" placeholder="Mobile number" autoComplete="tel"
            className="w-full rounded-lg border border-line px-3.5 py-2.5 text-[16px]
                       outline-none focus:border-line-strong" />
          <label className="flex items-start gap-2.5 pt-1 text-xs leading-relaxed text-ink-muted">
            <input type="checkbox" name="smsOptIn" className="mt-0.5 h-4 w-4 accent-[var(--ink)]" />
            <span>
              Text me when this is resolved. Message and data rates may apply;
              reply STOP to opt out.
            </span>
          </label>
        </div>
      )}

      {result?.error && (
        <p className="rounded-lg bg-urgent-surface px-4 py-3 text-sm text-urgent">{result.error}</p>
      )}

      <button
        type="submit"
        disabled={pending || body.trim().length < 3}
        className="w-full rounded-xl bg-accent px-6 py-4 text-[17px] font-medium
                   text-ink-on-accent transition disabled:cursor-not-allowed disabled:opacity-35"
      >
        {pending ? "Sending…" : "Send to the club"}
      </button>

      <p className="text-center text-xs text-ink-subtle">
        No app, no account. Goes straight to the team on duty.
      </p>
    </form>
  );
}
