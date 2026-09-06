"use client";

import { useState, useTransition } from "react";
import { saveCourseSettings } from "@/app/actions/settings";

export interface CourseSettings {
  name: string;
  timezone: string;
  publicUrl: string;
  quietStart: string;
  quietEnd: string;
}

// The zones a US club is actually in. The current value is always offered
// too, so a club set up in a zone not listed here does not get silently moved
// to the top of the list on its first save.
const US_ZONES: { id: string; label: string }[] = [
  { id: "America/New_York", label: "Eastern — New York" },
  { id: "America/Detroit", label: "Eastern — Detroit" },
  { id: "America/Indiana/Indianapolis", label: "Eastern — Indianapolis" },
  { id: "America/Chicago", label: "Central — Chicago" },
  { id: "America/Denver", label: "Mountain — Denver" },
  { id: "America/Boise", label: "Mountain — Boise" },
  { id: "America/Phoenix", label: "Mountain, no DST — Phoenix" },
  { id: "America/Los_Angeles", label: "Pacific — Los Angeles" },
  { id: "America/Anchorage", label: "Alaska — Anchorage" },
  { id: "Pacific/Honolulu", label: "Hawaii — Honolulu" },
  { id: "America/Puerto_Rico", label: "Atlantic — Puerto Rico" },
];

const field =
  "w-full rounded-control border border-line bg-surface px-4 py-3 text-[15px] shadow-inset outline-none placeholder:text-ink-subtle focus:border-accent-border";
const label = "text-[12px] font-medium uppercase tracking-[0.1em] text-ink-subtle";

export function ClubSettingsForm({ initial }: { initial: CourseSettings }) {
  const [form, setForm] = useState(initial);
  const [pending, start] = useTransition();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const set = (patch: Partial<CourseSettings>) => { setNote(null); setForm((f) => ({ ...f, ...patch })); };

  const zones = US_ZONES.some((z) => z.id === form.timezone)
    ? US_ZONES
    : [{ id: form.timezone, label: form.timezone }, ...US_ZONES];

  // Mirrors the database guards so the obvious mistakes are caught before a
  // round trip. The function's refusal is the actual protection.
  const halfQuiet = (form.quietStart.trim() === "") !== (form.quietEnd.trim() === "");

  return (
    <div className="space-y-4">
      <section className="rounded-card border border-line bg-surface-raised px-5 py-5 shadow-card">
        <h2 className="font-display text-[17px] tracking-tight">The club</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className={label} htmlFor="club-name">Name</label>
            <input
              id="club-name" value={form.name} onChange={(e) => set({ name: e.target.value })}
              className={`mt-2 ${field}`} maxLength={80}
            />
          </div>
          <div>
            <label className={label} htmlFor="club-tz">Timezone</label>
            <select
              id="club-tz" value={form.timezone} onChange={(e) => set({ timezone: e.target.value })}
              className={`mt-2 ${field}`}
            >
              {zones.map((z) => <option key={z.id} value={z.id}>{z.label}</option>)}
            </select>
            <p className="mt-1.5 text-[12px] leading-relaxed text-ink-muted">
              Quiet hours and every time on the dashboard are read in this zone.
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-card border border-line bg-surface-raised px-5 py-5 shadow-card">
        <h2 className="font-display text-[17px] tracking-tight">Placard address</h2>
        {/* The one setting that becomes a physical object. The placard page
            explains the same rule; it is restated here because this is where
            the address is typed. */}
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">
          Every printed code points here. Set it once to the address members will
          always reach, and a move to a new domain later does not kill every sign
          on the course.
        </p>
        <div className="mt-4">
          <label className={label} htmlFor="club-url">Address</label>
          <input
            id="club-url" value={form.publicUrl} onChange={(e) => set({ publicUrl: e.target.value })}
            placeholder="https://reports.yourclub.com"
            inputMode="url" autoCapitalize="none" spellCheck={false}
            className={`mt-2 ${field}`}
          />
          <p className="mt-1.5 text-[12px] leading-relaxed text-ink-muted">
            https only. An address that only exists on one computer (localhost)
            or belongs to a preview build (a <span className="font-medium">-git-</span>
            vercel.app link) cannot be saved: a code printed against it is a
            sign that has to be physically replaced. Leave blank to print
            against this deployment&rsquo;s own address.
          </p>
        </div>
      </section>

      <section className="rounded-card border border-line bg-surface-raised px-5 py-5 shadow-card">
        <h2 className="font-display text-[17px] tracking-tight">Quiet hours</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">
          Between these times an unanswered report waits for morning instead of
          escalating. Safety reports, and reports the classifier is sure are
          urgent, still climb.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className={label} htmlFor="quiet-start">From</label>
            <input
              id="quiet-start" type="time" value={form.quietStart}
              onChange={(e) => set({ quietStart: e.target.value })}
              className={`mt-2 ${field}`}
            />
          </div>
          <div>
            <label className={label} htmlFor="quiet-end">Until</label>
            <input
              id="quiet-end" type="time" value={form.quietEnd}
              onChange={(e) => set({ quietEnd: e.target.value })}
              className={`mt-2 ${field}`}
            />
          </div>
        </div>
        {halfQuiet ? (
          <p className="mt-2 text-[12px] text-urgent">Quiet hours need both a start and an end.</p>
        ) : (
          <p className="mt-2 text-[12px] leading-relaxed text-ink-muted">
            Clear both to escalate around the clock.
          </p>
        )}
      </section>

      {/* Sticky, as on the rules page: a save button below the fold is a save
          button nobody presses. */}
      <div className="sticky bottom-4 z-10 flex items-center gap-3 rounded-card border border-line
                      bg-surface-raised px-4 py-3.5 shadow-pop">
        <button
          disabled={pending || !dirty || halfQuiet || form.name.trim().length < 2}
          onClick={() =>
            start(async () => {
              const res = await saveCourseSettings(form);
              setNote({ ok: res.ok, text: res.message });
            })
          }
          className="rounded-control bg-accent-strong px-5 py-3 text-[15px] font-medium text-ink-on-accent shadow-card transition disabled:opacity-40 disabled:shadow-none"
        >
          {pending ? "Saving…" : "Save changes"}
        </button>
        {dirty && !note && <span className="text-[13px] text-ink-muted">Unsaved changes</span>}
        {note && (
          <span className={`text-[13px] ${note.ok ? "text-ink-secondary" : "text-urgent"}`}>
            {note.text}
          </span>
        )}
      </div>
    </div>
  );
}
