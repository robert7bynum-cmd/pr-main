import "server-only";

/**
 * A real Postgres for local development, running in-process via WASM.
 *
 * Supabase has not been provisioned yet, and this project has no Docker, so
 * without this the staff surfaces could only be built against hand-written
 * fixtures. Instead the app runs against the actual migrations and the actual
 * Beacon Hill seed — 220 reports with real event trails — which means what we
 * build is verified against the same SQL that will run in production.
 *
 * Development only. Guarded twice: the module refuses to load in production,
 * and every caller checks for Supabase credentials first.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";



// Survives Next's dev hot-reload; otherwise every edit reseeds 220 reports.
// Keyed by a fingerprint of the SQL so that editing a migration reboots the
// database instead of silently serving the old schema — that trap cost a
// debugging cycle: a newly added function appeared not to exist.
const globalForDb = globalThis as unknown as {
  __devDb?: Promise<PGlite>;
  __devDbKey?: string;
};

function sqlFingerprint(): string {
  const dir = join(process.cwd(), "supabase/migrations");
  const parts = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => `${f}:${statSync(join(dir, f)).mtimeMs}`);
  parts.push(`seed:${statSync(join(process.cwd(), "supabase/seed.sql")).mtimeMs}`);
  return parts.join("|");
}

async function boot(): Promise<PGlite> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto");

  const db = await PGlite.create({ extensions: { pgcrypto } });
  // Shared with the test scripts so the app and the suites never diverge.
  await db.exec(readFileSync(join(process.cwd(), "supabase/test-bootstrap.sql"), "utf8"));

  const dir = join(process.cwd(), "supabase/migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(dir, f), "utf8"));
  }
  await db.exec(readFileSync(join(process.cwd(), "supabase/seed.sql"), "utf8"));

  console.log("[dev-db] Beacon Hill seed loaded (in-process Postgres)");
  return db;
}

export function devDb(): Promise<PGlite> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("dev-db must never run in production");
  }
  const key = sqlFingerprint();
  if (globalForDb.__devDbKey !== key || !globalForDb.__devDb) {
    if (globalForDb.__devDb) console.log("[dev-db] SQL changed — rebuilding");
    globalForDb.__devDbKey = key;
    globalForDb.__devDb = boot();
  }
  return globalForDb.__devDb;
}

/** True when we have no real database and should fall back to the dev one. */
export function usingDevDb() {
  return !process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NODE_ENV !== "production";
}
