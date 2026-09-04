import { NextResponse } from "next/server";
import { runTriage } from "@/lib/triage/worker";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Triage entry point for both the DB webhook and the cron sweeper.
 *
 * Guarded by a shared secret: this runs with service-role privileges, so an
 * open endpoint would let anyone drive the queue.
 */
export async function POST(request: Request) {
  const secret = process.env.TRIAGE_WORKER_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "worker not configured" }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await runTriage();
    return NextResponse.json(result);
  } catch (err) {
    console.error("[triage] run failed", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "triage failed" },
      { status: 500 },
    );
  }
}
