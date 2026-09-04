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
          className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-full"
          style={{ backgroundColor: ctx.branding.primary }}
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M20 6L9 17l-5-5" stroke="#fff" strokeWidth="2.5"
              strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h2 className="text-xl font-medium tracking-tight">Thank you — we&apos;re on it.</h2>
        <p className="mt-3 text-[15px] leading-relaxed text-black/60">
          Our team has been notified about {ctx.locationName.toLowerCase()}.
          Someone is looking at it now.
        </p>
        <p className="mt-8 text-xs uppercase tracking-[0.14em] text-black/35">
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
        <label htmlFor="body" className="block text-sm font-medium text-black/80">
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
          className="mt-2 w-full resize-none rounded-xl border border-black/15 bg-white
                     px-4 py-3.5 text-[17px] leading-relaxed outline-none
                     placeholder:text-black/30
                     focus:border-black/30 focus:ring-4 focus:ring-black/5"
        />
      </div>

      {!showOptional ? (
        <button
          type="button"
          onClick={() => setShowOptional(true)}
          className="text-sm text-black/45 underline underline-offset-4 hover:text-black/70"
        >
          Add your name or number (optional)
        </button>
      ) : (
        <div className="space-y-3 rounded-xl bg-black/[0.025] p-4">
          <p className="text-xs text-black/50">
            Only used if the team needs to follow up on this report.
          </p>
          <input name="name" placeholder="Name" autoComplete="name"
            className="w-full rounded-lg border border-black/12 px-3.5 py-2.5 text-[16px]
                       outline-none focus:border-black/30" />
          <input name="memberNo" placeholder="Member number"
            className="w-full rounded-lg border border-black/12 px-3.5 py-2.5 text-[16px]
                       outline-none focus:border-black/30" />
          <input name="phone" type="tel" placeholder="Mobile number" autoComplete="tel"
            className="w-full rounded-lg border border-black/12 px-3.5 py-2.5 text-[16px]
                       outline-none focus:border-black/30" />
          <label className="flex items-start gap-2.5 pt-1 text-xs leading-relaxed text-black/55">
            <input type="checkbox" name="smsOptIn" className="mt-0.5 h-4 w-4 accent-black" />
            <span>
              Text me when this is resolved. Message and data rates may apply;
              reply STOP to opt out.
            </span>
          </label>
        </div>
      )}

      {result?.error && (
        <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{result.error}</p>
      )}

      <button
        type="submit"
        disabled={pending || body.trim().length < 3}
        className="w-full rounded-xl px-6 py-4 text-[17px] font-medium text-black
                   transition disabled:cursor-not-allowed disabled:opacity-35"
        style={{ backgroundColor: ctx.branding.primary }}
      >
        {pending ? "Sending…" : "Send to the club"}
      </button>

      <p className="text-center text-xs text-black/35">
        No app, no account. Goes straight to the team on duty.
      </p>
    </form>
  );
}
