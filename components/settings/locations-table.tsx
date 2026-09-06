"use client";

import { useState, useTransition } from "react";
import { saveLocation, setLocationActive, mintPlacard } from "@/app/actions/settings";
import { Badge } from "@/components/ui/badge";

export interface LocationRow {
  id: string;
  kind: string;
  hole_number: number | null;
  name: string;
  sort_order: number;
  active: boolean;
  /** First six characters of the live code, or null when it has none. */
  token_prefix: string | null;
}

const KINDS: { id: string; label: string }[] = [
  { id: "hole", label: "Hole" },
  { id: "practice", label: "Practice area" },
  { id: "clubhouse", label: "Clubhouse" },
  { id: "cart_barn", label: "Cart barn" },
  { id: "restroom", label: "Restroom" },
  { id: "halfway_house", label: "Halfway house" },
  { id: "other", label: "Other" },
];
const kindLabel = (k: string) => KINDS.find((x) => x.id === k)?.label ?? k;

const field =
  "rounded-control border border-line bg-surface px-4 py-2.5 text-[14px] shadow-inset outline-none placeholder:text-ink-subtle focus:border-accent-border";
const button =
  "rounded-control border border-line bg-surface px-3.5 py-2.5 text-[13px] text-ink-secondary transition hover:border-line-strong disabled:opacity-40";

type Result = { ok: boolean; message: string };

export function LocationsTable({ locations }: { locations: LocationRow[] }) {
  const [pending, start] = useTransition();
  const [names, setNames] = useState<Record<string, string>>(
    Object.fromEntries(locations.map((l) => [l.id, l.name])),
  );
  const [note, setNote] = useState<{ id: string; ok: boolean; text: string; minted?: boolean } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [newKind, setNewKind] = useState("hole");
  const [newHole, setNewHole] = useState("");
  const [newName, setNewName] = useState("");

  const run = (id: string, fn: () => Promise<Result>, extra?: { minted?: boolean }) =>
    start(async () => {
      const res = await fn();
      setNote({ id, ok: res.ok, text: res.message, minted: res.ok && extra?.minted });
      setConfirming(null);
      if (res.ok && id === "new") { setAdding(false); setNewHole(""); setNewName(""); }
    });

  // Holes in play order, then everything else in its sort order — the order
  // someone walking the course would want. Retired rows keep their place so a
  // restore does not shuffle the list.
  const holes = locations.filter((l) => l.hole_number !== null).sort((a, b) => a.hole_number! - b.hole_number!);
  const facilities = locations.filter((l) => l.hole_number === null).sort((a, b) => a.sort_order - b.sort_order);

  const newHoleNumber = newHole.trim() === "" ? null : Number(newHole);
  const canAdd = newName.trim().length > 0
    && (newKind !== "hole" || (newHoleNumber !== null && Number.isInteger(newHoleNumber) && newHoleNumber >= 1 && newHoleNumber <= 99));

  const row = (l: LocationRow) => {
    const value = names[l.id] ?? l.name;
    const renamed = value.trim() !== l.name && value.trim().length > 0;
    const where = l.hole_number ? `Hole ${l.hole_number}` : l.name;
    return (
      <li key={l.id} className={`py-3 ${l.active ? "" : "opacity-70"}`}>
        <div className="flex flex-wrap items-center gap-2">
          {l.hole_number !== null && (
            <span className="w-8 shrink-0 text-[13px] font-medium tabular-nums text-ink-muted">{l.hole_number}</span>
          )}
          <input
            value={value}
            onChange={(e) => { setNote(null); setNames((n) => ({ ...n, [l.id]: e.target.value })); }}
            aria-label={`Name for ${where}`}
            maxLength={80}
            disabled={!l.active}
            className={`min-w-0 flex-1 ${field}`}
          />
          {renamed && l.active && (
            <button
              disabled={pending}
              onClick={() => run(l.id, () => saveLocation({
                id: l.id, kind: l.kind, holeNumber: l.hole_number, name: value, sortOrder: null,
              }))}
              className="rounded-control bg-accent-strong px-3.5 py-2.5 text-[13px] font-medium text-ink-on-accent disabled:opacity-40"
            >
              Rename
            </button>
          )}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-0 text-[12px] text-ink-muted sm:pl-10">
          <span>{kindLabel(l.kind)}</span>
          {/* The prefix, never the token: the token is a working placard and
              the row is on a screen anybody in the office can read over a
              shoulder. */}
          {l.token_prefix
            ? <span>code <code className="text-ink-secondary">{l.token_prefix}…</code></span>
            : <Badge variant="high" size="sm">No code</Badge>}
          {!l.active && <Badge variant="low" size="sm">Retired</Badge>}

          <span className="ml-auto flex gap-2">
            {l.active && confirming !== l.id && (
              <button disabled={pending} onClick={() => { setNote(null); setConfirming(l.id); }} className={button}>
                New code
              </button>
            )}
            <button
              disabled={pending}
              onClick={() => run(l.id, () => setLocationActive(l.id, !l.active))}
              className={button}
            >
              {l.active ? "Retire" : "Restore"}
            </button>
          </span>
        </div>

        {confirming === l.id && (
          <div className="mt-3 rounded-control border border-urgent-border bg-urgent-surface px-4 py-3 sm:ml-10">
            <p className="text-[13px] font-medium text-urgent">
              The current sign for {where} will stop working. Print and replace it.
            </p>
            <div className="mt-2.5 flex gap-2">
              <button
                disabled={pending}
                onClick={() => run(l.id, () => mintPlacard(l.id), { minted: true })}
                className="rounded-control bg-accent-strong px-4 py-2.5 text-[13px] font-medium text-ink-on-accent disabled:opacity-40"
              >
                {pending ? "Issuing…" : "Issue a new code"}
              </button>
              <button disabled={pending} onClick={() => setConfirming(null)} className={button}>Cancel</button>
            </div>
          </div>
        )}

        {note?.id === l.id && (
          <p className={`mt-2 text-[12px] leading-relaxed sm:ml-10 ${note.ok ? "text-ink-muted" : "text-urgent"}`}>
            {note.text}
            {note.minted && (
              <>
                {" "}
                <a href="/app/placards" className="font-medium text-ink underline underline-offset-2">
                  Print it from Placards.
                </a>
              </>
            )}
          </p>
        )}
      </li>
    );
  };

  return (
    <div className="space-y-4">
      {adding ? (
        <div className="rounded-card border border-line bg-surface-raised px-5 py-5 shadow-card">
          <div className="grid gap-3 sm:grid-cols-[auto_6rem_1fr]">
            <select value={newKind} onChange={(e) => { setNote(null); setNewKind(e.target.value); }} className={field}>
              {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
            </select>
            <input
              value={newHole} onChange={(e) => { setNote(null); setNewHole(e.target.value); }}
              placeholder="Hole #" inputMode="numeric" disabled={newKind !== "hole"}
              className={`${field} disabled:opacity-40`}
            />
            <input
              autoFocus value={newName} onChange={(e) => { setNote(null); setNewName(e.target.value); }}
              placeholder={newKind === "hole" ? "Hole 19" : "Name, e.g. Halfway House"} maxLength={80}
              className={field}
            />
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-ink-muted">
            A new location has no code until you issue one from its row.
          </p>
          {note?.id === "new" && !note.ok && <p className="mt-2 text-[12px] text-urgent">{note.text}</p>}
          <div className="mt-3 flex gap-2">
            <button
              disabled={pending || !canAdd}
              onClick={() => run("new", () => saveLocation({
                id: null, kind: newKind, holeNumber: newKind === "hole" ? newHoleNumber : null,
                name: newName, sortOrder: null,
              }))}
              className="rounded-control bg-accent-strong px-4 py-2.5 text-[13px] font-medium text-ink-on-accent disabled:opacity-40"
            >
              {pending ? "Adding…" : "Add location"}
            </button>
            <button onClick={() => { setAdding(false); setNote(null); }} className={button}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <button
            onClick={() => setAdding(true)}
            className="rounded-control bg-accent-strong px-5 py-3 text-[14px] font-medium text-ink-on-accent shadow-card transition"
          >
            Add a location
          </button>
          {note?.id === "new" && note.ok && <span className="text-[12px] text-ink-muted">{note.text}</span>}
        </div>
      )}

      <section className="rounded-card border border-line bg-surface-raised px-5 py-5 shadow-card">
        <h2 className="font-display text-[17px] tracking-tight">Holes</h2>
        {holes.length === 0
          ? <p className="mt-3 text-[13px] text-ink-muted">No holes yet.</p>
          : <ul className="mt-2 divide-y divide-line">{holes.map(row)}</ul>}
      </section>

      <section className="rounded-card border border-line bg-surface-raised px-5 py-5 shadow-card">
        <h2 className="font-display text-[17px] tracking-tight">Around the property</h2>
        {facilities.length === 0
          ? <p className="mt-3 text-[13px] text-ink-muted">Nothing besides the holes yet.</p>
          : <ul className="mt-2 divide-y divide-line">{facilities.map(row)}</ul>}
      </section>
    </div>
  );
}
