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
      <div className="mt-4 space-y-3 border-t border-black/8 pt-4">
        <div>
          <label className="text-[13px] font-medium text-black/70">
            What did you do? <span className="text-black/40">(internal)</span>
          </label>
          <textarea
            autoFocus
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Swapped the valve, tested twice"
            className="mt-1.5 w-full resize-none rounded-lg border border-black/15 px-3 py-2.5
                       text-[16px] outline-none focus:border-black/35"
          />
          <p className="mt-1 text-[11px] text-black/40">
            Only staff see this. The member sees the line you pick below.
          </p>
        </div>

        <div>
          <label className="text-[13px] font-medium text-black/70">
            Tell the member <span className="text-black/40">(optional)</span>
          </label>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {MEMBER_REPLIES.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setReply(reply === r ? null : r)}
                className={`rounded-full border px-3 py-1.5 text-[12px] transition ${
                  reply === r
                    ? "border-black bg-black text-white"
                    : "border-black/15 text-black/65"
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        {error && <p className="text-[13px] text-red-600">{error}</p>}

        <div className="flex gap-2">
          <button
            disabled={pending}
            onClick={() => run(() => resolveAction(reportId, note, reply))}
            className="flex-1 rounded-xl bg-black px-4 py-3.5 text-[15px] font-medium text-white disabled:opacity-40"
          >
            {pending ? "Saving…" : "Mark resolved"}
          </button>
          <button
            onClick={() => setMode("idle")}
            className="rounded-xl border border-black/15 px-4 py-3.5 text-[15px] text-black/60"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (mode === "schedule") {
    return (
      <div className="mt-4 space-y-3 border-t border-black/8 pt-4">
        <label className="text-[13px] font-medium text-black/70">
          When will this be handled?
        </label>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="w-full rounded-lg border border-black/15 px-3 py-2.5 text-[16px]"
        />
        {error && <p className="text-[13px] text-red-600">{error}</p>}
        <div className="flex gap-2">
          <button
            disabled={pending}
            onClick={() => run(() => scheduleAction(reportId, date))}
            className="flex-1 rounded-xl bg-black px-4 py-3.5 text-[15px] font-medium text-white disabled:opacity-40"
          >
            {pending ? "Saving…" : "Schedule"}
          </button>
          <button
            onClick={() => setMode("idle")}
            className="rounded-xl border border-black/15 px-4 py-3.5 text-[15px] text-black/60"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4 border-t border-black/8 pt-3">
      {error && <p className="mb-2 text-[13px] text-red-600">{error}</p>}
      <div className="flex gap-2">
        {!claimed && (
          <button
            disabled={pending}
            onClick={() => run(() => acknowledgeAction(reportId))}
            className="flex-1 rounded-xl bg-black px-4 py-3.5 text-[15px] font-medium text-white disabled:opacity-40"
          >
            {pending ? "…" : "I've got this"}
          </button>
        )}
        <button
          onClick={() => setMode("resolve")}
          className={`rounded-xl border border-black/15 px-4 py-3.5 text-[15px] font-medium text-black/75 ${
            claimed ? "flex-1" : ""
          }`}
        >
          Resolve
        </button>
        <button
          onClick={() => setMode("schedule")}
          className="rounded-xl border border-black/15 px-4 py-3.5 text-[15px] text-black/60"
        >
          Later
        </button>
      </div>
    </div>
  );
}
