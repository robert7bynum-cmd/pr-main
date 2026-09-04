"use client";

import { useState, useTransition } from "react";
import {
  acknowledgeAction,
  resolveAction,
  scheduleAction,
} from "@/app/actions/report-actions";

/**
 * Actions on a report card.
 *
 * Claiming is one tap and never asks for typing — that rule is what keeps the
 * app faster than a radio call. Only Resolve asks for anything, and its
 * member-facing message is a deliberate choice from a short list rather than
 * free text by default.
 */

// Club-approved lines. Staff pick one rather than composing a member-facing
// message under time pressure, and the internal note stays internal.
const MEMBER_REPLIES = [
  "Repaired — thank you for letting us know.",
  "Our team took a look and everything is in good order.",
  "Scheduled with our maintenance team.",
  "Taken care of — we appreciate you flagging it.",
];

export function CardActions({
  reportId,
  claimed,
}: {
  reportId: string;
  claimed: boolean;
}) {
  const [pending, start] = useTransition();
  const [note, setNote] = useState("");
  const [reply, setReply] = useState<string | null>(null);
  const [mode, setMode] = useState<"idle" | "resolve" | "schedule">("idle");
  const [date, setDate] = useState("");
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
      <div className="mt-4 space-y-3 border-t border-line pt-4">
        <div>
          <label className="text-[13px] font-medium text-ink-secondary">
            What did you do? <span className="text-ink-subtle">(internal)</span>
          </label>
          <textarea
            autoFocus
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Swapped the valve, tested twice"
            className="mt-1.5 w-full resize-none rounded-lg border border-line px-3 py-2.5
                       text-[16px] outline-none focus:border-line-strong"
          />
          <p className="mt-1 text-[11px] text-ink-subtle">
            Only staff see this. The member sees the line you pick below.
          </p>
        </div>

        <div>
          <label className="text-[13px] font-medium text-ink-secondary">
            Tell the member <span className="text-ink-subtle">(optional)</span>
          </label>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {MEMBER_REPLIES.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setReply(reply === r ? null : r)}
                className={`rounded-full border px-3 py-1.5 text-[12px] transition ${
                  reply === r
                    ? "border-ink bg-ink text-surface"
                    : "border-line text-ink-secondary"
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        {error && <p className="text-[13px] text-urgent">{error}</p>}

        <div className="flex gap-2">
          <button
            disabled={pending}
            onClick={() => run(() => resolveAction(reportId, note, reply))}
            className="flex-1 rounded-xl bg-ink px-4 py-3.5 text-[15px] font-medium text-surface disabled:opacity-40"
          >
            {pending ? "Saving…" : "Mark resolved"}
          </button>
          <button
            onClick={() => setMode("idle")}
            className="rounded-xl border border-line px-4 py-3.5 text-[15px] text-ink-secondary"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (mode === "schedule") {
    return (
      <div className="mt-4 space-y-3 border-t border-line pt-4">
        <label className="text-[13px] font-medium text-ink-secondary">
          When will this be handled?
        </label>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="w-full rounded-lg border border-line px-3 py-2.5 text-[16px]"
        />
        {error && <p className="text-[13px] text-urgent">{error}</p>}
        <div className="flex gap-2">
          <button
            disabled={pending}
            onClick={() => run(() => scheduleAction(reportId, date))}
            className="flex-1 rounded-xl bg-ink px-4 py-3.5 text-[15px] font-medium text-surface disabled:opacity-40"
          >
            {pending ? "Saving…" : "Schedule"}
          </button>
          <button
            onClick={() => setMode("idle")}
            className="rounded-xl border border-line px-4 py-3.5 text-[15px] text-ink-secondary"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4 border-t border-line pt-3">
      {error && <p className="mb-2 text-[13px] text-urgent">{error}</p>}
      <div className="flex gap-2">
        {!claimed && (
          <button
            disabled={pending}
            onClick={() => run(() => acknowledgeAction(reportId))}
            className="flex-1 rounded-xl bg-ink px-4 py-3.5 text-[15px] font-medium text-surface disabled:opacity-40"
          >
            {pending ? "…" : "I've got this"}
          </button>
        )}
        <button
          onClick={() => setMode("resolve")}
          className={`rounded-xl border border-line px-4 py-3.5 text-[15px] font-medium text-ink-secondary ${
            claimed ? "flex-1" : ""
          }`}
        >
          Resolve
        </button>
        <button
          onClick={() => setMode("schedule")}
          className="rounded-xl border border-line px-4 py-3.5 text-[15px] text-ink-secondary"
        >
          Later
        </button>
      </div>
    </div>
  );
}
