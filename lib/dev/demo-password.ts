/**
 * The seeded Beacon Hill personas' password, from the environment only.
 *
 * Every suite used to write `process.env.DEMO_PASSWORD ?? "beaconhill-demo-2026"`.
 * While one-click demo sign-in existed that literal was a convenience. The
 * moment it was removed, it became the actual way into a live club's accounts —
 * published in the repository, in five files. A default that is committed is
 * not a default; it is a shared secret with extra steps.
 *
 * Exits rather than throws: a suite that cannot authenticate has nothing to
 * say, and a clear line beats a stack trace.
 */
export function requireDemoPassword(): string {
  const pw = process.env.DEMO_PASSWORD;
  if (!pw) {
    console.log(
      "DEMO_PASSWORD is not set. Add it to .env.local — it is the password for " +
        "the seeded demo staff accounts, and is deliberately not in the repo.",
    );
    process.exit(2);
  }
  return pw;
}
