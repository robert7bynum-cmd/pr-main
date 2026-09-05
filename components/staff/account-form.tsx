"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { updateMyProfile, setMyDuty } from "@/app/actions/account";

/**
 * Duty first, deliberately: it is the thing a person opens this page to do,
 * and the thing they do at the start and end of every shift. Name and phone
 * are corrections, made once.
 */
export function AccountForm({
  fullName, phone, onDuty,
}: { fullName: string; phone: string; onDuty: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [duty, setDuty] = useState(onDuty);
  const [name, setName] = useState(fullName);
  const [tel, setTel] = useState(phone);
  const [note, setNote] = useState<string | null>(null);

  const toggleDuty = () =>
    start(async () => {
      const next = !duty;
      const res = await setMyDuty(next);
      setNote(res.message ?? null);
      if (res.ok) { setDuty(next); router.refresh(); }
    });

  return (
    <div className="space-y-5">
      <div className="rounded-card border border-line bg-surface-raised px-5 py-5 shadow-card">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-[15px] font-medium">
              On duty
              <Badge variant={duty ? "department" : "neutral"} size="sm">
                {duty ? "You are on duty" : "Off duty"}
              </Badge>
            </p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">
              {duty
                ? "Reports for your departments come to you."
                : "Reports go to whoever else is on. You will not be paged."}
            </p>
          </div>
          <button
            onClick={toggleDuty}
            disabled={pending}
            className={`shrink-0 rounded-control px-4 py-3 text-[14px] font-medium shadow-card transition disabled:opacity-40 ${
              duty
                ? "border border-line bg-surface text-ink-secondary"
                : "bg-accent-strong text-ink-on-accent"
            }`}
          >
            {pending ? "…" : duty ? "Go off duty" : "Go on duty"}
          </button>
        </div>
      </div>

      <div className="rounded-card border border-line bg-surface-raised px-5 py-5 shadow-card">
        <p className="text-[15px] font-medium">Your details</p>
        <p className="mt-1 text-[13px] text-ink-secondary">
          How your name appears to the rest of the team.
        </p>
        <div className="mt-4 space-y-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            autoComplete="name"
            className="w-full rounded-control border border-line bg-surface px-4 py-3 text-[15px] outline-none focus:border-line-strong"
          />
          <input
            value={tel}
            onChange={(e) => setTel(e.target.value)}
            placeholder="Phone (optional)"
            type="tel"
            autoComplete="tel"
            className="w-full rounded-control border border-line bg-surface px-4 py-3 text-[15px] outline-none focus:border-line-strong"
          />
        </div>
        <button
          onClick={() =>
            start(async () => {
              const res = await updateMyProfile(name, tel);
              setNote(res.message ?? null);
              if (res.ok) router.refresh();
            })
          }
          disabled={pending || !name.trim()}
          className="mt-4 rounded-control bg-accent-strong px-5 py-3 text-[14px] font-medium text-ink-on-accent shadow-card transition disabled:opacity-40"
        >
          {pending ? "Saving…" : "Save"}
        </button>
      </div>

      {note && <p className="text-[13px] text-ink-muted">{note}</p>}
    </div>
  );
}
