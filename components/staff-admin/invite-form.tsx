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
        className="rounded-control bg-ink px-4 py-2.5 text-[14px] font-medium text-surface"
      >
        Add someone
      </button>
    );
  }

  return (
    <div className="rounded-card border border-line bg-surface-raised px-4 py-4">
      <div className="grid gap-2.5 sm:grid-cols-2">
        <input
          autoFocus value={name} onChange={(e) => setName(e.target.value)}
          placeholder="Full name"
          className="rounded-control border border-line px-3 py-2.5 text-[15px] outline-none focus:border-line-strong"
        />
        <input
          type="email" value={email} onChange={(e) => setEmail(e.target.value)}
          placeholder="Email they'll sign in with"
          className="rounded-control border border-line px-3 py-2.5 text-[15px] outline-none focus:border-line-strong"
        />
      </div>

      <div className="mt-3">
        <label className="text-[12px] text-ink-muted">Role</label>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {["staff", "supervisor", "manager", ...(canInviteOwner ? ["owner"] : [])].map((r) => (
            <button key={r} onClick={() => setRole(r)}
              className={`rounded-pill border px-3 py-1.5 text-[12px] ${
                role === r ? "border-ink bg-ink text-surface" : "border-line text-ink-secondary"}`}>
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3">
        <label className="text-[12px] text-ink-muted">Departments</label>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {departments.map((d) => (
            <button key={d.id}
              onClick={() => setDepts((s) => s.includes(d.id) ? s.filter((x) => x !== d.id) : [...s, d.id])}
              className={`rounded-pill border px-3 py-1.5 text-[12px] ${
                depts.includes(d.id) ? "border-ink bg-ink text-surface" : "border-line text-ink-secondary"}`}>
              {d.name}
            </button>
          ))}
        </div>
      </div>

      {result && (
        <p className={`mt-3 rounded-control px-3 py-2 text-[13px] ${
          result.ok ? "bg-surface-sunken text-ink-secondary" : "bg-urgent-surface text-urgent"}`}>
          {result.text}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <button
          disabled={pending || !email || !name}
          onClick={() => start(async () => {
            const res = await inviteStaff(email, name, role, depts);
            setResult({
              ok: res.ok,
              // Shown once, deliberately: there is no way to retrieve it later,
              // which is what makes it safe to generate on a manager's screen.
              text: res.tempPassword
                ? `Invited. Temporary password: ${res.tempPassword} — give it to them now, it is not shown again.`
                : res.message ?? (res.ok ? "Invited." : "Could not invite."),
            });
            if (res.ok) { setEmail(""); setName(""); setDepts([]); }
          })}
          className="rounded-control bg-ink px-4 py-2.5 text-[14px] font-medium text-surface disabled:opacity-40"
        >
          {pending ? "Inviting…" : "Send invite"}
        </button>
        <button onClick={() => { setOpen(false); setResult(null); }}
          className="rounded-control border border-line px-4 py-2.5 text-[14px] text-ink-secondary">
          Done
        </button>
      </div>
    </div>
  );
}
