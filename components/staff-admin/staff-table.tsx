"use client";

import { useState, useTransition } from "react";
import type { RosterRow, Department } from "@/lib/staff/queries";
import { setActive, setRole, setDepartments, resetPassword, createSignInLink } from "@/app/actions/staff";
import { Badge } from "@/components/ui/badge";

const ROLES = ["staff", "supervisor", "manager", "owner"] as const;

export function StaffTable({
  roster, departments, myRole, myId,
}: {
  roster: RosterRow[]; departments: Department[]; myRole: string; myId: string;
}) {
  const [pending, start] = useTransition();
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState<{ id: string; text: string } | null>(null);

  const [link, setLink] = useState<{ id: string; url: string } | null>(null);

  const run = (id: string, fn: () => Promise<{ ok: boolean; message?: string; link?: string }>) =>
    start(async () => {
      const res = await fn();
      setNote({ id, text: res.message ?? (res.ok ? "Saved" : "Something went wrong") });
      setLink(res.link ? { id, url: res.link } : null);
    });

  return (
    <div className="space-y-3">
      {roster.map((p) => {
        const isMe = p.profile_id === myId;
        // Mirrors the database guards. The UI hiding a control is a courtesy;
        // the function refusing it is the actual protection.
        const canEdit =
          !isMe && (myRole === "owner" || (myRole === "manager" && p.role !== "owner"));

        return (
          <div key={p.profile_id} className="rounded-card border border-line bg-surface-raised px-5 py-4 shadow-card">
            {/* Everything about the person runs full width and only the button
                sits opposite. The earlier split put badges, a resolved count
                and the button in a fixed right-hand cluster, which on a 390px
                phone squeezed the name and the department list into a column
                two words wide. */}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-[15px] font-medium">
                  {p.full_name}
                  {isMe && <Badge variant="low" size="sm">You</Badge>}
                  {!p.active && <Badge variant="low" size="sm">Inactive</Badge>}
                  {p.on_duty && p.active && <Badge variant="department" size="sm">On duty</Badge>}
                  {p.account_kind === "station" && (
                    <Badge variant="status" size="sm">Shared station</Badge>
                  )}
                  {/* The roster showed everything about who should be told and
                      nothing about who can be. A club can have the rules right,
                      the right people on duty, and still page nobody — and every
                      screen looks correct while it happens. Only shown for
                      people who are actually meant to be reachable. */}
                  {p.active && p.devices === 0 && (
                    <Badge variant="high" size="sm">No alerts</Badge>
                  )}
                </p>
                <p className="mt-2 text-[12px] leading-relaxed text-ink-muted">
                  {p.email ?? "no email"}
                </p>
                <p className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">
                  {p.departments.length ? p.departments.join(" · ") : "No departments"}
                  <span className="tabular-nums"> · {p.resolved_30d} resolved</span>
                  <span className="tabular-nums">
                    {" · "}
                    {p.devices === 0
                      ? "no device"
                      : `${p.devices} device${p.devices === 1 ? "" : "s"}`}
                  </span>
                </p>
              </div>

              <button
                onClick={() => setOpen(open === p.profile_id ? null : p.profile_id)}
                className="shrink-0 rounded-control border border-line bg-surface px-3.5 py-2.5 text-[13px] text-ink-secondary transition hover:border-line-strong"
              >
                {open === p.profile_id ? "Close" : "Manage"}
              </button>
            </div>

            {open === p.profile_id && (
              <div className="mt-4 space-y-4 border-t border-line pt-4">
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
                      <label className="text-[12px] font-medium uppercase tracking-[0.1em] text-ink-subtle">Role</label>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {ROLES.filter((r) => myRole === "owner" || r !== "owner").map((r) => (
                          <button
                            key={r}
                            disabled={pending}
                            onClick={() => run(p.profile_id, () => setRole(p.profile_id, r))}
                            className={`rounded-pill border px-3.5 py-2 text-[12px] font-medium capitalize transition ${
                              p.role === r
                                ? "border-accent-strong bg-accent-strong text-ink-on-accent shadow-card"
                                : "border-line bg-surface text-ink-secondary hover:border-accent-border"
                            }`}
                          >
                            {r}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <label className="text-[12px] font-medium uppercase tracking-[0.1em] text-ink-subtle">Departments</label>
                      <div className="mt-2 flex flex-wrap gap-2">
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
                              className={`rounded-pill border px-3.5 py-2 text-[12px] font-medium transition ${
                                on
                                  ? "border-accent-strong bg-accent-strong text-ink-on-accent shadow-card"
                                  : "border-line bg-surface text-ink-secondary hover:border-accent-border"
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
                        className="rounded-control border border-line bg-surface px-3.5 py-2.5 text-[13px] text-ink-secondary transition hover:border-line-strong"
                      >
                        {p.active ? "Deactivate" : "Reactivate"}
                      </button>
                      {p.email && (
                        <>
                          {/* Two ways to get somebody in. The link is first
                              because it is the one that always works: no
                              mailbox, no spam filter, no dependency on how the
                              project's redirect URLs happen to be configured. */}
                          <button
                            disabled={pending}
                            onClick={() => run(p.profile_id, () => createSignInLink(p.email!))}
                            className="rounded-control border border-line bg-surface px-3.5 py-2.5 text-[13px] text-ink-secondary transition hover:border-line-strong"
                          >
                            Get a sign-in link
                          </button>
                          <button
                            disabled={pending}
                            onClick={() => run(p.profile_id, () => resetPassword(p.profile_id, p.email!))}
                            className="rounded-control border border-line bg-surface px-3.5 py-2.5 text-[13px] text-ink-secondary transition hover:border-line-strong"
                          >
                            Email it instead
                          </button>
                        </>
                      )}
                    </div>
                  </>
                )}

                {link?.id === p.profile_id && (
              <div className="mt-3 rounded-control border border-line bg-surface-sunken px-4 py-3">
                <p className="text-[12px] text-ink-secondary">
                  Send this to {p.full_name}. It works once, and only for them.
                </p>
                <textarea
                  readOnly
                  onFocus={(e) => e.currentTarget.select()}
                  value={link.url}
                  rows={3}
                  className="mt-2 w-full resize-none rounded-control border border-line bg-surface px-3 py-2 text-[12px] leading-relaxed"
                />
                <button
                  onClick={() => { void navigator.clipboard?.writeText(link.url); setNote({ id: p.profile_id, text: "Copied." }); }}
                  className="mt-2 rounded-control bg-accent-strong px-4 py-2.5 text-[13px] font-medium text-ink-on-accent"
                >
                  Copy link
                </button>
              </div>
            )}
            {note?.id === p.profile_id && (
                  <p className="rounded-control border border-line bg-surface-sunken px-3.5 py-3 text-[13px] leading-relaxed text-ink-secondary">
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
