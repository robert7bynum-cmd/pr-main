"use client";

import { useState } from "react";
import type { Daily } from "@/lib/dashboard/queries";

/**
 * Reports filed per day, 30 days. One series, so one hue and no legend — the
 * heading names it. Bars carry a hover tooltip because an on-screen chart that
 * cannot be interrogated is a picture of data rather than data.
 */
export function VolumeChart({ data }: { data: Daily[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!data.length) return null;

  const max = Math.max(...data.map((d) => d.filed), 1);
  const W = 720, H = 132, PAD_B = 20;
  const bw = W / data.length;

  const label = (iso: string) =>
    new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img"
           aria-label="Reports filed per day over the last 30 days">
        {/* Recessive baseline only — no gridlines competing with the marks. */}
        <line x1="0" y1={H - PAD_B} x2={W} y2={H - PAD_B} stroke="var(--line)" strokeWidth="1" />
        {data.map((d, i) => {
          const h = Math.max(2, ((H - PAD_B - 8) * d.filed) / max);
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              {/* Full-height hit target: easier to hover than a thin bar. */}
              <rect x={i * bw} y={0} width={bw} height={H - PAD_B} fill="transparent" />
              <rect
                x={i * bw + 1.5} y={H - PAD_B - h}
                width={Math.max(2, bw - 3)} height={h}
                rx="2"
                fill={hover === i ? "var(--chart-series-1-hover)" : "var(--chart-series-1)"}
              />
              <title>{`${label(d.day)}: ${d.filed} reports`}</title>
            </g>
          );
        })}
        <text x="0" y={H - 6} fontSize="10" fill="var(--ink-muted)">{label(data[0].day)}</text>
        <text x={W} y={H - 6} fontSize="10" fill="var(--ink-muted)" textAnchor="end">
          {label(data[data.length - 1].day)}
        </text>
      </svg>

      {hover !== null && (
        <div
          className="pointer-events-none absolute -top-1 rounded-lg bg-black px-2.5 py-1.5
                     text-[12px] text-white shadow-sm"
          style={{ left: `${((hover + 0.5) / data.length) * 100}%`, transform: "translateX(-50%)" }}
        >
          {label(data[hover].day)} · {data[hover].filed}
        </div>
      )}
    </div>
  );
}
