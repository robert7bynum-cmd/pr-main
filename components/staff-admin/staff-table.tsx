"use client";

import { useState, useTransition } from "react";
import type { RosterRow, Department } from "@/lib/staff/queries";
import { setActive, setRole, setDepartments, resetPassword } from "@/app/actions/staff";

const ROLES = ["staff", "supervisor", "manager", "owner"] as const;

export function StaffTable({
  roster, departments, myRole, myId,
}: {
  roster: RosterRow[]; departments: Department[]; myRole: string; myId: string;
}) {
  const [pending, start] = useTransition();
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState<{ id: string; text: string } | null>(null);

  const run = (id: string, fn: () => Promise<{ ok: boolean; message?: string; tempPassword?: string }>) =>
    start(async () => {
      const res = await fn();
      setNote({
        id,
        text: res.tempPassword
          ? `Temporary password: ${res.tempPassword} — give them this once; they must change it.`
          : res.message ?? (res.ok ? "Saved" : "Something went wrong"),
      });
    });

  return (
    <div className="space-y-2">
      {roster.map((p) => {
        const isMe = p.profile_id === myId;
        // Mirrors the database guards. The UI hiding a control is a courtesy;
        // the function refusing it is the actual protection.
        const canEdit =
          !isMe && (myRole === "owner" || (myRole === "manager" && p.role !== "owner"));

        return (
          <div key={p.profile_id} className="rounded-card border border-line bg-surface-raised px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[15px] font-medium">
                  {p.full_name}
                  {isMe && <span className="ml-2 text-[12px] text-ink-muted">you</span>}
                  {p.account_kind === "station" && (
                    <span className="ml-2 rounded bg-surface-sunken px-1.5 py-0.5 text-[11px] text-ink-muted">
                      shared station
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-[12px] text-ink-muted">
                  {p.email ?? "no email"} · {p.departments.length ? p.departments.join(", ") : "no departments"}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {!p.active && (
                  <span className="rounded-pill bg-surface-sunken px-2 py-1 text-[11px] text-ink-muted">
                    inactive
                  </span>
                )}
                {p.on_duty && p.active && (
                  <span className="rounded-pill bg-surface-sunken px-2 py-1 text-[11px] text-ink-secondary">
                    on duty
                  </span>
                )}
                <span className="text-[12px] tabular-nums text-ink-muted">
                  {p.resolved_30d} resolved
                </span>
                <button
                  onClick={() => setOpen(open === p.profile_id ? null : p.profile_id)}
                  className="rounded-control border border-line px-2.5 py-1.5 text-[13px] text-ink-secondary"
                >
                  {open === p.profile_id ? "Close" : "Manage"}
                </button>
              </div>
            </div>

            {open === p.profile_id && (
              <div className="mt-3 space-y-3 border-t border-line pt-3">
                {!canEdit && (
                  <p className="text-[13px] text-ink-muted">
                    {isMe
                      ? "You cannot change your own role or deactivate yourself."
                      : "Only an owner can manage an owner."}
                  </p>
                )}

                {canEdit && (
                  <>
                    <div>
                      <label className="text-[12px] text-ink-muted">Role</label>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {ROLES.filter((r) => myRole === "owner" || r !== "owner").map((r) => (
                          <button
                            key={r}
                            disabled={pending}
                            onClick={() => run(p.profile_id, () => setRole(p.profile_id, r))}
                            className={`rounded-pill border px-3 py-1.5 text-[12px] ${
                              p.role === r ? "border-ink bg-ink text-surface" : "border-line text-ink-secondary"
                            }`}
                          >
                            {r}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <label className="text-[12px] text-ink-muted">Departments</label>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {departments.map((d) => {
                          const on = p.departments.includes(d.name);
                          return (
                            <button
                              key={d.id}
                              disabled={pending}
                              onClick={() => {
                                const next = on
                                  ? departments.filter((x) => p.departments.includes(x.name) && x.id !== d.id)
                                  : departments.filter((x) => p.departments.includes(x.name) || x.id === d.id);
                                run(p.profile_id, () => setDepartments(p.profile_id, next.map((x) => x.id)));
                              }}
                              className={`rounded-pill border px-3 py-1.5 text-[12px] ${
                                on ? "border-ink bg-ink text-surface" : "border-line text-ink-secondary"
                              }`}
                            >
                              {d.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <button
                        disabled={pending}
                        onClick={() => run(p.profile_id, () => setActive(p.profile_id, !p.active))}
                        className="rounded-control border border-line px-3 py-2 text-[13px] text-ink-secondary"
                      >
                        {p.active ? "Deactivate" : "Reactivate"}
                      </button>
                      {p.email && (
                        <button
                          disabled={pending}
                          onClick={() => run(p.profile_id, () => resetPassword(p.profile_id, p.email!))}
                          className="rounded-control border border-line px-3 py-2 text-[13px] text-ink-secondary"
                        >
                          Reset password
                        </button>
                      )}
                    </div>
                  </>
                )}

                {note?.id === p.profile_id && (
                  <p className="rounded-control bg-surface-sunken px-3 py-2 text-[13px] text-ink-secondary">
                    {note.text}
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
