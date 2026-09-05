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

export function QueueLive({
  courseId,
  station,
  newestId,
  newestBody,
}: {
  courseId: string;
  station: boolean;
  newestId: string | null;
  newestBody: string | null;
}) {
  const router = useRouter();
  const [conn, setConn] = useState<Conn>("connecting");
  const [sound, setSound] = useState(soundEnabled);
  const [banner, setBanner] = useState<string | null>(null);
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
      console.log("[queue-live] session token:", token ? `present (${token.length})` : "MISSING");
      if (token) await supabase.realtime.setAuth(token);

      // Unique per mount: two subscribes with the same channel name get
      // deduped, and the survivor can belong to an unmounted component.
      channel = supabase
      .channel(`queue-${courseId}-${Math.random().toString(36).slice(2, 8)}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "reports", filter: `course_id=eq.${courseId}` },
        (payload) => {
          console.log("[queue-live] event", payload.eventType);
          router.refresh();
        },
      )
      .subscribe((status, err) => {
        console.log("[queue-live] status", status, err?.message ?? "");
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
