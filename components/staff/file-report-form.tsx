"use client";

import { useState, useTransition } from "react";
import { fileReport, type FileResult } from "@/app/actions/file-report";
import type { FilingLocation } from "@/lib/queue/reports";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

/**
 * Staff filing a report: where, what, and — only when relaying a call or a
 * counter conversation — who told them.
 *
 * Ten seconds is the budget. A pro shop with a member on the line cannot fill
 * in a form; they pick the hole, type a sentence and tap send. The phone
 * details stay behind a checkbox so the common case, a staff member reporting
 * what they saw themselves, never shows fields it does not need.
 */
const label = (l: FilingLocation) =>
  l.hole_number ? `Hole ${l.hole_number}` : l.name;

export function FileReportForm({ locations }: { locations: FilingLocation[] }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<FileResult | null>(null);
  const [locationId, setLocationId] = useState("");
  const [body, setBody] = useState("");
  const [byPhone, setByPhone] = useState(false);
  // Bumped on "File another" so the form remounts empty.
  const [round, setRound] = useState(0);

  const reset = () => {
    setResult(null);
    setLocationId("");
    setBody("");
    setByPhone(false);
    setRound((r) => r + 1);
  };

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
          Sent. The team has been notified.
        </h2>
        <p className="mt-4 text-[15px] leading-relaxed text-ink-secondary">
          It is in the queue and will stay on your screen whichever team it goes to.
        </p>
        <div className="mt-9 flex flex-col gap-3">
          <button
            type="button"
            onClick={reset}
            className="w-full rounded-control bg-accent-strong px-4 py-3.5 text-[15px] font-medium text-ink-on-accent shadow-card transition"
          >
            File another
          </button>
          <a
            href="/app"
            className="w-full rounded-control border border-line bg-surface-raised px-4 py-3.5 text-[15px] text-ink-secondary transition hover:border-line-strong"
          >
            Back to open reports
          </a>
        </div>
      </div>
    );
  }

  return (
    <form
      key={round}
      action={(fd) => {
        fd.set("locationId", locationId);
        startTransition(async () => setResult(await fileReport(fd)));
      }}
      className="space-y-6"
    >
      <div className="rounded-card border border-line bg-surface-raised p-5 shadow-card">
        <label className="block text-[14px] font-medium text-ink">Where is it?</label>
        <Select
          value={locationId}
          onValueChange={(v) => setLocationId(v ?? "")}
          // The trigger shows the chosen item's label only if the root knows
          // the labels; without this it showed the location's uuid.
          items={locations.map((l) => ({ value: l.id, label: label(l) }))}
        >
          <SelectTrigger className="mt-3 h-auto w-full px-4 py-3.5 text-[16px]">
            <SelectValue placeholder="Pick a hole or a place…" />
          </SelectTrigger>
          <SelectContent>
            {locations.map((l) => (
              <SelectItem key={l.id} value={l.id}>{label(l)}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <label htmlFor="body" className="mt-6 block text-[14px] font-medium text-ink">
          What&apos;s wrong?
        </label>
        <textarea
          id="body"
          name="body"
          required
          autoFocus
          rows={4}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="A sentence is plenty."
          className="mt-3 w-full resize-none rounded-control border border-line bg-surface
                     px-4 py-3.5 text-[16px] leading-relaxed shadow-inset outline-none
                     placeholder:text-ink-subtle
                     focus:border-accent-border focus:ring-4 focus:ring-accent-surface"
        />

        <label className="mt-5 flex items-center gap-3 text-[14px] text-ink-secondary">
          <input
            type="checkbox"
            name="byPhone"
            checked={byPhone}
            onChange={(e) => setByPhone(e.target.checked)}
            className="size-5 rounded-[4px] border-line accent-accent-strong"
          />
          Reported by phone or at the counter
        </label>

        {byPhone && (
          <div className="mt-4 space-y-3 rounded-control border border-line bg-surface-sunken p-4">
            <p className="text-[12px] leading-relaxed text-ink-muted">
              Who told you, if they said. Only used if the team needs to call them back.
            </p>
            <input name="name" placeholder="Their name" autoComplete="off"
              className="w-full rounded-control border border-line bg-surface px-3.5 py-3 text-[16px]
                         outline-none placeholder:text-ink-subtle focus:border-accent-border" />
            <input name="phone" type="tel" placeholder="Their number" autoComplete="off"
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
        disabled={pending || !locationId || body.trim().length < 3}
        className="w-full rounded-control bg-accent-strong px-6 py-4.5 text-[17px] font-medium
                   text-ink-on-accent shadow-card transition
                   disabled:cursor-not-allowed disabled:opacity-35 disabled:shadow-none"
      >
        {pending ? "Sending…" : "Send to the team"}
      </button>

      <p className="text-center text-[12px] leading-relaxed text-ink-subtle">
        Routed like a member&apos;s report. Filed in your name.
      </p>
    </form>
  );
}
