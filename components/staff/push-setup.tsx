"use client";

import { useEffect, useState } from "react";
import { savePushSubscription, sendTestPush } from "@/app/actions/push";

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

export function PushSetup() {
  const [state, setState] = useState<State>("checking");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

    // Safari on iOS cannot receive web push in a tab. Rather than push people
    // through a home-screen install they will not do, iPhones are pointed at
    // the native app.
    if (isIOS) return setState("ios-app");

    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      return setState("unsupported");
    }
    if (Notification.permission === "denied") return setState("blocked");

    navigator.serviceWorker.getRegistration().then(async (reg) => {
      const sub = await reg?.pushManager.getSubscription();
      setState(sub ? "on" : "off");
    });
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

      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(
          process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
        ),
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

  if (state === "checking" || state === "unsupported") return null;

  return (
    <div className="rounded-card border border-line bg-surface-raised px-4 py-3">
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
            className="shrink-0 rounded-control bg-ink px-4 py-2.5 text-[14px] font-medium
                       text-surface disabled:opacity-40"
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
            className="shrink-0 rounded-control border border-line px-3 py-2 text-[13px]
                       text-ink-secondary disabled:opacity-40"
          >
            Send a test
          </button>
        </div>
      )}

      {note && <p className="mt-2 text-[12px] text-ink-muted">{note}</p>}
    </div>
  );
}
