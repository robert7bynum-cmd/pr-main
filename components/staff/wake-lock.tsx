"use client";

import { useEffect, useState } from "react";

/**
 * Keeps the screen on while the board is open.
 *
 * A counter browser goes to sleep after ten minutes like any other, and a
 * sleeping screen is a board nobody looks at: the chime still plays, but the
 * banner, the count and the red bar are all behind a black display. The Screen
 * Wake Lock API asks the browser not to do that, for as long as the page is
 * visible — the lock is released whenever the tab is hidden, so it is asked
 * for again every time the tab comes back.
 *
 * It renders its own state, always. A page that quietly failed to hold the
 * lock would look exactly like one that holds it, right up until the screen
 * went dark at the wrong moment; the one-line note under the top bar is how a
 * person at the counter finds out which they have.
 */
type State =
  | "checking"
  /** Held; the screen stays on while this tab is in front. */
  | "held"
  /** The browser released it — tab hidden, or the OS took it back. */
  | "released"
  /** No Wake Lock API in this browser (Firefox, older Safari). */
  | "unsupported"
  /** The API exists and refused — usually low power mode or a policy. */
  | "refused";

export function WakeLock() {
  const [state, setState] = useState<State>("checking");
  // Bumped to ask again after a release, without remounting.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      // Every await below defers the setState calls off the effect's own
      // stack; the first one exists only for that.
      await Promise.resolve();
      if (cancelled) return;
      if (!("wakeLock" in navigator)) { setState("unsupported"); return; }
      if (document.visibilityState !== "visible") return;
      try {
        const s = await navigator.wakeLock.request("screen");
        if (cancelled) { void s.release(); return; }
        sentinel = s;
        setState("held");
        s.addEventListener("release", () => { if (!cancelled) setState("released"); });
      } catch {
        if (!cancelled) setState("refused");
      }
    };

    void acquire();
    const onVisible = () => { if (document.visibilityState === "visible") void acquire(); };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void sentinel?.release();
    };
  }, [attempt]);

  if (state === "checking") return null;

  if (state === "held") {
    return (
      <p className="text-[12px] text-ink-subtle">Screen will stay on</p>
    );
  }

  const why =
    state === "unsupported" ? "this browser cannot keep it on"
    : state === "refused" ? "the browser refused to keep it on"
    : "the lock was released";

  return (
    <p className="text-[12px] text-ink-muted">
      Screen may sleep — {why}.
      {state !== "unsupported" && (
        <>
          {" "}
          <button
            onClick={() => setAttempt((n) => n + 1)}
            className="underline underline-offset-2"
          >
            Try again
          </button>
        </>
      )}
    </p>
  );
}
