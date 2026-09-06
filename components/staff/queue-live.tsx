"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { primeAudio, playChime, audioReady } from "@/lib/notify/chime";

/**
 * Live queue updates and the audible alert for counter stations.
 *
 * Same shape as triage: a fast path and a guaranteed path.
 *   fast      — a realtime subscription triggers a refresh within a second
 *   guarantee — a poll every 20s, so the board is never badly stale
 *
 * Crucially the alert is driven by the *newest report id rendered by the
 * server*, not by the websocket event. An earlier version fired the banner from
 * inside the subscription callback and it never appeared: the handler belonged
 * to a component instance React had already unmounted, so every setState was
 * silently a no-op while router.refresh() kept working (the router is stable
 * across instances) — which made the queue look perfectly healthy. Deriving the
 * alert from props means it cannot desynchronise from what is on screen.
 */
type Conn = "connecting" | "live" | "reconnecting";

/**
 * Module scope on purpose: router.refresh() remounts this component, which
 * resets any useState or useRef. Tracking the last-alerted report inside the
 * component meant the "have I shown this?" marker was reset to the new report
 * on the very refresh that delivered it, so the banner never fired. Module
 * scope survives remounts for the life of the page.
 */
let lastAlertedId: string | null = null;
let soundEnabled = false;
/**
 * Whether this page has already had a working subscription. Distinguishes the
 * first connect, where the server-rendered list is already current, from a
 * reconnect, where it is not.
 */
let hadSubscribed = false;

/**
 * The sound preference outlives the page. A counter browser gets closed and
 * reopened every morning, and a station that came back silent after a restart
 * is the failure nobody notices until a report has sat for an hour.
 */
const SOUND_KEY = "proresponse.station.sound";

function readSoundPreference(): boolean | null {
  try {
    const v = localStorage.getItem(SOUND_KEY);
    return v === "on" ? true : v === "off" ? false : null;
  } catch {
    return null;
  }
}

function writeSoundPreference(on: boolean) {
  try {
    localStorage.setItem(SOUND_KEY, on ? "on" : "off");
  } catch {
    // Private mode or storage disabled: the toggle still works for this page.
  }
}

export function QueueLive({
  courseId,
  station,
  newestId,
  newestBody,
  defaultSound = false,
}: {
  courseId: string;
  station: boolean;
  newestId: string | null;
  newestBody: string | null;
  /** What sound does before anyone has touched the toggle on this browser. */
  defaultSound?: boolean;
}) {
  const router = useRouter();
  const [conn, setConn] = useState<Conn>("connecting");
  const [sound, setSound] = useState(soundEnabled);
  const [banner, setBanner] = useState<string | null>(null);
  // Re-rendered when audio is primed, so the label can stop saying "blocked".
  const [, setPrimed] = useState(false);

  // Restore the stored preference, or the page's default, on a station. Runs
  // on every remount (router.refresh() remounts this) and lands on the same
  // answer each time because the toggle persists before it changes anything.
  useEffect(() => {
    if (!station) return;
    const on = readSoundPreference() ?? defaultSound;
    soundEnabled = on;
    // Deferred for the same reason as the banner: a synchronous setState in an
    // effect cascades a render on every server refresh.
    const id = setTimeout(() => setSound(on), 0);
    return () => clearTimeout(id);
  }, [station, defaultSound]);

  // A restored "on" is a promise the browser will not let us keep until a
  // gesture has happened: audio stays suspended until the first click. So the
  // first pointer-down anywhere on the page primes it, and the label follows.
  useEffect(() => {
    if (!sound) return;
    const prime = () => { primeAudio(); setPrimed(true); };
    window.addEventListener("pointerdown", prime, { once: true });
    return () => window.removeEventListener("pointerdown", prime);
  }, [sound]);
  // Alert when the server hands us a report we have not shown before. On the
  // first render of a page load we only record it — arriving at the queue is
  // not a new-report event.
  useEffect(() => {
    if (!newestId) return;
    if (lastAlertedId === null) {
      lastAlertedId = newestId;
      return;
    }
    if (newestId === lastAlertedId) return;
    lastAlertedId = newestId;
    if (soundEnabled) playChime();
    // Deferred a tick: setting state synchronously inside an effect cascades
    // renders, and this effect runs on every server refresh.
    const id = setTimeout(() => setBanner(newestBody?.slice(0, 90) ?? "New report"), 0);
    return () => clearTimeout(id);
  }, [newestId, newestBody]);

  useEffect(() => {
    const supabase = createClient();
    let channel: ReturnType<typeof supabase.channel> | null = null;

    // The realtime socket authenticates separately from the REST client. Without
    // handing it the session token it connects as `anon`, and since anon holds
    // no table grants its RLS check fails — the channel reports SUBSCRIBED and
    // then silently delivers nothing. That is exactly how this broke: the
    // indicator said "Live" while no event ever arrived.
    void (async () => {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (token) await supabase.realtime.setAuth(token);

      // Unique per mount: two subscribes with the same channel name get
      // deduped, and the survivor can belong to an unmounted component.
      channel = supabase
      .channel(`queue-${courseId}-${Math.random().toString(36).slice(2, 8)}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "reports", filter: `course_id=eq.${courseId}` },
        () => {
          router.refresh();
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          setConn("live");
          // Events that happened while the socket was down were never
          // delivered and never will be. Marking the badge "Live" without
          // refetching left the board silently stale from the moment of the
          // outage onward — the worst version of this, because it looks
          // healthy. Re-subscribing means catching up.
          if (hadSubscribed) router.refresh();
          hadSubscribed = true;
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          setConn("reconnecting");
        }
      });
    })();

    return () => {
      if (channel) void supabase.removeChannel(channel);
    };
  }, [courseId, router]);

  // The guarantee. Short enough that a failed socket is not noticeable in a
  // demo, long enough not to hammer the database all day.
  //
  // On its own it is not a guarantee at all, which is how a report arrived by
  // push while the queue behind it stayed stale: a browser throttles timers in
  // a hidden tab and freezes them on a locked phone, so the one mechanism meant
  // to cover a dropped socket is asleep in exactly the situation that drops it.
  useEffect(() => {
    const id = setInterval(() => router.refresh(), 20_000);
    return () => clearInterval(id);
  }, [router]);

  // Coming back to the page is the moment staleness is visible and the moment
  // it matters: someone has just unlocked their phone because it buzzed. Every
  // one of these fires after a gap in which events could have been missed.
  useEffect(() => {
    const catchUp = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    document.addEventListener("visibilitychange", catchUp);
    window.addEventListener("focus", catchUp);
    window.addEventListener("online", catchUp);
    // A page restored from the back/forward cache is served whole from memory,
    // effects and all, so nothing above would otherwise run.
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) router.refresh(); };
    window.addEventListener("pageshow", onShow);
    return () => {
      document.removeEventListener("visibilitychange", catchUp);
      window.removeEventListener("focus", catchUp);
      window.removeEventListener("online", catchUp);
      window.removeEventListener("pageshow", onShow);
    };
  }, [router]);

  useEffect(() => {
    if (!banner) return;
    const id = setTimeout(() => setBanner(null), 8000);
    return () => clearTimeout(id);
  }, [banner]);

  return (
    <>
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1.5 text-[12px] text-ink-muted">
          <span
            className={`h-2 w-2 rounded-full ${conn === "live" ? "bg-ok" : "bg-high"}`}
          />
          {conn === "live" ? "Live" : "Reconnecting…"}
        </span>

        {station && (
          <button
            onClick={() => {
              const on = !sound;
              setSound(on);
              soundEnabled = on;
              writeSoundPreference(on);
              if (on) {
                primeAudio();
                // Play immediately: whoever switches it on hears proof it works.
                // A station muted at the OS level is the likeliest way this
                // feature fails with nobody noticing.
                setTimeout(() => playChime(), 60);
              }
            }}
            className="rounded-pill border border-line bg-surface-raised px-3 py-1.5 text-[12px] text-ink-secondary"
          >
            {sound ? (audioReady() ? "Sound on" : "Sound blocked") : "Sound off — tap to test"}
          </button>
        )}
      </div>

      {banner && (
        <div
          role="status"
          className="fixed inset-x-4 bottom-4 z-50 rounded-card border border-tone-urgent-border
                     bg-ink px-5 py-4 text-surface shadow-pop"
        >
          <p className="text-[11px] uppercase tracking-[0.14em] opacity-70">New report</p>
          <p className="mt-1.5 text-[15px] leading-snug">{banner}</p>
        </div>
      )}
    </>
  );
}
