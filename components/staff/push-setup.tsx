"use client";

import { useEffect, useState } from "react";
import { savePushSubscription, sendTestPush, getPushPublicKey } from "@/app/actions/push";

/**
 * Turning on alerts for this device.
 *
 * The flow ends with a real notification the person must see, not with a
 * permission prompt — an unverified alert path is the same as no alerts.
 *
 * iOS does not deliver web push to a browser tab, and we are shipping native
 * apps rather than asking members of staff to add a website to their home
 * screen. So an iPhone is told the app is the route, not given an install
 * instruction it will ignore. Android and desktop stations get web push today.
 */
type State = "checking" | "unsupported" | "ios-app" | "off" | "on" | "blocked";

function urlBase64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/**
 * `card` is the version that sits in the queue: small, easy to ignore, and the
 * right shape for someone mid-shift who already said yes on another device.
 *
 * `onboarding` is the version that actually earns the permission. A browser
 * will only ask once per site, and a person who dismisses the OS prompt has to
 * go into settings to undo it — so the single ask is worth spending real
 * screen on, at the moment they are sitting down being set up rather than
 * standing on a fairway with the queue open.
 */
export function PushSetup({ variant = "card" }: { variant?: "card" | "onboarding" }) {
  const [state, setState] = useState<State>("checking");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // All of the detection runs inside one async pass, and the result is written
  // once. The earlier version set state synchronously in the effect body for
  // the device checks and again from a promise for the subscription, which
  // cascaded renders and — because the promise had no cancellation — could
  // write to a component that had already unmounted.
  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;

    void (async () => {
      const decide = async (): Promise<State> => {
        // Safari on iOS cannot receive web push in a tab. Rather than push
        // people through a home-screen install they will not do, iPhones are
        // pointed at the native app.
        if (/iphone|ipad|ipod/i.test(navigator.userAgent)) return "ios-app";
        if (!("serviceWorker" in navigator) || !("PushManager" in window)) return "unsupported";
        if (Notification.permission === "denied") return "blocked";
        const reg = await navigator.serviceWorker.getRegistration();
        const sub = await reg?.pushManager.getSubscription();
        return sub ? "on" : "off";
      };
      const next = await decide();
      if (!cancelled) setState(next);
    })();

    return () => { cancelled = true; };
  }, []);

  async function enable() {
    setBusy(true);
    setNote(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState("blocked");
        return;
      }

      // Fetched, not inlined at build time — see getPushPublicKey. Asked for
      // before registering the service worker so a club with no key configured
      // says so plainly instead of failing inside the browser's subscribe call
      // with something unreadable.
      const vapidKey = await getPushPublicKey();
      if (!vapidKey) {
        setNote("Notifications are not configured for this club yet.");
        return;
      }

      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });

      const json = sub.toJSON() as { keys?: { p256dh: string; auth: string } };
      const saved = await savePushSubscription({
        endpoint: sub.endpoint,
        p256dh: json.keys!.p256dh,
        auth: json.keys!.auth,
      });
      if (!saved.ok) {
        setNote(saved.error ?? "Could not save this device");
        return;
      }

      setState("on");
      // Prove it works now, while someone is looking at the screen.
      const test = await sendTestPush();
      setNote(test.ok ? "Sent a test alert — check your notifications." : test.error ?? null);
    } finally {
      setBusy(false);
    }
  }

  // The onboarding step has to say something even when this device cannot do
  // push at all, because it is a page of its own — a blank screen mid-setup
  // reads as broken. The queue card can simply not appear.
  if (state === "checking") return null;
  if (state === "unsupported" && variant === "card") return null;

  if (variant === "onboarding") {
    const canAsk = state === "off";
    return (
      <div>
        <h1 className="font-display text-[1.9rem] leading-tight tracking-tight">
          {state === "on" ? "You're all set" : "Getting told about a report"}
        </h1>
        <div className="mt-4 h-0.5 w-8 rounded-pill bg-accent" />

        <p className="mt-5 text-[15px] leading-relaxed text-ink-secondary">
          {state === "on"
            ? "This device will buzz when a report is sent to you."
            : state === "ios-app"
              ? "iPhone can't send alerts from a browser tab. The ProResponse app is on the way — until then you'll see new reports whenever the queue is open."
              : state === "blocked"
                ? "This browser is blocking notifications for the site. You can turn them back on in browser settings, then reload — or carry on and do it later."
                : state === "unsupported"
                  ? "This browser can't send alerts. You'll still see new reports whenever the queue is open, and you can turn alerts on later from a phone."
                  : "A member scans a code on the course and it comes straight to whoever is on duty. Without alerts you would only find out by opening the queue."}
        </p>

        {canAsk && (
          <p className="mt-3 text-[13px] leading-relaxed text-ink-muted">
            Your browser will ask you to allow notifications. It only asks once,
            so if you dismiss it you will have to turn them on in settings later.
          </p>
        )}

        <div className="mt-7 flex flex-col gap-3">
          {canAsk && (
            <button
              onClick={enable}
              disabled={busy}
              className="w-full rounded-control bg-accent-strong px-4 py-3.5 text-[15px] font-medium
                         text-ink-on-accent shadow-card transition disabled:opacity-40"
            >
              {busy ? "Turning on…" : "Turn on alerts"}
            </button>
          )}
          <a
            href="/app"
            className={`w-full rounded-control px-4 py-3.5 text-center text-[15px] transition ${
              canAsk
                ? "border border-line bg-surface text-ink-secondary hover:border-line-strong"
                : "bg-accent-strong text-ink-on-accent shadow-card font-medium"
            }`}
          >
            {canAsk ? "Not now" : "Go to the queue"}
          </a>
        </div>

        {note && <p className="mt-4 text-[13px] text-ink-muted">{note}</p>}
      </div>
    );
  }

  return (
    <div className="rounded-card border border-line bg-surface-raised px-5 py-4 shadow-card">
      {state === "ios-app" && (
        <>
          <p className="text-[14px] font-medium">Alerts come through the iPhone app</p>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">
            iPhone can&apos;t send alerts from a browser tab. The ProResponse app is
            on the way — until then you&apos;ll see new reports here whenever this
            page is open.
          </p>
        </>
      )}

      {state === "blocked" && (
        <>
          <p className="text-[14px] font-medium">Alerts are blocked</p>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">
            Your browser is blocking notifications for this site. Turn them on in
            settings, then reload.
          </p>
        </>
      )}

      {state === "off" && (
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[14px] font-medium">Turn on alerts</p>
            <p className="mt-0.5 text-[13px] text-ink-secondary">
              Get a notification when a report is sent to you.
            </p>
          </div>
          <button
            onClick={enable}
            disabled={busy}
            className="shrink-0 rounded-control bg-accent-strong px-4 py-3 text-[14px] font-medium
                       text-ink-on-accent shadow-card transition disabled:opacity-40"
          >
            {busy ? "…" : "Turn on"}
          </button>
        </div>
      )}

      {state === "on" && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-[14px]">
            Alerts are on for this device.
          </p>
          <button
            onClick={async () => {
              setBusy(true);
              const t = await sendTestPush();
              setNote(t.ok ? "Sent — check your notifications." : t.error ?? null);
              setBusy(false);
            }}
            disabled={busy}
            className="shrink-0 rounded-control border border-line bg-surface px-3.5 py-2.5 text-[13px]
                       text-ink-secondary transition hover:border-line-strong disabled:opacity-40"
          >
            Send a test
          </button>
        </div>
      )}

      {note && <p className="mt-2 text-[12px] text-ink-muted">{note}</p>}
    </div>
  );
}
