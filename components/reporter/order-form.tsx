"use client";

import { useState, useTransition } from "react";
import { submitOrder, type OrderResult } from "@/app/actions/submit-order";
import type { ScanContext } from "@/lib/scan/context";
import { fill, t, type Lang } from "@/lib/i18n/member";

/**
 * A member ordering food and drink from the hole they are standing on.
 *
 * Two fields that matter: what they want, and who they are. The member number
 * is not tucked behind a disclosure the way the reporting form's optional
 * details are — without it the club has no account to put the order on, and
 * the database refuses the order outright. So it is the second field, marked
 * required, and the button stays disabled until both are filled.
 *
 * No menu by design: the club would have to keep one current, and a member
 * asking in their own words for what they want is the whole point. Every word
 * comes from lib/i18n/member.ts.
 */
export function OrderForm({
  ctx,
  token,
  nonce,
  lang = "en",
}: {
  ctx: ScanContext;
  token: string;
  /** Null when the placard is flood-limited; submit reports the real reason. */
  nonce: string | null;
  lang?: Lang;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<OrderResult | null>(null);
  const [body, setBody] = useState("");
  const [memberNo, setMemberNo] = useState("");
  const [showContact, setShowContact] = useState(false);
  const s = t(lang);

  const ready = body.trim().length >= 3 && memberNo.trim().length > 0;

  if (result?.ok) {
    return (
      <div className="rounded-card border border-line bg-surface-raised px-7 py-12 text-center shadow-card">
        <div className="mx-auto mb-7 flex h-16 w-16 items-center justify-center rounded-full bg-accent-strong text-ink-on-accent shadow-card">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2.5"
              strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h2 className="font-display text-[1.6rem] leading-tight tracking-tight">
          {s.orderDoneHeading}
        </h2>
        <p className="mt-4 text-[15px] leading-relaxed text-ink-secondary">
          {fill(s.orderDoneBody, { location: ctx.locationName.toLowerCase() })}
        </p>
        <p className="mt-6 text-[13px] leading-relaxed text-ink-muted">
          {s.orderFooter}
        </p>
        <p className="mt-9 text-xs uppercase tracking-[0.16em] text-ink-subtle">
          {ctx.courseName}
        </p>
      </div>
    );
  }

  return (
    <form
      action={(fd) => {
        fd.set("token", token);
        fd.set("nonce", nonce ?? "");
        fd.set("language", lang);
        startTransition(async () => setResult(await submitOrder(fd)));
      }}
      className="space-y-6"
    >
      <div className="rounded-card border border-line bg-surface-raised p-5 shadow-card">
        <label htmlFor="order-body" className="block text-[14px] font-medium text-ink">
          {s.orderBodyLabel}
        </label>
        <textarea
          id="order-body"
          name="body"
          required
          autoFocus
          rows={3}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={s.orderBodyPlaceholder}
          className="mt-3 w-full resize-none rounded-control border border-line bg-surface
                     px-4 py-3.5 text-[17px] leading-relaxed shadow-inset outline-none
                     placeholder:text-ink-subtle
                     focus:border-accent-border focus:ring-4 focus:ring-accent-surface"
        />

        <label htmlFor="order-member-no" className="mt-6 block text-[14px] font-medium text-ink">
          {s.orderMemberNoLabel}
        </label>
        <input
          id="order-member-no"
          name="memberNo"
          required
          value={memberNo}
          onChange={(e) => setMemberNo(e.target.value)}
          autoComplete="off"
          aria-invalid={result?.needsMemberNo && !memberNo ? true : undefined}
          className={`mt-3 w-full rounded-control border bg-surface px-4 py-3.5 text-[17px]
                     tabular-nums shadow-inset outline-none placeholder:text-ink-subtle
                     focus:border-accent-border focus:ring-4 focus:ring-accent-surface ${
                       result?.needsMemberNo && !memberNo ? "border-urgent-border" : "border-line"
                     }`}
        />
        <p className="mt-2 text-[12px] leading-relaxed text-ink-muted">
          {s.orderMemberNoHint}
        </p>

        {!showContact ? (
          <button
            type="button"
            onClick={() => setShowContact(true)}
            className="mt-4 text-[14px] text-ink-muted underline underline-offset-4 hover:text-ink-secondary"
          >
            {s.optionalToggle}
          </button>
        ) : (
          <div className="mt-4 space-y-3 rounded-control border border-line bg-surface-sunken p-4">
            <p className="text-[12px] leading-relaxed text-ink-muted">
              {s.orderNameHint}
            </p>
            <input name="name" placeholder={s.namePlaceholder} autoComplete="name"
              className="w-full rounded-control border border-line bg-surface px-3.5 py-3 text-[16px]
                         outline-none placeholder:text-ink-subtle focus:border-accent-border" />
            <input name="phone" type="tel" placeholder={s.phonePlaceholder} autoComplete="tel"
              className="w-full rounded-control border border-line bg-surface px-3.5 py-3 text-[16px]
                         outline-none placeholder:text-ink-subtle focus:border-accent-border" />
            <p className="text-[12px] leading-relaxed text-ink-subtle">
              <a href="/privacy" target="_blank" rel="noopener noreferrer"
                className="underline underline-offset-4 hover:text-ink-secondary">
                {s.privacyLink}
              </a>
            </p>
          </div>
        )}
      </div>

      {result?.error && (
        <p className="rounded-control border border-urgent-border bg-urgent-surface px-4 py-3.5 text-[14px] text-urgent">
          {result.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending || !ready}
        className="w-full rounded-control bg-accent-strong px-6 py-4.5 text-[17px] font-medium
                   text-ink-on-accent shadow-card transition
                   disabled:cursor-not-allowed disabled:opacity-35 disabled:shadow-none"
      >
        {pending ? s.orderSending : s.orderSubmit}
      </button>

      <p className="text-center text-[12px] leading-relaxed text-ink-subtle">
        {s.orderFooter}
      </p>
    </form>
  );
}
