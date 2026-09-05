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
      if (token) await supabase.realtime.setAuth(token);

      channel = supabase
      .channel(`queue-${courseId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "reports", filter: `course_id=eq.${courseId}` },
        () => router.refresh(),
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") setConn("live");
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") setConn("reconnecting");
      });
    })();

    return () => {
      if (channel) void supabase.removeChannel(channel);
    };
  }, [courseId, router]);

  // The guarantee. Short enough that a failed socket is not noticeable in a
  // demo, long enough not to hammer the database all day.
  useEffect(() => {
    const id = setInterval(() => router.refresh(), 20_000);
    return () => clearInterval(id);
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
            className={`h-1.5 w-1.5 rounded-full ${conn === "live" ? "bg-emerald-500" : "bg-high"}`}
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
            className="rounded-pill border border-line px-2.5 py-1 text-[12px] text-ink-secondary"
          >
            {sound ? (audioReady() ? "Sound on" : "Sound blocked") : "Sound off — tap to test"}
          </button>
        )}
      </div>

      {banner && (
        <div
          role="status"
          className="fixed inset-x-3 bottom-3 z-50 rounded-card bg-ink px-4 py-3
                     text-surface shadow-lg"
        >
          <p className="text-[12px] uppercase tracking-wide opacity-60">New report</p>
          <p className="mt-0.5 text-[15px] leading-snug">{banner}</p>
        </div>
      )}
    </>
  );
}
