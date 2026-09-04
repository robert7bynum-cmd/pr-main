"use client";

import { useEffect, useState } from "react";
import { savePushSubscription, sendTestPush } from "@/app/actions/push";

/**
 * Turning on alerts for this device.
 *
 * The flow ends with a real notification the person must see, not with a
 * permission prompt. On iOS, push only works once the site is installed to the
 * home screen, so an uninstalled iPhone is told that plainly instead of being
 * offered a button that cannot work.
 */
type State = "checking" | "unsupported" | "needs-install" | "off" | "on" | "blocked";

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
    const installed =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as unknown as { standalone?: boolean }).standalone === true;

    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setState(isIOS && !installed ? "needs-install" : "unsupported");
      return;
    }
    if (isIOS && !installed) return setState("needs-install");
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
      {state === "needs-install" && (
        <>
          <p className="text-[14px] font-medium">Add ProResponse to your home screen</p>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">
            On iPhone, alerts only work once this is installed. Tap Share, then
            &ldquo;Add to Home Screen&rdquo;, and open it from there.
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
