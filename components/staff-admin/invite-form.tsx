"use client";

import { useState, useTransition } from "react";
import type { Department } from "@/lib/staff/queries";
import { inviteStaff } from "@/app/actions/staff";

export function InviteForm({ departments, canInviteOwner }: {
  departments: Department[]; canInviteOwner: boolean;
}) {
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("staff");
  const [depts, setDepts] = useState<string[]>([]);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-control bg-accent-strong px-5 py-3 text-[14px] font-medium text-ink-on-accent shadow-card transition"
      >
        Add someone
      </button>
    );
  }

  return (
    <div className="rounded-card border border-line bg-surface-raised px-5 py-5 shadow-card">
      <div className="grid gap-3 sm:grid-cols-2">
        <input
          autoFocus value={name} onChange={(e) => setName(e.target.value)}
          placeholder="Full name"
          className="rounded-control border border-line bg-surface px-4 py-3 text-[15px] shadow-inset outline-none placeholder:text-ink-subtle focus:border-accent-border"
        />
        <input
          type="email" value={email} onChange={(e) => setEmail(e.target.value)}
          placeholder="Email they'll sign in with"
          className="rounded-control border border-line bg-surface px-4 py-3 text-[15px] shadow-inset outline-none placeholder:text-ink-subtle focus:border-accent-border"
        />
      </div>

      <div className="mt-5">
        <label className="text-[12px] font-medium uppercase tracking-[0.1em] text-ink-subtle">Role</label>
        <div className="mt-2 flex flex-wrap gap-2">
          {["staff", "supervisor", "manager", ...(canInviteOwner ? ["owner"] : [])].map((r) => (
            <button key={r} onClick={() => setRole(r)}
              className={`rounded-pill border px-3.5 py-2 text-[12px] font-medium capitalize transition ${
                role === r
                  ? "border-accent-strong bg-accent-strong text-ink-on-accent shadow-card"
                  : "border-line bg-surface text-ink-secondary hover:border-accent-border"}`}>
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-5">
        <label className="text-[12px] font-medium uppercase tracking-[0.1em] text-ink-subtle">Departments</label>
        <div className="mt-2 flex flex-wrap gap-2">
          {departments.map((d) => (
            <button key={d.id}
              onClick={() => setDepts((s) => s.includes(d.id) ? s.filter((x) => x !== d.id) : [...s, d.id])}
              className={`rounded-pill border px-3.5 py-2 text-[12px] font-medium transition ${
                depts.includes(d.id)
                  ? "border-accent-strong bg-accent-strong text-ink-on-accent shadow-card"
                  : "border-line bg-surface text-ink-secondary hover:border-accent-border"}`}>
              {d.name}
            </button>
          ))}
        </div>
      </div>

      {result && (
        <p className={`mt-5 rounded-control border px-4 py-3 text-[13px] leading-relaxed ${
          result.ok
            ? "border-tone-dept-border bg-tone-dept-fill text-tone-dept-ink"
            : "border-urgent-border bg-urgent-surface text-urgent"}`}>
          {result.text}
        </p>
      )}

      <div className="mt-6 flex gap-2.5">
        <button
          disabled={pending || !email || !name}
          onClick={() => start(async () => {
            const res = await inviteStaff(email, name, role, depts);
            setResult({
              ok: res.ok,
              text: res.message ?? (res.ok ? "Invitation sent." : "Could not invite."),
            });
            if (res.ok) { setEmail(""); setName(""); setDepts([]); }
          })}
          className="rounded-control bg-accent-strong px-5 py-3 text-[14px] font-medium text-ink-on-accent shadow-card transition disabled:opacity-40 disabled:shadow-none"
        >
          {pending ? "Inviting…" : "Send invite"}
        </button>
        <button onClick={() => { setOpen(false); setResult(null); }}
          className="rounded-control border border-line bg-surface px-5 py-3 text-[14px] text-ink-secondary transition hover:border-line-strong">
          Done
        </button>
      </div>
    </div>
  );
}
