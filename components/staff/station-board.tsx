"use client";

import { useEffect, useState } from "react";
import type { QueueRow, Teammate, DepartmentCount } from "@/lib/queue/reports";
import { Badge } from "@/components/ui/badge";
import { QueueCard } from "@/components/staff/queue-card";
import { QueueLive } from "@/components/staff/queue-live";
import { WakeLock } from "@/components/staff/wake-lock";

/**
 * The counter view.
 *
 * A browser that is already open on a pro shop or F&B counter is the one
 * alerting surface this product has that needs no push permission, no app
 * install, and no iOS exception: it is a tab, it is on, and it can make a
 * noise. This is that tab, laid out for a screen three metres from whoever is
 * meant to see it — the whole width, big type, sound on unless someone turned
 * it off, and the screen held awake.
 *
 * Cards are the ordinary queue cards, so what a station does to a report is
 * the same thing a phone does, with one difference carried by `meKind`: a
 * shared login is asked who is taking the report instead of being allowed to
 * claim it in its own name.
 *
 * A client component only because the fullscreen button has to be one; the
 * data arrives from the page, already fetched.
 */
export function StationBoard({
  courseId,
  courseName,
  meId,
  meKind,
  rows,
  departments,
  team,
  dept,
  elsewhere,
}: {
  courseId: string;
  courseName: string;
  meId: string;
  meKind: string;
  rows: QueueRow[];
  departments: DepartmentCount[];
  team: Teammate[];
  dept?: string;
  /** Open reports at the club when this board's own list is empty. */
  elsewhere: number;
}) {
  const overdue = rows.filter((r) => r.ack_overdue).length;
  const newest = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];

  return (
    <main className="station-board pb-24 text-[18px]">
      {/* Below the shell header (sticky, ~4.3rem tall) rather than over it. */}
      <div className="sticky top-[4.3rem] z-20 border-b border-line bg-surface-app/90 backdrop-blur-md">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-6 py-4">
          <div className="min-w-0">
            <p className="text-[12px] uppercase tracking-[0.18em] text-ink-subtle">Station board</p>
            <h1 className="mt-1 truncate font-display text-[1.6rem] leading-tight tracking-tight">
              {courseName}
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <span className="text-[16px] tabular-nums text-ink-muted">
              {rows.length} open{overdue > 0 ? ` · ${overdue} overdue` : ""}
            </span>
            <QueueLive
              courseId={courseId}
              station
              defaultSound
              newestId={newest?.id ?? null}
              newestBody={newest?.body ?? null}
            />
            <FullscreenButton />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-6 pb-3">
          <nav className="flex gap-2 overflow-x-auto">
            <Chip href="/app/station" label="All" count={null} active={!dept} />
            {departments.map((d) => (
              <Chip
                key={d.key}
                href={`/app/station?dept=${d.key}`}
                label={d.name}
                count={d.open}
                active={dept === d.key}
              />
            ))}
          </nav>
          <WakeLock />
        </div>
      </div>

      <div className="px-6 pt-6">
        {rows.length === 0 ? (
          <div className="rounded-card border border-line bg-surface-raised px-8 py-16 text-center shadow-card">
            <p className="text-[20px] leading-relaxed text-ink-muted">
              {elsewhere > 0
                ? "Nothing for this counter right now."
                : "Nothing open. The course is quiet."}
            </p>
            {elsewhere > 0 && (
              <p className="mt-3 text-[15px] text-ink-subtle">
                {elsewhere} open {elsewhere === 1 ? "report" : "reports"} elsewhere on the course.
              </p>
            )}
          </div>
        ) : (
          <div className="grid gap-5 md:grid-cols-2 2xl:grid-cols-3">
            {rows.map((row) => (
              <QueueCard key={row.id} row={row} team={team} meId={meId} meKind={meKind} />
            ))}
          </div>
        )}
      </div>

      {/* Size the shared card up for distance. The card's own classes are for
          a phone at arm's length; the board is read from across a counter. */}
      <style>{`
        .station-board article h2 { font-size: 2.4rem; }
        .station-board article p { font-size: 18px; }
      `}</style>
    </main>
  );
}

/**
 * Fullscreen is a request the browser can decline (iPad Safari has no
 * document-level fullscreen at all), so the button says which happened
 * rather than looking pressed and doing nothing.
 */
function FullscreenButton() {
  const [full, setFull] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => setFull(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const toggle = async () => {
    setNote(null);
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      } else {
        setNote("Fullscreen is not available in this browser");
      }
    } catch {
      setNote("The browser refused fullscreen");
    }
  };

  return (
    <span className="flex items-center gap-2">
      <button
        onClick={() => void toggle()}
        className="rounded-pill border border-line bg-surface-raised px-3 py-1.5 text-[12px] text-ink-secondary"
      >
        {full ? "Exit fullscreen" : "Fullscreen"}
      </button>
      {note && <span className="text-[12px] text-ink-muted">{note}</span>}
    </span>
  );
}

function Chip({
  href, label, count, active,
}: { href: string; label: string; count: number | null; active: boolean }) {
  return (
    <Badge
      variant={active ? "default" : "neutral"}
      size="lg"
      className={`h-10 shrink-0 px-5 text-[15px] font-medium ${active ? "shadow-card" : "bg-surface-raised"}`}
      render={<a href={href} />}
    >
      {label}
      {count !== null && <span className="tabular-nums opacity-70">{count}</span>}
    </Badge>
  );
}
