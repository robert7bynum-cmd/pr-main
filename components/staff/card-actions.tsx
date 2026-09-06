"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  acknowledgeAction,
  resolveAction,
  scheduleAction,
  assignAction,
  rerouteAction,
  closeAction,
  startAction,
} from "@/app/actions/report-actions";
import type { Department, Teammate } from "@/lib/queue/reports";
import { CLOSE_REASONS, type CloseReason } from "@/lib/queue/close-reasons";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";

/**
 * Actions on a report card.
 *
 * Claiming is one tap and never asks for typing — that rule is what keeps the
 * app faster than a radio call. Only Resolve asks for anything, and its
 * member-facing message is a deliberate choice from a short list rather than
 * free text by default.
 *
 * The three under "More" are the ones that used to exist only as SQL: start
 * work, re-route, and close with nothing done. They live behind a sheet, not
 * in the row, because the row is for the common case and a fourth button
 * across a 375px card makes every button small.
 */

export function CardActions({
  reportId,
  claimed,
  status,
  departmentKey,
  team,
  departments,
  meId,
  meKind,
}: {
  reportId: string;
  claimed: boolean;
  status: string;
  /** Where the report is now; disabled in the re-route picker. */
  departmentKey: string | null;
  team: Teammate[];
  departments: Department[];
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
  const router = useRouter();
  const station = meKind === "station";
  const [pending, start] = useTransition();
  const [note, setNote] = useState("");
  const [mode, setMode] = useState<"idle" | "resolve" | "schedule" | "assign">("idle");
  const [date, setDate] = useState("");
  const [assignee, setAssignee] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [more, setMore] = useState(false);
  const [dept, setDept] = useState("");
  const [reason, setReason] = useState<CloseReason | "">("");
  const [moreError, setMoreError] = useState<string | null>(null);

  const run = (fn: () => Promise<{ ok: boolean; message?: string }>) =>
    start(async () => {
      setError(null);
      const res = await fn();
      if (!res.ok) setError(res.message ?? "Something went wrong");
      else {
        setMode("idle");
        // The queue is revalidated by the action; the report page this same
        // component sits on is re-read here so it never shows a stale status.
        router.refresh();
      }
    });

  const runMore = (fn: () => Promise<{ ok: boolean; message?: string }>) =>
    start(async () => {
      setMoreError(null);
      const res = await fn();
      if (!res.ok) setMoreError(res.message ?? "Something went wrong");
      else {
        setMore(false);
        setDept("");
        setReason("");
        router.refresh();
      }
    });

  const pill = (active: boolean, disabled = false) =>
    `rounded-pill border px-3.5 py-2 text-[14px] transition ${
      disabled
        ? "cursor-default border-line bg-surface-sunken text-ink-subtle"
        : active
          ? "border-accent-border bg-accent-surface font-medium text-ink"
          : "border-line bg-surface text-ink-secondary hover:border-line-strong"
    }`;

  const moreSheet = (
    <Sheet open={more} onOpenChange={(o) => { setMore(o); if (!o) setMoreError(null); }}>
      <SheetContent
        side="bottom"
        className="max-h-[88dvh] overflow-y-auto rounded-t-card border-line bg-surface-raised px-5 pb-8 pt-1 text-ink"
      >
        <SheetHeader className="px-0">
          <SheetTitle className="font-display text-[1.4rem] tracking-tight text-ink">
            More
          </SheetTitle>
          <SheetDescription className="text-[13px] text-ink-muted">
            Everything here is written to the report&apos;s history.
          </SheetDescription>
        </SheetHeader>

        {moreError && <p className="text-[13px] text-urgent">{moreError}</p>}

        {status !== "in_progress" && (
          <section className="border-t border-line pt-4">
            <p className="text-[13px] font-medium text-ink-secondary">Start work</p>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
              Marks it in progress, so the team can see it is being handled now.
            </p>
            <button
              disabled={pending}
              onClick={() => runMore(() => startAction(reportId))}
              className="mt-3 w-full rounded-control border border-line bg-surface px-4 py-3.5 text-[15px] font-medium text-ink-secondary transition hover:border-line-strong disabled:opacity-40"
            >
              {pending ? "…" : "I'm on it now"}
            </button>
          </section>
        )}

        <section className="border-t border-line pt-4">
          <p className="text-[13px] font-medium text-ink-secondary">Re-route</p>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
            Wrong team? Send it to the right one. They are paged straight away and
            any claim on it is dropped.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {departments.map((d) => {
              const current = d.key === departmentKey;
              return (
                <button
                  key={d.id}
                  type="button"
                  disabled={current}
                  aria-pressed={dept === d.id}
                  onClick={() => setDept(d.id)}
                  className={pill(dept === d.id, current)}
                >
                  {d.name}
                  {current && <span className="ml-1.5 text-[11px]">now</span>}
                </button>
              );
            })}
          </div>
          <button
            disabled={pending || !dept}
            onClick={() => runMore(() => rerouteAction(reportId, dept))}
            className="mt-3 w-full rounded-control bg-accent-strong px-4 py-3.5 text-[15px] font-medium text-ink-on-accent shadow-card transition disabled:opacity-40 disabled:shadow-none"
          >
            {pending
              ? "Sending…"
              : dept
                ? `Send to ${departments.find((d) => d.id === dept)?.name ?? "them"}`
                : "Send it on"}
          </button>
        </section>

        <section className="border-t border-line pt-4">
          <p className="text-[13px] font-medium text-ink-secondary">Close without action</p>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
            Nothing to fix. It leaves the queue and stays out of the response times.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {(Object.keys(CLOSE_REASONS) as CloseReason[]).map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={reason === r}
                onClick={() => setReason(r)}
                className={pill(reason === r)}
              >
                {CLOSE_REASONS[r]}
              </button>
            ))}
          </div>
          <button
            disabled={pending || !reason}
            onClick={() => runMore(() => closeAction(reportId, reason))}
            className="mt-3 w-full rounded-control border border-line bg-surface px-4 py-3.5 text-[15px] font-medium text-ink-secondary transition hover:border-line-strong disabled:opacity-40"
          >
            {pending ? "Closing…" : "Close it"}
          </button>
        </section>
      </SheetContent>
    </Sheet>
  );

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
        <Select
          value={assignee}
          onValueChange={(v) => setAssignee(v ?? "")}
          // Same reason as the filing form: the trigger otherwise shows the id.
          items={sorted.map((t) => ({ value: t.id, label: t.full_name }))}
        >
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
          <button
            onClick={() => setMore(true)}
            aria-haspopup="dialog"
            className="flex-1 rounded-control border border-line bg-surface-raised px-4 py-3.5 text-[15px] text-ink-secondary transition hover:border-line-strong"
          >
            More
          </button>
        </div>
      </div>
      {moreSheet}
    </div>
  );
}
