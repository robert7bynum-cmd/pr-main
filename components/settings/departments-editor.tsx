"use client";

import { useState, useTransition } from "react";
import { saveDepartment } from "@/app/actions/settings";

export interface DepartmentRow { id: string; key: string; name: string; sort_order: number }

const field =
  "rounded-control border border-line bg-surface px-4 py-2.5 text-[14px] shadow-inset outline-none placeholder:text-ink-subtle focus:border-accent-border";
const button =
  "rounded-control border border-line bg-surface px-3.5 py-2.5 text-[13px] text-ink-secondary transition hover:border-line-strong disabled:opacity-40";

/**
 * Rename and add. There is no delete, on purpose: routing rules and staff
 * point at these rows, and a department that disappears takes a club's
 * routing with it. A team that no longer exists is renamed to the one that
 * took over its work.
 */
export function DepartmentsEditor({ departments }: { departments: DepartmentRow[] }) {
  const [pending, start] = useTransition();
  const [names, setNames] = useState<Record<string, string>>(
    Object.fromEntries(departments.map((d) => [d.id, d.name])),
  );
  const [note, setNote] = useState<{ id: string; ok: boolean; text: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newName, setNewName] = useState("");

  const run = (id: string, fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      const res = await fn();
      setNote({ id, ok: res.ok, text: res.message });
      if (res.ok && id === "new") { setAdding(false); setNewKey(""); setNewName(""); }
    });

  return (
    <section className="rounded-card border border-line bg-surface-raised px-5 py-5 shadow-card">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-[17px] tracking-tight">Departments</h2>
        <span className="text-[12px] tabular-nums text-ink-muted">{departments.length}</span>
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">
        The teams reports are routed to. Rename one here; who each category
        reaches is set under Routing &amp; SLAs.
      </p>

      <ul className="mt-4 divide-y divide-line">
        {departments.map((d) => {
          const value = names[d.id] ?? d.name;
          const changed = value.trim() !== d.name;
          return (
            <li key={d.id} className="py-3">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={value}
                  onChange={(e) => { setNote(null); setNames((n) => ({ ...n, [d.id]: e.target.value })); }}
                  aria-label={`Name for ${d.key}`}
                  maxLength={60}
                  className={`min-w-0 flex-1 ${field}`}
                />
                <code className="text-[12px] text-ink-subtle">{d.key}</code>
                <button
                  disabled={pending || !changed || value.trim().length < 2}
                  onClick={() => run(d.id, () => saveDepartment({ id: d.id, key: d.key, name: value, sortOrder: null }))}
                  className={button}
                >
                  Rename
                </button>
              </div>
              {note?.id === d.id && (
                <p className={`mt-2 text-[12px] ${note.ok ? "text-ink-muted" : "text-urgent"}`}>{note.text}</p>
              )}
            </li>
          );
        })}
      </ul>

      {adding ? (
        <div className="mt-4 rounded-control border border-line bg-surface-sunken px-4 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <input
              autoFocus value={newName} onChange={(e) => { setNote(null); setNewName(e.target.value); }}
              placeholder="Name, e.g. Valet" maxLength={60} className={field}
            />
            <input
              value={newKey} onChange={(e) => { setNote(null); setNewKey(e.target.value); }}
              placeholder="key, e.g. valet" autoCapitalize="none" spellCheck={false} className={field}
            />
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-ink-muted">
            The key is a short lowercase handle (letters and underscores) that
            never changes once staff are attached to it.
          </p>
          {note?.id === "new" && !note.ok && (
            <p className="mt-2 text-[12px] text-urgent">{note.text}</p>
          )}
          <div className="mt-3 flex gap-2">
            <button
              disabled={pending || newName.trim().length < 2 || !/^[a-z_]{2,32}$/.test(newKey.trim())}
              onClick={() => run("new", () => saveDepartment({ id: null, key: newKey, name: newName, sortOrder: null }))}
              className="rounded-control bg-accent-strong px-4 py-2.5 text-[13px] font-medium text-ink-on-accent disabled:opacity-40"
            >
              {pending ? "Adding…" : "Add department"}
            </button>
            <button onClick={() => { setAdding(false); setNote(null); }} className={button}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex items-center gap-3">
          <button onClick={() => setAdding(true)} className={button}>Add a department</button>
          {note?.id === "new" && note.ok && <span className="text-[12px] text-ink-muted">{note.text}</span>}
        </div>
      )}
    </section>
  );
}
