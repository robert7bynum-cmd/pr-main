"use server";

import { redirect } from "next/navigation";
import { signIn } from "./auth";

/**
 * One-click sign-in for the demo personas.
 *
 * Calls the same password sign-in a real staff member uses, with the shared
 * demo password — so the demo cannot pass where the real path would fail.
 *
 * Gated by DEMO_SIGNIN. Leave it unset and this refuses, so the buttons cannot
 * become a way into a real club's data.
 */
export async function demoSignIn(email: string) {
  if (process.env.DEMO_SIGNIN !== "true") {
    throw new Error("demo sign-in is disabled");
  }

  // Goes through the ordinary password sign-in, so the demo exercises exactly
  // the path a real staff member uses rather than a privileged shortcut.
  const res = await signIn(email, process.env.DEMO_PASSWORD ?? "beaconhill-demo-2026");
  if (!res.ok) throw new Error(res.error ?? "demo sign-in failed");
  redirect("/app");
}

export async function demoEnabled() {
  return process.env.DEMO_SIGNIN === "true";
}
