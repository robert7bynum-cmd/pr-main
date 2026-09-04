// lib/triage/fixtures.ts
//
// Regression suite for the keyword triage pass in lib/triage/keywords.ts.
// Written the way real members actually type on a phone between shots:
// lowercase, terse, typo'd, sometimes one word, sometimes a run-on
// sentence. Every category in docs/taxonomy.md has coverage.
//
// A subset (see `note`) is expected to fall through to null in
// matchKeywords — these are genuinely ambiguous/novel phrasings that
// should escalate to the AI model. Their expectedCategory is the category
// a human reviewer would eventually assign, not what the keyword pass
// should produce.

import type { Category, Urgency } from "./keywords";

export interface TriageFixture {
  text: string;
  expectedCategory: Category;
  expectedUrgency?: Urgency;
  note?: string;
}

export const TRIAGE_FIXTURES: TriageFixture[] = [
  // ---------------------------------------------------------------------
  // pace_of_play
  // ---------------------------------------------------------------------
  { text: "group ahead is crawling we havent hit in 20 min", expectedCategory: "pace_of_play", expectedUrgency: "normal" },
  { text: "stuck behind a slow group on 6", expectedCategory: "pace_of_play", expectedUrgency: "normal" },
  { text: "can we get a marshal needed on hole 9 nobody is moving", expectedCategory: "pace_of_play", expectedUrgency: "normal" },
  { text: "someone is hitting into us from behind on 14", expectedCategory: "pace_of_play", expectedUrgency: "high" },
  { text: "pace of play is brutal today", expectedCategory: "pace_of_play", expectedUrgency: "normal" },

  // ---------------------------------------------------------------------
  // course_maintenance
  // ---------------------------------------------------------------------
  { text: "sprinkeler head is spraying the fairway on 7 soaked my pants", expectedCategory: "course_maintenance", expectedUrgency: "normal" },
  { text: "bunker rake missing on 3", expectedCategory: "course_maintenance", expectedUrgency: "low" },
  { text: "tree limb down across the path on 11 cant get cart through", expectedCategory: "course_maintenance", expectedUrgency: "normal" },
  { text: "pin sheet was wrong for hole 4 pin is actually front right", expectedCategory: "course_maintenance", expectedUrgency: "low" },
  { text: "standing water on the fairway 2 whole fairway is flooded", expectedCategory: "course_maintenance", expectedUrgency: "normal" },
  { text: "irigation leak by 15 tee box water everywhere", expectedCategory: "course_maintenance", expectedUrgency: "normal" },

  // ---------------------------------------------------------------------
  // cart_issue
  // ---------------------------------------------------------------------
  { text: "cart wont start at all on hole 2", expectedCategory: "cart_issue", expectedUrgency: "normal" },
  { text: "cart battery is dead stuck out here", expectedCategory: "cart_issue", expectedUrgency: "normal" },
  { text: "cart brakes dont work this is scary going downhill", expectedCategory: "cart_issue", expectedUrgency: "high" },
  { text: "flat tire on the cart cant drive it", expectedCategory: "cart_issue", expectedUrgency: "normal" },

  // ---------------------------------------------------------------------
  // pro_shop
  // ---------------------------------------------------------------------
  { text: "pro shop is closed and we need tees", expectedCategory: "pro_shop", expectedUrgency: "low" },
  { text: "got charged twice for our green fees", expectedCategory: "pro_shop", expectedUrgency: "normal" },
  { text: "tee time was wrong when we checked in said 2pm not 1pm", expectedCategory: "pro_shop", expectedUrgency: "normal" },
  { text: "rental clubs are wrong set, asked for stiff got regular", expectedCategory: "pro_shop", expectedUrgency: "normal" },

  // ---------------------------------------------------------------------
  // f_and_b
  // ---------------------------------------------------------------------
  { text: "beverage cart hasnt come by all day were dying of thirst", expectedCategory: "f_and_b", expectedUrgency: "low" },
  { text: "halfway house is closed and we wanted a hot dog", expectedCategory: "f_and_b", expectedUrgency: "normal" },
  { text: "resturant is slow, been waiting 40 min for our order", expectedCategory: "f_and_b", expectedUrgency: "low" },
  { text: "drink cart never made it to the back nine", expectedCategory: "f_and_b", expectedUrgency: "low" },
  { text: "water cooler is empty on 10 tee its hot out here", expectedCategory: "f_and_b", expectedUrgency: "normal" },

  // ---------------------------------------------------------------------
  // restroom_facilities
  // ---------------------------------------------------------------------
  { text: "restroom out of paper on the back nine", expectedCategory: "restroom_facilities", expectedUrgency: "normal" },
  { text: "no towels on the ball washer by 6 tee", expectedCategory: "restroom_facilities", expectedUrgency: "low" },
  { text: "restroom by 13 is locked cant get in", expectedCategory: "restroom_facilities", expectedUrgency: "normal" },
  { text: "toliet wont flush in the mens room", expectedCategory: "restroom_facilities", expectedUrgency: "normal" },

  // ---------------------------------------------------------------------
  // practice_facility
  // ---------------------------------------------------------------------
  { text: "range balls are out at station 4 nothing left in the basket", expectedCategory: "practice_facility", expectedUrgency: "low" },
  { text: "driving range mats are torn up by the 100 yard sign", expectedCategory: "practice_facility", expectedUrgency: "low" },
  { text: "putting green is bumpy near the flag on the left side", expectedCategory: "practice_facility", expectedUrgency: "low" },
  { text: "range token machine is broken wont take my card", expectedCategory: "practice_facility", expectedUrgency: "low" },

  // ---------------------------------------------------------------------
  // caddie_valet
  // ---------------------------------------------------------------------
  { text: "caddie never showed up for our 8am group", expectedCategory: "caddie_valet", expectedUrgency: "normal" },
  { text: "valet lost my keys and i need to leave", expectedCategory: "caddie_valet", expectedUrgency: "high" },
  { text: "valet is taking forever we have been waiting 20 min for the car", expectedCategory: "caddie_valet", expectedUrgency: "normal" },
  { text: "no valet at the bag drop this morning had to carry everything in", expectedCategory: "caddie_valet", expectedUrgency: "normal" },

  // ---------------------------------------------------------------------
  // safety — true positives, urgent
  // ---------------------------------------------------------------------
  { text: "someone is hurt on hole 7 please send help", expectedCategory: "safety", expectedUrgency: "urgent" },
  { text: "cart in the water at the pond on 16 driver is stuck", expectedCategory: "safety", expectedUrgency: "urgent" },
  { text: "guy got hit by a ball in the head on 4 tee", expectedCategory: "safety", expectedUrgency: "urgent" },
  { text: "lightening just struck near the 9th green everyone is running", expectedCategory: "safety", expectedUrgency: "urgent" },
  { text: "my dad is having a heart attack on the cart path", expectedCategory: "safety", expectedUrgency: "urgent" },
  { text: "my buddy just collapsed on the green cant wake him up", expectedCategory: "safety", expectedUrgency: "urgent" },

  // ---------------------------------------------------------------------
  // safety — near misses that must NOT be classified urgent
  // ---------------------------------------------------------------------
  {
    text: "this hole is a killer, 3 bunkers and water everywhere",
    expectedCategory: "course_maintenance",
    note: "safety-sounding idiom (killer hole) — should NOT fire safety/urgent; falls through, model should route by the bunker/water content or needs_review",
  },
  {
    text: "my back is killing me after that tee shot on 8",
    expectedCategory: "needs_review",
    note: "idiomatic 'killing me' about soreness, not an emergency — must not match safety; genuinely ambiguous where it routes so model should decide",
  },
  {
    text: "saw a little garter snake near the cart path on 6, kind of cool actually",
    expectedCategory: "safety",
    expectedUrgency: "urgent",
    note: "KNOWN TENSION, flagged rather than silently resolved: the spec explicitly requires bare 'snake' to map to safety/urgent, but this is exactly the kind of harmless sighting ('kind of cool actually') that a human would never page management for. The keyword pass matches the letter of the spec here (urgent) even though it's arguably a false positive in spirit — same category of risk as 'killer hole' but for an item the spec named directly as a required match, so it wasn't suppressed the way the idiom list suppresses 'killer'/'brutal'/'deadly'.",
  },
  {
    text: "dying for a hot dog and a coke at the turn",
    expectedCategory: "f_and_b",
    note: "'dying for' is idiomatic hunger, not medical — must not match safety; keyword pass should fall through since no f_and_b phrase like halfway house/beverage cart is present either",
  },
  {
    text: "brutal hole, that green is deadly with the slope today",
    expectedCategory: "course_maintenance",
    note: "'deadly'/'brutal' describing difficulty, not danger — must not match safety",
  },
  { text: "kids stepped on a bees nest by the 3rd tee everyone got stung running away", expectedCategory: "safety", expectedUrgency: "urgent" },

  // ---------------------------------------------------------------------
  // expected to fall through to the model (no confident keyword match)
  // ---------------------------------------------------------------------
  {
    text: "hole 12 is a disaster today",
    expectedCategory: "needs_review",
    note: "too vague to route — could be maintenance, pace, or a complaint about difficulty; no keyword phrase matches",
  },
  {
    text: "this is unacceptable, third time this month",
    expectedCategory: "needs_review",
    note: "pure complaint with no subject-matter keywords at all; needs the model (or a human) to infer what 'this' refers to",
  },
  {
    text: "not happy with how today went honestly",
    expectedCategory: "needs_review",
    note: "no actionable keywords, tone-only feedback; model should route or a human should follow up",
  },
  {
    text: "can someone come look at 9 asap",
    expectedCategory: "needs_review",
    note: "urgent-sounding ('asap') but zero subject matter — could be anything from a maintenance issue to a safety concern; deliberately withheld from keyword match so model asks for detail or a human follows up",
  },
  {
    text: "the thing by the tee on 5 is acting up again",
    expectedCategory: "needs_review",
    note: "'the thing' is not identifiable — ball washer? sprinkler? yardage marker? Ambiguous enough that guessing would misroute",
  },
  {
    text: "weird smell coming from somewhere near the clubhouse",
    expectedCategory: "needs_review",
    note: "novel phrasing not covered by any category's keyword rules; plausibly f_and_b (kitchen) or maintenance, but nothing in text disambiguates",
  },
  {
    text: "app wont let me submit my scorecard after the round",
    expectedCategory: "pro_shop",
    note: "app/tech issue, not covered by any keyword rule; closest human routing is pro_shop (scoring/handicap admin) but the keyword pass has nothing to key off",
  },
  {
    text: "the guy in the cart next to us keeps yelling at everyone",
    expectedCategory: "needs_review",
    note: "behavioral complaint about another member — no keyword rule covers interpersonal conduct; needs human judgment on severity",
  },
  {
    text: "not sure who to tell but the new grip on the loaner putter feels off",
    expectedCategory: "pro_shop",
    note: "rare, mild equipment complaint that doesn't hit any pro_shop phrase (no 'rental clubs', no 'need a glove'); intentionally left unmatched",
  },
  {
    text: "starter sent us off 8 minutes late and now we are rushing",
    expectedCategory: "pace_of_play",
    note: "plausible pace_of_play root cause but phrased around 'starter', a word with no rule; left for the model rather than guessing",
  },

  // ---------------------------------------------------------------------
  // multiple problems mentioned at once — matcher should return its best
  // single guess (most specific phrase), not attempt multi-label output
  // ---------------------------------------------------------------------
  {
    text: "bunker rake missing on 3 and also the beverage cart hasnt come by since we teed off",
    expectedCategory: "f_and_b",
    expectedUrgency: "low",
    note: "two issues mentioned; 'beverage cart hasnt come by' (5 words) is longer/more specific than 'bunker rake missing' (3 words), so per the longer-phrase-wins rule f_and_b correctly wins the tiebreak even though it's arguably the less urgent of the two real-world problems — a case where the deterministic rule is right by its own logic but a human might reasonably reorder priority",
  },
  {
    text: "cart wont start and the restroom by the tee is locked too",
    expectedCategory: "cart_issue",
    expectedUrgency: "normal",
    note: "two issues; 'cart wont start' (3 words) vs 'restroom is locked' does not literally appear (text says 'restroom ... is locked too', not the exact phrase) so only cart_issue should fire",
  },
  {
    text: "someone is hurt by the cart barn and the cart wont start either",
    expectedCategory: "safety",
    expectedUrgency: "urgent",
    note: "two issues; safety must win regardless of word-count tiebreak against cart_issue given the stakes — 'someone is hurt' (3 words) does out-word 'cart wont start' (3 words) on confidence tiebreak (0.97 vs 0.95) so this should hold without special-casing",
  },
  {
    text: "range balls are out and also no rake in the bunker by the practice green",
    expectedCategory: "course_maintenance",
    expectedUrgency: "low",
    note: "two issues both practice-adjacent; 'no rake in the bunker' (5 words) is longer/more specific than 'range balls are out' (4 words) so course_maintenance wins the tiebreak — a defensible but not obviously 'more correct' outcome than practice_facility, since a human could argue either department owns a bunker next to the practice green",
  },

  // ---------------------------------------------------------------------
  // single-word / terse inputs
  // ---------------------------------------------------------------------
  { text: "bunker", expectedCategory: "course_maintenance", expectedUrgency: "low" },
  { text: "lightning", expectedCategory: "safety", expectedUrgency: "urgent" },
  { text: "caddie", expectedCategory: "caddie_valet", expectedUrgency: "normal" },
  { text: "restroom", expectedCategory: "restroom_facilities", expectedUrgency: "normal" },

  // ---------------------------------------------------------------------
  // misspellings golfers actually type
  // ---------------------------------------------------------------------
  { text: "sprinkeler is soaking the fairway on 7", expectedCategory: "course_maintenance", expectedUrgency: "normal" },
  { text: "resturant took forever for our food order", expectedCategory: "f_and_b", expectedUrgency: "low" },
  { text: "no rake in the bunkr on 2", expectedCategory: "course_maintenance", expectedUrgency: "low" },
  { text: "cartt battery is dead on hole 5", expectedCategory: "cart_issue", expectedUrgency: "normal" },

  // ---------------------------------------------------------------------
  // rambling, realistic full sentences
  // ---------------------------------------------------------------------
  {
    text: "hey so this is kind of annoying but weve been sitting on the tee box at 6 for like fifteen minutes because the group ahead is crawling and nobody is even looking back at us",
    expectedCategory: "pace_of_play",
    expectedUrgency: "normal",
  },
  {
    text: "just a heads up the ball washer by 11 has been empty and out of towels for like two weeks now, not a big deal but figured id mention it",
    expectedCategory: "restroom_facilities",
    expectedUrgency: "low",
  },
  {
    text: "our cart is making a weird noise since the front nine, awful grinding sound, kind of worried its going to just die on us out here",
    expectedCategory: "cart_issue",
    expectedUrgency: "low",
  },

  // ---------------------------------------------------------------------
  // extra coverage: needs_review as an explicit safety-net destination
  // ---------------------------------------------------------------------
  {
    text: "asdkfj not sure how to describe this one",
    expectedCategory: "needs_review",
    note: "garbage/unintelligible input — must fall through cleanly rather than false-matching any rule",
  },
  {
    text: "",
    expectedCategory: "needs_review",
    note: "empty input — matchKeywords must return null, not throw",
  },
];
