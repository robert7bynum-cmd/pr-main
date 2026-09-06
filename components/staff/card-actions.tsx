"use client";

import { useState, useTransition } from "react";
import {
  acknowledgeAction,
  resolveAction,
  scheduleAction,
  assignAction,
} from "@/app/actions/report-actions";
import type { Teammate } from "@/lib/queue/reports";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

/**
 * Actions on a report card.
 *
 * Claiming is one tap and never asks for typing — that rule is what keeps the
 * app faster than a radio call. Only Resolve asks for anything, and its
 * member-facing message is a deliberate choice from a short list rather than
 * free text by default.
 */

export function CardActions({
  reportId,
  claimed,
  team,
  meId,
  meKind,
}: {
  reportId: string;
  claimed: boolean;
  team: Teammate[];
  /** Excluded from the picker: handing a report to yourself is "I've got this". */
  meId: string;
  /**
   * 'station' for a shared counter login. A station never claims in its own
   * name — "Pro Shop Counter" handling a report answers "who?" with nobody —
   * so its one-tap action is to say who is taking it, which pages that person
   * and records the hand-over with the station as the actor.
   */
  meKind?: string;
}) {
  const station = meKind === "station";
  const [pending, start] = useTransition();
  const [note, setNote] = useState("");
  const [mode, setMode] = useState<"idle" | "resolve" | "schedule" | "assign">("idle");
  const [date, setDate] = useState("");
  const [assignee, setAssignee] = useState("");
  const [error, setError] = useState<string | null>(null);

  const run = (fn: () => Promise<{ ok: boolean; message?: string }>) =>
    start(async () => {
      setError(null);
      const res = await fn();
      if (!res.ok) setError(res.message ?? "Something went wrong");
      else setMode("idle");
    });

  if (mode === "resolve") {
    return (
      <div className="mt-5 space-y-4 border-t border-line pt-5">
        <div>
          <label className="text-[13px] font-medium text-ink-secondary">
            What did you do?
          </label>
          <textarea
            autoFocus
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Swapped the valve, tested twice"
            className="mt-2 w-full resize-none rounded-control border border-line bg-surface px-3.5 py-3
                       text-[16px] shadow-inset outline-none placeholder:text-ink-subtle
                       focus:border-accent-border focus:ring-4 focus:ring-accent-surface"
          />
          <p className="mt-1 text-[11px] text-ink-subtle">
            Internal record. Nothing is sent to the member.
          </p>
        </div>

        {error && <p className="text-[13px] text-urgent">{error}</p>}

        <div className="flex gap-2">
          <button
            disabled={pending}
            onClick={() => run(() => resolveAction(reportId, note))}
            className="flex-1 rounded-control bg-accent-strong px-4 py-3.5 text-[15px] font-medium text-ink-on-accent shadow-card transition disabled:opacity-40 disabled:shadow-none"
          >
            {pending ? "Saving…" : "Mark resolved"}
          </button>
          <button
            onClick={() => setMode("idle")}
            className="rounded-control border border-line bg-surface-raised px-4 py-3.5 text-[15px] text-ink-secondary transition hover:border-line-strong"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (mode === "schedule") {
    return (
      <div className="mt-5 space-y-4 border-t border-line pt-5">
        <label className="text-[13px] font-medium text-ink-secondary">
          When will this be handled?
        </label>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="w-full rounded-control border border-line bg-surface px-3.5 py-3 text-[16px] shadow-inset outline-none focus:border-accent-border"
        />
        {error && <p className="text-[13px] text-urgent">{error}</p>}
        <div className="flex gap-2">
          <button
            disabled={pending}
            onClick={() => run(() => scheduleAction(reportId, date))}
            className="flex-1 rounded-control bg-accent-strong px-4 py-3.5 text-[15px] font-medium text-ink-on-accent shadow-card transition disabled:opacity-40 disabled:shadow-none"
          >
            {pending ? "Saving…" : "Schedule"}
          </button>
          <button
            onClick={() => setMode("idle")}
            className="rounded-control border border-line bg-surface-raised px-4 py-3.5 text-[15px] text-ink-secondary transition hover:border-line-strong"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (mode === "assign") {
    const others = team.filter((t) => t.id !== meId);
    // On duty first, and said out loud. "Who is actually working right now" is
    // the question a supervisor is answering when they hand something over, and
    // a flat alphabetical list makes them guess at it.
    const sorted = [...others].sort(
      (a, b) => Number(b.on_duty) - Number(a.on_duty) || a.full_name.localeCompare(b.full_name),
    );
    return (
      <div className="mt-5 border-t border-line pt-4">
        {error && <p className="mb-2 text-[13px] text-urgent">{error}</p>}
        <p className="text-[13px] text-ink-secondary">{station ? "Who's taking this?" : "Hand this to"}</p>
        <Select value={assignee} onValueChange={(v) => setAssignee(v ?? "")}>
          <SelectTrigger className="mt-2 h-auto w-full px-4 py-3.5 text-[15px]">
            <SelectValue placeholder="Choose someone…" />
          </SelectTrigger>
          <SelectContent>
            {sorted.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                <span className="flex items-center gap-2">
                  {t.full_name}
                  {/* On duty said as a badge rather than a suffix in the text:
                      it is the thing being scanned for, not a footnote. */}
                  {t.on_duty && (
                    <Badge variant="department" size="sm">On duty</Badge>
                  )}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="mt-2 text-[12px] leading-relaxed text-ink-muted">
          They are told straight away, and the response clock starts again for them.
        </p>
        <div className="mt-3 flex gap-2">
          <button
            disabled={pending || !assignee}
            onClick={() => run(() => assignAction(reportId, assignee))}
            className="flex-1 rounded-control bg-accent-strong px-4 py-3.5 text-[15px] font-medium text-ink-on-accent shadow-card transition disabled:opacity-40 disabled:shadow-none"
          >
            {pending ? "Handing over…" : "Hand it over"}
          </button>
          <button
            onClick={() => { setMode("idle"); setAssignee(""); }}
            className="rounded-control border border-line bg-surface px-4 py-3.5 text-[15px] text-ink-secondary transition hover:border-line-strong"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-5 border-t border-line pt-4">
      {error && <p className="mb-2 text-[13px] text-urgent">{error}</p>}
      {/* Claiming gets its own full-width row rather than a third of one.
          Three buttons across a 375px card wrapped "I've got this" onto two
          lines, which made the one-tap action look like the fiddly one. */}
      <div className="space-y-2">
        {!claimed && (
          <button
            disabled={pending}
            onClick={() => (station ? setMode("assign") : run(() => acknowledgeAction(reportId)))}
            className="w-full rounded-control bg-accent-strong px-4 py-3.5 text-[15px] font-medium text-ink-on-accent shadow-card transition disabled:opacity-40 disabled:shadow-none"
          >
            {pending ? "…" : station ? "Who's taking this?" : "I've got this"}
          </button>
        )}
        <div className="flex gap-2">
          <button
            onClick={() => setMode("resolve")}
            className="flex-1 rounded-control border border-line bg-surface-raised px-4 py-3.5 text-[15px] font-medium text-ink-secondary transition hover:border-line-strong"
          >
            Resolve
          </button>
          <button
            onClick={() => setMode("schedule")}
            className="flex-1 rounded-control border border-line bg-surface-raised px-4 py-3.5 text-[15px] text-ink-secondary transition hover:border-line-strong"
          >
            Later
          </button>
          {team.length > 1 && !(station && !claimed) && (
            <button
              onClick={() => setMode("assign")}
              className="flex-1 rounded-control border border-line bg-surface-raised px-4 py-3.5 text-[15px] text-ink-secondary transition hover:border-line-strong"
            >
              Assign
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
