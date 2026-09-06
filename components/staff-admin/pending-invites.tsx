"use client";

import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { createSignInLink, resetPassword } from "@/app/actions/staff";
import type { PendingInvite } from "@/lib/staff/queries";

/**
 * People invited who have not signed in yet.
 *
 * This used to be a list and nothing else — which meant the one person a
 * manager actually needs to chase was the one person they could do nothing
 * about. The sign-in link buttons lived on the roster, and an unclaimed invite
 * is not on the roster: there is no profile until they arrive. So the invite
 * sat there saying "not signed in yet" with no way to help them sign in.
 */
export function PendingInvites({ invites }: { invites: PendingInvite[] }) {
  const [pending, start] = useTransition();
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const [note, setNote] = useState<{ email: string; text: string } | null>(null);

  const run = (
    email: string,
    fn: () => Promise<{ ok: boolean; message?: string; link?: string }>,
  ) =>
    start(async () => {
      const res = await fn();
      setNote({ email, text: res.message ?? (res.ok ? "Done" : "Something went wrong") });
      setLink(res.link ? { email, url: res.link } : null);
    });

  return (
    <div className="mb-5 rounded-card border border-tone-high-border bg-tone-high-fill px-5 py-4 shadow-card">
      <Badge variant="high" size="sm">Gap</Badge>
      <p className="mt-2.5 text-[13px] font-medium text-tone-high-ink">
        Invited, not signed in yet
      </p>
      <p className="mt-1.5 text-[12px] leading-relaxed text-ink-secondary">
        They will not receive alerts until they sign in.
      </p>

      <ul className="mt-3.5 space-y-3.5">
        {invites.map((p) => (
          <li key={p.id} className="border-t border-tone-high-border pt-3.5 first:border-t-0 first:pt-0">
            <p className="text-[14px] font-medium">{p.full_name}</p>
            <p className="mt-0.5 text-[12px] text-ink-secondary">
              {p.email} · {p.role}
            </p>

            <div className="mt-2.5 flex flex-wrap gap-2">
              {/* The link first: it works immediately, needs no mailbox, and
                  does not depend on how the project's redirect URLs happen to
                  be set. Email is the convenience, not the mechanism. */}
              <button
                disabled={pending}
                onClick={() => run(p.email, () => createSignInLink(p.email))}
                className="rounded-control border border-line bg-surface px-3.5 py-2.5 text-[13px] text-ink-secondary transition hover:border-line-strong disabled:opacity-40"
              >
                Get a sign-in link
              </button>
              <button
                disabled={pending}
                onClick={() => run(p.email, () => resetPassword(p.id, p.email))}
                className="rounded-control border border-line bg-surface px-3.5 py-2.5 text-[13px] text-ink-secondary transition hover:border-line-strong disabled:opacity-40"
              >
                Send the invite again
              </button>
            </div>

            {link?.email === p.email && (
              <div className="mt-3 rounded-control border border-line bg-surface px-4 py-3">
                <p className="text-[12px] leading-relaxed text-ink-secondary">
                  Send this to {p.full_name}. It works once, and only for them.
                </p>
                <textarea
                  readOnly
                  onFocus={(e) => e.currentTarget.select()}
                  value={link.url}
                  rows={3}
                  className="mt-2 w-full resize-none rounded-control border border-line bg-surface-sunken px-3 py-2 text-[12px] leading-relaxed"
                />
                <button
                  onClick={() => {
                    void navigator.clipboard?.writeText(link.url);
                    setNote({ email: p.email, text: "Copied." });
                  }}
                  className="mt-2 rounded-control bg-accent-strong px-4 py-2.5 text-[13px] font-medium text-ink-on-accent"
                >
                  Copy link
                </button>
              </div>
            )}

            {note?.email === p.email && (
              <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{note.text}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
