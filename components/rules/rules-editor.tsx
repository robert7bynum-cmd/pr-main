"use client";

import { useState, useTransition } from "react";
import { saveRoutingRules, type RuleInput } from "@/app/actions/rules";

export interface Rule extends RuleInput {
  department_name: string;
  reports_30d: number;
}
export interface Dept { id: string; name: string }

const CATEGORY_LABEL: Record<string, string> = {
  course_maintenance: "Course maintenance", pace_of_play: "Pace of play",
  cart_issue: "Cart", pro_shop: "Pro shop", f_and_b: "Food & beverage",
  restroom_facilities: "Restrooms", practice_facility: "Practice facility",
  safety: "Safety", caddie_valet: "Caddie & valet", needs_review: "Needs review",
};

// Pill options rather than free entry: these are operational commitments, and a
// short list of sensible values is easier to agree with a GM than a number box.
const ACK_OPTIONS = [5, 10, 15, 30, 60];
const RESOLVE_OPTIONS = [30, 60, 120, 240, 480, 1440];

const label = (m: number) =>
  m < 60 ? `${m} min` : m === 1440 ? "1 day" : `${m / 60} hr`;

function Pills({ options, value, onChange, format }: {
  options: number[]; value: number; onChange: (v: number) => void;
  format: (n: number) => string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => onChange(o)}
          className={`rounded-pill border px-3 py-1.5 text-[13px] transition ${
            value === o
              ? "border-ink bg-ink text-surface"
              : "border-line text-ink-secondary hover:border-line-strong"
          }`}
        >
          {format(o)}
        </button>
      ))}
      {/* A value set outside the presets stays visible rather than silently
          snapping to the nearest pill. */}
      {!options.includes(value) && (
        <span className="rounded-pill border border-ink bg-ink px-3 py-1.5 text-[13px] text-surface">
          {format(value)}
        </span>
      )}
    </div>
  );
}

export function RulesEditor({ initial, departments }: {
  initial: Rule[]; departments: Dept[];
}) {
  const [rules, setRules] = useState(initial);
  const [pending, start] = useTransition();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const dirty = JSON.stringify(rules) !== JSON.stringify(initial);

  const update = (category: string, patch: Partial<Rule>) => {
    setNote(null);
    setRules((rs) => rs.map((r) => (r.category === category ? { ...r, ...patch } : r)));
  };

  return (
    <div className="space-y-3">
      {rules.map((r) => (
        <section key={r.category} className="rounded-card border border-line bg-surface-raised px-4 py-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-[15px] font-semibold">
              {CATEGORY_LABEL[r.category] ?? r.category}
            </h2>
            <span className="text-[12px] tabular-nums text-ink-muted">
              {r.reports_30d} in 30 days
            </span>
          </div>

          <div className="mt-3">
            <p className="text-[12px] text-ink-muted">Goes to</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {departments.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => update(r.category, { department_id: d.id, department_name: d.name })}
                  className={`rounded-pill border px-3 py-1.5 text-[13px] transition ${
                    r.department_id === d.id
                      ? "border-ink bg-ink text-surface"
                      : "border-line text-ink-secondary hover:border-line-strong"
                  }`}
                >
                  {d.name}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <p className="text-[12px] text-ink-muted">Someone should pick it up within</p>
              <div className="mt-1.5">
                <Pills
                  options={ACK_OPTIONS}
                  value={r.ack_sla_minutes}
                  onChange={(v) => update(r.category, { ack_sla_minutes: v })}
                  format={label}
                />
              </div>
            </div>
            <div>
              <p className="text-[12px] text-ink-muted">And resolve it within</p>
              <div className="mt-1.5">
                <Pills
                  options={RESOLVE_OPTIONS}
                  value={r.resolve_sla_minutes}
                  onChange={(v) => update(r.category, { resolve_sla_minutes: v })}
                  format={label}
                />
              </div>
            </div>
          </div>

          {r.resolve_sla_minutes < r.ack_sla_minutes && (
            <p className="mt-2 text-[12px] text-urgent">
              Resolve time cannot be shorter than pick-up time.
            </p>
          )}
        </section>
      ))}

      {/* Sticky, because the list is long and a save button below the fold is a
          save button nobody presses. */}
      <div className="sticky bottom-3 z-10 flex items-center gap-3 rounded-card border border-line
                      bg-surface-raised px-4 py-3 shadow-sm">
        <button
          disabled={pending || !dirty || rules.some((r) => r.resolve_sla_minutes < r.ack_sla_minutes)}
          onClick={() =>
            start(async () => {
              const res = await saveRoutingRules(
                rules.map(({ category, department_id, ack_sla_minutes, resolve_sla_minutes }) => ({
                  category, department_id, ack_sla_minutes, resolve_sla_minutes,
                })),
              );
              setNote({ ok: res.ok, text: res.message });
            })
          }
          className="rounded-control bg-ink px-5 py-2.5 text-[15px] font-medium text-surface disabled:opacity-40"
        >
          {pending ? "Saving…" : "Save changes"}
        </button>

        {dirty && !note && (
          <span className="text-[13px] text-ink-muted">Unsaved changes</span>
        )}
        {note && (
          <span className={`text-[13px] ${note.ok ? "text-ink-secondary" : "text-urgent"}`}>
            {note.text}
          </span>
        )}
      </div>
    </div>
  );
}
