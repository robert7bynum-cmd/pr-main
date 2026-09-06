// lib/triage/load-rules.ts
//
// Loads the keyword rules from their source of truth (lib/triage/keywords.ts)
// into the tables the SQL matcher reads. One loader for every database: the
// live project (scripts/seed-keywords.mts, over pg) and the throwaway PGlite
// the eval suites boot. The seed script used to regex-parse the TypeScript
// source to get at MISSPELLINGS and the idiom list because they were not
// exported; now they are, and this imports them like anything else.
//
// Plain inserts on purpose. The previous loader used `on conflict do nothing`,
// so when "tree down" appeared twice (urgency normal, then high) the first
// silently won and the count came back one short of the source with nobody
// the wiser. A duplicate is now an error before a single row is written.

import { ALL_RULES, MISSPELLINGS, SAFETY_FALSE_POSITIVE_IDIOMS } from "./keywords";

/** The subset of a database client this needs. Both `pg.Client` and `PGlite` satisfy it. */
export interface RuleDb {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface RuleCounts {
  rules: number;
  misspellings: number;
  idioms: number;
}

/**
 * Throws if the rule data cannot be loaded faithfully: a duplicate
 * (phrase, category) — the table's unique key — or an empty misspelling or
 * idiom list. The idiom list is what stops "this hole is a killer" paging
 * management; an empty one would load without complaint and every weak
 * safety rule would fire on ordinary golf talk.
 */
export function assertRulesConsistent(): void {
  const seen = new Map<string, number>();
  const dupes: string[] = [];
  ALL_RULES.forEach((r, i) => {
    const key = `${r.phrase} | ${r.category}`;
    const first = seen.get(key);
    if (first === undefined) seen.set(key, i);
    else dupes.push(`"${r.phrase}" (${r.category}) at ALL_RULES[${first}] and [${i}]`);
  });
  if (dupes.length) {
    throw new Error(`duplicate (phrase, category) in ALL_RULES — the loader would have to pick one:\n  ${dupes.join("\n  ")}`);
  }
  if (Object.keys(MISSPELLINGS).length === 0) {
    throw new Error("MISSPELLINGS is empty — every typo'd report would fall through to the model");
  }
  if (SAFETY_FALSE_POSITIVE_IDIOMS.length === 0) {
    throw new Error("SAFETY_FALSE_POSITIVE_IDIOMS is empty — these prevent false urgent alerts");
  }
  const idiomSet = new Set(SAFETY_FALSE_POSITIVE_IDIOMS);
  if (idiomSet.size !== SAFETY_FALSE_POSITIVE_IDIOMS.length) {
    throw new Error("SAFETY_FALSE_POSITIVE_IDIOMS contains a duplicate phrase");
  }
}

/**
 * Replaces the contents of triage_keywords, triage_misspellings and
 * triage_safety_idioms with the exports of lib/triage/keywords.ts, in one
 * transaction. Returns what the tables hold afterwards — counted from the
 * database, not from the arrays — and throws if that differs from the source.
 */
export async function loadRules(db: RuleDb): Promise<RuleCounts> {
  assertRulesConsistent();

  await db.query("begin");
  try {
    await db.query("delete from triage_keywords");
    await db.query("delete from triage_misspellings");
    await db.query("delete from triage_safety_idioms");

    for (const r of ALL_RULES) {
      // `exclude` travels as JSON and is unpacked in SQL, so the array is
      // serialised the same way whichever driver is underneath.
      await db.query(
        `insert into triage_keywords (phrase, category, urgency, confidence, exclude)
         values ($1, $2, $3::report_urgency, $4::numeric,
                 array(select jsonb_array_elements_text($5::jsonb)))`,
        [r.phrase, r.category, r.urgency, r.confidence, JSON.stringify(r.exclude ?? [])],
      );
    }
    for (const [wrong, right] of Object.entries(MISSPELLINGS)) {
      await db.query(`insert into triage_misspellings (wrong, right_word) values ($1, $2)`, [wrong, right]);
    }
    for (const phrase of SAFETY_FALSE_POSITIVE_IDIOMS) {
      await db.query(`insert into triage_safety_idioms (phrase) values ($1)`, [phrase]);
    }

    await db.query("commit");
  } catch (e) {
    await db.query("rollback");
    throw e;
  }

  const { rows } = await db.query(`select
    (select count(*)::int from triage_keywords)      as rules,
    (select count(*)::int from triage_misspellings)  as misspellings,
    (select count(*)::int from triage_safety_idioms) as idioms`);
  const counts = rows[0] as RuleCounts;

  const expected: RuleCounts = {
    rules: ALL_RULES.length,
    misspellings: Object.keys(MISSPELLINGS).length,
    idioms: SAFETY_FALSE_POSITIVE_IDIOMS.length,
  };
  for (const k of Object.keys(expected) as (keyof RuleCounts)[]) {
    if (counts[k] !== expected[k]) {
      throw new Error(`loaded ${counts[k]} ${k} but the source has ${expected[k]}`);
    }
  }
  return counts;
}
