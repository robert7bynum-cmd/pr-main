// lib/triage/keywords.ts
//
// Deterministic keyword pass for ProResponse triage.
//
// A member scans a QR code on a hole and types free text describing a
// problem. This module tries to classify that text CHEAPLY, with pattern
// matching only — no network, no model call. Anything it can't match with
// reasonable confidence returns null, and the caller escalates to the AI
// model. Category keys and their routing are defined in docs/taxonomy.md —
// this file must only ever emit keys from that list.
//
// Design principle: false "no match" is cheap (falls through to the model).
// False positive category/urgency is expensive (misroutes a real problem,
// or cries wolf on a safety alert). When in doubt, prefer null or a lower
// confidence score over a guess.

/**
 * The exact category keys from docs/taxonomy.md. Keep in sync with that
 * file and with `routing_rules.category` / `reports.category` in the DB.
 */
export type Category =
  | "pace_of_play"
  | "course_maintenance"
  | "cart_issue"
  | "pro_shop"
  | "f_and_b"
  | "restroom_facilities"
  | "practice_facility"
  | "safety"
  | "caddie_valet"
  | "needs_review";

export type Urgency = "low" | "normal" | "high" | "urgent";

export interface KeywordMatch {
  category: Category;
  urgency: Urgency;
  /** 0..1. High (0.9+) for unambiguous multi-word phrases, lower for single generic words. */
  confidence: number;
  /** The literal rule text (or pattern description) that fired, for debugging/audit trail. */
  matched: string;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Common typos golfers actually make thumb-typing on a phone, mid-round,
 * often one-handed while holding a club. Mapped whole-word so we don't
 * corrupt substrings inside other words. Keys and values are lowercase.
 */
const MISSPELLINGS: Record<string, string> = {
  // maintenance / course
  sprinkeler: "sprinkler",
  sprinker: "sprinkler",
  sprinklar: "sprinkler",
  bunkr: "bunker",
  bunkar: "bunker",
  buncker: "bunker",
  fairwai: "fairway",
  farway: "fairway",
  fairways: "fairway",
  greeen: "green",
  greens: "green",
  iriigation: "irrigation",
  irigation: "irrigation",
  // restrooms
  resturant: "restaurant",
  restroom: "restroom",
  restrooms: "restroom",
  bathroom: "restroom",
  bathrooms: "restroom",
  toliet: "toilet",
  toilette: "toilet",
  // cart
  gulf: "golf",
  cartt: "cart",
  carrt: "cart",
  // f&b
  bevrage: "beverage",
  beverege: "beverage",
  begerage: "beverage",
  consession: "concession",
  concesion: "concession",
  // pace of play
  slwo: "slow",
  slolw: "slow",
  // misc
  brocken: "broken",
  brokn: "broken",
  brokeen: "broken",
  missng: "missing",
  mising: "missing",
  emty: "empty",
  recieve: "receive",
  seperate: "separate",
  // safety
  lightening: "lightning",
  lightnig: "lightning",
  injurred: "injured",
  injurd: "injured",
};

/**
 * Lowercase, strip punctuation (keep letters/digits/spaces/apostrophes so
 * "won't" survives as a token boundary cue), collapse whitespace, and
 * repair known misspellings word-by-word.
 */
export function normalize(text: string): string {
  const lowered = text.toLowerCase();
  // Strip punctuation except apostrophes (so "won't" -> "wont" after we
  // drop the apostrophe too — simpler downstream matching). We drop
  // apostrophes entirely rather than treat them as boundaries.
  const stripped = lowered
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const words = stripped.split(" ").map((w) => MISSPELLINGS[w] ?? w);
  return words.join(" ");
}

// ---------------------------------------------------------------------------
// Rule model
// ---------------------------------------------------------------------------

interface Rule {
  /** Phrase to look for. Matched as a substring against normalized, space-padded text. */
  phrase: string;
  category: Category;
  urgency: Urgency;
  confidence: number;
  /**
   * If present, the rule is skipped when any of these phrases is also
   * present in the text — used to disambiguate words that are common to
   * several categories (e.g. bare "cart" vs "beverage cart").
   */
  exclude?: string[];
}

// Helper to count words in a phrase, used for "longer/more specific wins".
function wordCount(phrase: string): number {
  return phrase.trim().split(/\s+/).length;
}

// ---------------------------------------------------------------------------
// SAFETY — checked first, always. Urgent, and worth being conservative
// about false positives (see EXCLUDE list below for "killer hole" etc.)
// ---------------------------------------------------------------------------

const SAFETY_RULES: Rule[] = [
  // --- medical / injury ---
  { phrase: "someone is hurt", category: "safety", urgency: "urgent", confidence: 0.97 },
  { phrase: "someone is injured", category: "safety", urgency: "urgent", confidence: 0.97 },
  { phrase: "person is down", category: "safety", urgency: "urgent", confidence: 0.9 },
  { phrase: "player is down", category: "safety", urgency: "urgent", confidence: 0.9 },
  { phrase: "not breathing", category: "safety", urgency: "urgent", confidence: 0.98 },
  { phrase: "call 911", category: "safety", urgency: "urgent", confidence: 0.98 },
  { phrase: "need an ambulance", category: "safety", urgency: "urgent", confidence: 0.98 },
  { phrase: "hit by a ball", category: "safety", urgency: "urgent", confidence: 0.95 },
  { phrase: "hit by a cart", category: "safety", urgency: "urgent", confidence: 0.95 },
  { phrase: "hit in the head", category: "safety", urgency: "urgent", confidence: 0.95 },
  { phrase: "having a heart attack", category: "safety", urgency: "urgent", confidence: 0.98 },
  { phrase: "having a seizure", category: "safety", urgency: "urgent", confidence: 0.98 },
  { phrase: "passed out", category: "safety", urgency: "urgent", confidence: 0.92 },
  { phrase: "collapsed", category: "safety", urgency: "urgent", confidence: 0.9 },
  { phrase: "chest pain", category: "safety", urgency: "urgent", confidence: 0.93 },
  { phrase: "bleeding badly", category: "safety", urgency: "urgent", confidence: 0.93 },
  {
    phrase: "injured",
    category: "safety",
    urgency: "urgent",
    confidence: 0.85,
    // "this hole injured my score" / joking usage is rare enough that we
    // accept the small risk; no strong false-positive idiom found for
    // "injured" the way there is for "killer".
  },
  // NOTE: deliberately no bare "hurt" rule. "My back hurts from that
  // backswing" / "this hole hurts my score" are common non-emergency
  // phrasings, and the multi-word "someone is hurt" rule above already
  // covers the case the spec calls out explicitly. Bare "hurt" falls
  // through to the model, which has more context to judge intent.

  // --- weather ---
  { phrase: "lightning", category: "safety", urgency: "urgent", confidence: 0.97 },
  { phrase: "thunder and lightning", category: "safety", urgency: "urgent", confidence: 0.98 },
  { phrase: "tornado", category: "safety", urgency: "urgent", confidence: 0.97 },
  { phrase: "funnel cloud", category: "safety", urgency: "urgent", confidence: 0.96 },

  // --- cart / vehicle danger ---
  { phrase: "cart in the water", category: "safety", urgency: "urgent", confidence: 0.96 },
  { phrase: "cart went in the pond", category: "safety", urgency: "urgent", confidence: 0.96 },
  { phrase: "cart flipped", category: "safety", urgency: "urgent", confidence: 0.95 },
  { phrase: "cart rolled over", category: "safety", urgency: "urgent", confidence: 0.95 },
  { phrase: "cart is on fire", category: "safety", urgency: "urgent", confidence: 0.97 },

  // --- wildlife / stinging ---
  { phrase: "aggressive dog", category: "safety", urgency: "urgent", confidence: 0.85 },
  { phrase: "alligator on the course", category: "safety", urgency: "urgent", confidence: 0.93 },
  { phrase: "alligator", category: "safety", urgency: "urgent", confidence: 0.85 },
  { phrase: "rattlesnake", category: "safety", urgency: "urgent", confidence: 0.92 },
  // Spec calls out bare "snake" / "bees" explicitly as safety language.
  // Confidence is a bit under the multi-word phrases above (a wildlife
  // sighting is scarier reported than most, but still less specific than
  // "rattlesnake" or "swarm of bees"), and those longer phrases win
  // selection when present since they score more words.
  { phrase: "snake", category: "safety", urgency: "urgent", confidence: 0.75 },
  { phrase: "bee sting", category: "safety", urgency: "urgent", confidence: 0.85 },
  { phrase: "swarm of bees", category: "safety", urgency: "urgent", confidence: 0.9 },
  { phrase: "bees nest", category: "safety", urgency: "urgent", confidence: 0.85 },
  { phrase: "bees", category: "safety", urgency: "urgent", confidence: 0.72 },

  // --- fire / structural ---
  { phrase: "fire on the course", category: "safety", urgency: "urgent", confidence: 0.96 },
  { phrase: "brush fire", category: "safety", urgency: "urgent", confidence: 0.95 },
  { phrase: "downed power line", category: "safety", urgency: "urgent", confidence: 0.96 },
  { phrase: "power line down", category: "safety", urgency: "urgent", confidence: 0.96 },
];

// Idioms that LOOK like safety keywords but are ordinary golf talk. If any
// of these appear, we suppress a safety match unless a stronger, more
// specific safety phrase is also present (handled in matchKeywords).
const SAFETY_FALSE_POSITIVE_IDIOMS: string[] = [
  "killer hole",
  "killer course",
  "killer round",
  "this hole is a killer",
  "dying out here",
  "dead tired",
  "kill for a water",
  "kill for a drink",
  "dying for a hot dog",
  "my back is killing me",
  "killing me",
  "deadly rough",
  "brutal hole",
];

// ---------------------------------------------------------------------------
// PACE OF PLAY
// ---------------------------------------------------------------------------

const PACE_OF_PLAY_RULES: Rule[] = [
  { phrase: "group ahead is crawling", category: "pace_of_play", urgency: "normal", confidence: 0.95 },
  { phrase: "group ahead is slow", category: "pace_of_play", urgency: "normal", confidence: 0.95 },
  { phrase: "group in front is slow", category: "pace_of_play", urgency: "normal", confidence: 0.93 },
  { phrase: "foursome ahead is slow", category: "pace_of_play", urgency: "normal", confidence: 0.93 },
  { phrase: "slow play", category: "pace_of_play", urgency: "normal", confidence: 0.92 },
  { phrase: "slow group", category: "pace_of_play", urgency: "normal", confidence: 0.88 },
  { phrase: "pace of play", category: "pace_of_play", urgency: "normal", confidence: 0.92 },
  { phrase: "backed up on the tee", category: "pace_of_play", urgency: "normal", confidence: 0.88 },
  { phrase: "waiting on every shot", category: "pace_of_play", urgency: "normal", confidence: 0.85 },
  { phrase: "havent hit in 20 minutes", category: "pace_of_play", urgency: "normal", confidence: 0.8 },
  { phrase: "stuck behind a slow group", category: "pace_of_play", urgency: "normal", confidence: 0.93 },
  { phrase: "5 hour round", category: "pace_of_play", urgency: "low", confidence: 0.75 },
  { phrase: "marshal needed", category: "pace_of_play", urgency: "normal", confidence: 0.85 },
  { phrase: "need a marshal", category: "pace_of_play", urgency: "normal", confidence: 0.85 },
  { phrase: "ranger needed", category: "pace_of_play", urgency: "normal", confidence: 0.85 },
  { phrase: "course is backed up", category: "pace_of_play", urgency: "normal", confidence: 0.87 },
  { phrase: "long wait on every hole", category: "pace_of_play", urgency: "normal", confidence: 0.86 },
  { phrase: "no one behind or ahead moving", category: "pace_of_play", urgency: "low", confidence: 0.6 },
];

// ---------------------------------------------------------------------------
// COURSE MAINTENANCE
// ---------------------------------------------------------------------------

const COURSE_MAINTENANCE_RULES: Rule[] = [
  // irrigation / sprinklers
  { phrase: "sprinkler head is spraying the fairway", category: "course_maintenance", urgency: "normal", confidence: 0.96 },
  { phrase: "sprinkler is broken", category: "course_maintenance", urgency: "normal", confidence: 0.93 },
  { phrase: "sprinkler stuck on", category: "course_maintenance", urgency: "normal", confidence: 0.92 },
  { phrase: "sprinkler head broken", category: "course_maintenance", urgency: "normal", confidence: 0.93 },
  { phrase: "sprinkler", category: "course_maintenance", urgency: "normal", confidence: 0.75 },
  { phrase: "irrigation leak", category: "course_maintenance", urgency: "normal", confidence: 0.9 },

  // bunkers
  { phrase: "bunker rake missing", category: "course_maintenance", urgency: "low", confidence: 0.93 },
  { phrase: "no rake in the bunker", category: "course_maintenance", urgency: "low", confidence: 0.92 },
  { phrase: "bunker is a mess", category: "course_maintenance", urgency: "low", confidence: 0.85 },
  { phrase: "bunker needs raking", category: "course_maintenance", urgency: "low", confidence: 0.87 },
  { phrase: "bunker washed out", category: "course_maintenance", urgency: "normal", confidence: 0.88 },
  { phrase: "bunker", category: "course_maintenance", urgency: "low", confidence: 0.6 },

  // greens / fairway condition
  { phrase: "green is bumpy", category: "course_maintenance", urgency: "low", confidence: 0.85 },
  { phrase: "green needs mowing", category: "course_maintenance", urgency: "low", confidence: 0.85 },
  { phrase: "fairway is torn up", category: "course_maintenance", urgency: "normal", confidence: 0.85 },
  { phrase: "divots everywhere", category: "course_maintenance", urgency: "low", confidence: 0.8 },
  { phrase: "not repairing divots", category: "course_maintenance", urgency: "low", confidence: 0.75 },
  { phrase: "ball mark not fixed", category: "course_maintenance", urgency: "low", confidence: 0.7 },
  { phrase: "cup is broken", category: "course_maintenance", urgency: "normal", confidence: 0.85 },
  { phrase: "hole location", category: "course_maintenance", urgency: "low", confidence: 0.6 },
  { phrase: "flag stick is broken", category: "course_maintenance", urgency: "normal", confidence: 0.88 },
  { phrase: "pin sheet was wrong", category: "course_maintenance", urgency: "low", confidence: 0.9 },
  { phrase: "pin sheet is wrong", category: "course_maintenance", urgency: "low", confidence: 0.9 },

  // hazards / debris on course (non-safety obstruction)
  { phrase: "tree limb down across the path", category: "course_maintenance", urgency: "normal", confidence: 0.95 },
  { phrase: "tree limb down", category: "course_maintenance", urgency: "normal", confidence: 0.9 },
  { phrase: "branch down on the fairway", category: "course_maintenance", urgency: "normal", confidence: 0.9 },
  { phrase: "tree down", category: "course_maintenance", urgency: "normal", confidence: 0.85 },
  { phrase: "cart path is cracked", category: "course_maintenance", urgency: "low", confidence: 0.85 },
  { phrase: "cart path is flooded", category: "course_maintenance", urgency: "normal", confidence: 0.87 },
  { phrase: "standing water on the fairway", category: "course_maintenance", urgency: "normal", confidence: 0.87 },
  { phrase: "standing water", category: "course_maintenance", urgency: "normal", confidence: 0.7 },
  { phrase: "yardage marker missing", category: "course_maintenance", urgency: "low", confidence: 0.85 },
  { phrase: "tee marker missing", category: "course_maintenance", urgency: "low", confidence: 0.85 },
  { phrase: "sand trap", category: "course_maintenance", urgency: "low", confidence: 0.6 },
];

// ---------------------------------------------------------------------------
// CART ISSUE (fleet — riding carts, not beverage carts, see disambiguation)
// ---------------------------------------------------------------------------

const CART_ISSUE_RULES: Rule[] = [
  // Note: input is normalized (apostrophes stripped) before matching, so
  // "won't" becomes "wont" — write phrases here without apostrophes.
  { phrase: "cart wont start", category: "cart_issue", urgency: "normal", confidence: 0.95 },
  { phrase: "cart battery is dead", category: "cart_issue", urgency: "normal", confidence: 0.94 },
  { phrase: "cart is dead", category: "cart_issue", urgency: "normal", confidence: 0.85 },
  { phrase: "cart wont charge", category: "cart_issue", urgency: "normal", confidence: 0.9 },
  { phrase: "cart is stuck", category: "cart_issue", urgency: "normal", confidence: 0.85 },
  { phrase: "cart has a flat tire", category: "cart_issue", urgency: "normal", confidence: 0.93 },
  { phrase: "flat tire on the cart", category: "cart_issue", urgency: "normal", confidence: 0.93 },
  { phrase: "gps screen is broken", category: "cart_issue", urgency: "low", confidence: 0.88 },
  { phrase: "cart gps not working", category: "cart_issue", urgency: "low", confidence: 0.88 },
  { phrase: "cart brakes feel off", category: "cart_issue", urgency: "high", confidence: 0.85 },
  { phrase: "cart brakes dont work", category: "cart_issue", urgency: "high", confidence: 0.88 },
  { phrase: "no brakes", category: "cart_issue", urgency: "high", confidence: 0.7 },
  { phrase: "cart making a noise", category: "cart_issue", urgency: "low", confidence: 0.8 },
  { phrase: "cart is making a weird noise", category: "cart_issue", urgency: "low", confidence: 0.85 },
  { phrase: "cart seat is torn", category: "cart_issue", urgency: "low", confidence: 0.8 },
  { phrase: "cart roof is broken", category: "cart_issue", urgency: "low", confidence: 0.8 },
  { phrase: "cart charger not working", category: "cart_issue", urgency: "normal", confidence: 0.87 },
  {
    phrase: "cart",
    category: "cart_issue",
    urgency: "normal",
    confidence: 0.4,
    // Bare "cart" is deliberately low confidence and excluded below any
    // time "beverage"/"drink"/"snack" cart language is present, since
    // that's f_and_b, not fleet.
    exclude: [
      "beverage cart",
      "drink cart",
      "snack cart",
      "beverage cart hasnt come by",
      "cart girl",
      "cart hasnt come by",
    ],
  },
];

// ---------------------------------------------------------------------------
// PRO SHOP
// ---------------------------------------------------------------------------

const PRO_SHOP_RULES: Rule[] = [
  { phrase: "pro shop is closed", category: "pro_shop", urgency: "low", confidence: 0.9 },
  { phrase: "pro shop wont answer", category: "pro_shop", urgency: "normal", confidence: 0.85 },
  { phrase: "need new golf balls", category: "pro_shop", urgency: "low", confidence: 0.85 },
  { phrase: "need a glove", category: "pro_shop", urgency: "low", confidence: 0.8 },
  { phrase: "tee time was wrong", category: "pro_shop", urgency: "normal", confidence: 0.88 },
  { phrase: "tee time is wrong", category: "pro_shop", urgency: "normal", confidence: 0.88 },
  { phrase: "overcharged for", category: "pro_shop", urgency: "normal", confidence: 0.82 },
  { phrase: "billing issue", category: "pro_shop", urgency: "normal", confidence: 0.85 },
  { phrase: "charged twice", category: "pro_shop", urgency: "normal", confidence: 0.88 },
  { phrase: "rental clubs are wrong", category: "pro_shop", urgency: "normal", confidence: 0.85 },
  { phrase: "scorecard was wrong", category: "pro_shop", urgency: "low", confidence: 0.7 },
  { phrase: "cant check in", category: "pro_shop", urgency: "normal", confidence: 0.85 },
  { phrase: "check in line is long", category: "pro_shop", urgency: "low", confidence: 0.75 },
  { phrase: "merchandise", category: "pro_shop", urgency: "low", confidence: 0.55 },
];

// ---------------------------------------------------------------------------
// F&B — Food & Beverage
// ---------------------------------------------------------------------------

const F_AND_B_RULES: Rule[] = [
  { phrase: "beverage cart hasnt come by", category: "f_and_b", urgency: "low", confidence: 0.95 },
  { phrase: "beverage cart hasnt been by", category: "f_and_b", urgency: "low", confidence: 0.95 },
  { phrase: "beverage cart hasnt come around", category: "f_and_b", urgency: "low", confidence: 0.93 },
  { phrase: "havent seen the beverage cart", category: "f_and_b", urgency: "low", confidence: 0.9 },
  { phrase: "beverage cart", category: "f_and_b", urgency: "low", confidence: 0.85 },
  { phrase: "drink cart hasnt come by", category: "f_and_b", urgency: "low", confidence: 0.93 },
  { phrase: "drink cart", category: "f_and_b", urgency: "low", confidence: 0.8 },
  { phrase: "snack cart", category: "f_and_b", urgency: "low", confidence: 0.8 },
  { phrase: "cart girl", category: "f_and_b", urgency: "low", confidence: 0.75 },
  { phrase: "halfway house is closed", category: "f_and_b", urgency: "normal", confidence: 0.9 },
  { phrase: "halfway house has no food", category: "f_and_b", urgency: "low", confidence: 0.88 },
  { phrase: "halfway house", category: "f_and_b", urgency: "low", confidence: 0.75 },
  { phrase: "out of water at the turn", category: "f_and_b", urgency: "normal", confidence: 0.85 },
  { phrase: "water cooler is empty", category: "f_and_b", urgency: "normal", confidence: 0.85 },
  { phrase: "restaurant is slow", category: "f_and_b", urgency: "low", confidence: 0.82 },
  // Bare "restaurant" fallback — clubhouse dining complaints come in a lot
  // of shapes ("took forever", "was rude", "forgot our order") that don't
  // fit one canned phrase. Low-ish confidence, still clears the bar alone.
  { phrase: "restaurant", category: "f_and_b", urgency: "low", confidence: 0.6 },
  { phrase: "food was cold", category: "f_and_b", urgency: "low", confidence: 0.8 },
  { phrase: "order was wrong", category: "f_and_b", urgency: "low", confidence: 0.7 },
  { phrase: "bar is out of", category: "f_and_b", urgency: "low", confidence: 0.75 },
  { phrase: "out of beer", category: "f_and_b", urgency: "low", confidence: 0.75 },
  { phrase: "hot dogs are gone", category: "f_and_b", urgency: "low", confidence: 0.7 },
];

// ---------------------------------------------------------------------------
// RESTROOM FACILITIES
// ---------------------------------------------------------------------------

const RESTROOM_RULES: Rule[] = [
  { phrase: "no towels on the ball washer", category: "restroom_facilities", urgency: "low", confidence: 0.9 },
  // Ball washer is course-side hygiene, grouped with restroom facilities
  // per taxonomy routing (both -> maintenance).
  { phrase: "ball washer is empty", category: "restroom_facilities", urgency: "low", confidence: 0.85 },
  { phrase: "ball washer is broken", category: "restroom_facilities", urgency: "low", confidence: 0.85 },
  // Bare fallback: real complaints rarely land exactly on "is empty" /
  // "is broken" ("been empty for weeks", "out of towels on it") — this
  // two-word phrase still clears the bar on its own.
  { phrase: "ball washer", category: "restroom_facilities", urgency: "low", confidence: 0.65 },
  { phrase: "restroom out of paper", category: "restroom_facilities", urgency: "normal", confidence: 0.94 },
  { phrase: "restroom is out of toilet paper", category: "restroom_facilities", urgency: "normal", confidence: 0.95 },
  { phrase: "restroom is locked", category: "restroom_facilities", urgency: "normal", confidence: 0.9 },
  { phrase: "restroom is disgusting", category: "restroom_facilities", urgency: "normal", confidence: 0.85 },
  { phrase: "restroom has no soap", category: "restroom_facilities", urgency: "normal", confidence: 0.88 },
  { phrase: "no soap in the restroom", category: "restroom_facilities", urgency: "normal", confidence: 0.88 },
  { phrase: "restroom is out of order", category: "restroom_facilities", urgency: "normal", confidence: 0.9 },
  { phrase: "restroom", category: "restroom_facilities", urgency: "normal", confidence: 0.65 },
  { phrase: "porta potty", category: "restroom_facilities", urgency: "normal", confidence: 0.75 },
  { phrase: "port a john", category: "restroom_facilities", urgency: "normal", confidence: 0.75 },
  { phrase: "toilet wont flush", category: "restroom_facilities", urgency: "normal", confidence: 0.9 },
  { phrase: "toilet is clogged", category: "restroom_facilities", urgency: "normal", confidence: 0.9 },
  { phrase: "sink is broken", category: "restroom_facilities", urgency: "low", confidence: 0.65 },
];

// ---------------------------------------------------------------------------
// PRACTICE FACILITY
// ---------------------------------------------------------------------------

const PRACTICE_FACILITY_RULES: Rule[] = [
  { phrase: "range balls are out", category: "practice_facility", urgency: "low", confidence: 0.92 },
  { phrase: "out of range balls", category: "practice_facility", urgency: "low", confidence: 0.92 },
  { phrase: "range balls are terrible", category: "practice_facility", urgency: "low", confidence: 0.85 },
  { phrase: "driving range mats are torn", category: "practice_facility", urgency: "low", confidence: 0.88 },
  { phrase: "range mat is torn", category: "practice_facility", urgency: "low", confidence: 0.85 },
  { phrase: "putting green needs work", category: "practice_facility", urgency: "low", confidence: 0.82 },
  { phrase: "putting green is bumpy", category: "practice_facility", urgency: "low", confidence: 0.84 },
  { phrase: "chipping green", category: "practice_facility", urgency: "low", confidence: 0.65 },
  { phrase: "range token machine is broken", category: "practice_facility", urgency: "low", confidence: 0.87 },
  { phrase: "ball machine is broken", category: "practice_facility", urgency: "low", confidence: 0.8 },
  { phrase: "driving range", category: "practice_facility", urgency: "low", confidence: 0.6 },
  { phrase: "practice green", category: "practice_facility", urgency: "low", confidence: 0.6 },
];

// ---------------------------------------------------------------------------
// CADDIE / VALET
// ---------------------------------------------------------------------------

const CADDIE_VALET_RULES: Rule[] = [
  { phrase: "caddie never showed up", category: "caddie_valet", urgency: "normal", confidence: 0.92 },
  { phrase: "caddie didnt show", category: "caddie_valet", urgency: "normal", confidence: 0.92 },
  { phrase: "no caddie", category: "caddie_valet", urgency: "normal", confidence: 0.8 },
  { phrase: "caddie was rude", category: "caddie_valet", urgency: "normal", confidence: 0.88 },
  { phrase: "caddie gave bad advice", category: "caddie_valet", urgency: "low", confidence: 0.8 },
  { phrase: "valet lost my keys", category: "caddie_valet", urgency: "high", confidence: 0.9 },
  { phrase: "valet cant find my car", category: "caddie_valet", urgency: "high", confidence: 0.88 },
  { phrase: "valet is taking forever", category: "caddie_valet", urgency: "normal", confidence: 0.85 },
  { phrase: "no valet at the bag drop", category: "caddie_valet", urgency: "normal", confidence: 0.85 },
  { phrase: "bag drop", category: "caddie_valet", urgency: "low", confidence: 0.55 },
  { phrase: "valet", category: "caddie_valet", urgency: "normal", confidence: 0.62 },
  { phrase: "caddie", category: "caddie_valet", urgency: "normal", confidence: 0.62 },
];

// ---------------------------------------------------------------------------
// PLAY-INTERFERENCE ("someone is hitting into us") — routes to pace_of_play
// as an etiquette/safety-adjacent disruption of play, per taxonomy there is
// no dedicated "etiquette" category, and this is fundamentally about groups
// interacting on course -> pace_of_play. (Not safety: no injury/threat
// implied by being hit-into as a warning, distinct from "hit by a ball".)
// ---------------------------------------------------------------------------

const PLAY_INTERFERENCE_RULES: Rule[] = [
  { phrase: "someone is hitting into us", category: "pace_of_play", urgency: "high", confidence: 0.88 },
  { phrase: "group behind is hitting into us", category: "pace_of_play", urgency: "high", confidence: 0.9 },
  { phrase: "balls landing near us", category: "pace_of_play", urgency: "high", confidence: 0.8 },
  { phrase: "hitting into us", category: "pace_of_play", urgency: "high", confidence: 0.75 },
];

// ---------------------------------------------------------------------------
// Assemble the full rule table. Order within a category doesn't matter for
// selection (we score every rule and pick the best), but we keep SAFETY
// first for readability since it's the highest-stakes category.
// ---------------------------------------------------------------------------

const ALL_RULES: Rule[] = [
  ...SAFETY_RULES,
  ...PACE_OF_PLAY_RULES,
  ...COURSE_MAINTENANCE_RULES,
  ...CART_ISSUE_RULES,
  ...PRO_SHOP_RULES,
  ...F_AND_B_RULES,
  ...RESTROOM_RULES,
  ...PRACTICE_FACILITY_RULES,
  ...CADDIE_VALET_RULES,
  ...PLAY_INTERFERENCE_RULES,
];

// Minimum confidence we're willing to hand back as a real classification.
// Below this, we consider the signal too weak and return null so the model
// gets a shot instead of us guessing.
const ACCEPT_THRESHOLD = 0.6;

/**
 * Run the deterministic keyword pass. Returns the single best match, or
 * null if nothing clears the confidence bar — the caller should escalate
 * to the AI model in that case.
 */
export function matchKeywords(text: string): KeywordMatch | null {
  if (!text || !text.trim()) return null;

  const normalized = normalize(text);
  // Pad with spaces so every phrase search is a whole-word/whole-phrase
  // substring match (avoids "cart" matching inside "cartography", etc.,
  // though on this domain that's mostly theoretical — still correct).
  const padded = ` ${normalized} `;

  // 1. Safety idiom guard: if a known false-positive idiom is present,
  // note it so we can suppress weak safety rules that would otherwise
  // fire on a shared word (e.g. "killing me" containing "kill").
  const hasFalsePositiveIdiom = SAFETY_FALSE_POSITIVE_IDIOMS.some((idiom) =>
    padded.includes(` ${idiom} `)
  );

  let best: KeywordMatch | null = null;
  let bestWordCount = 0;

  for (const rule of ALL_RULES) {
    const needle = ` ${rule.phrase} `;
    if (!padded.includes(needle)) continue;

    // Disambiguation: skip this rule if an excluded phrase is present.
    if (rule.exclude && rule.exclude.some((ex) => padded.includes(` ${ex} `))) {
      continue;
    }

    // Safety idiom guard: only applies to the two intentionally-fuzzy
    // safety rules ("hurt" / generic words) — specific multi-word safety
    // phrases (e.g. "not breathing") always stand because they don't
    // collide with the idiom list.
    if (
      rule.category === "safety" &&
      hasFalsePositiveIdiom &&
      rule.confidence < 0.8
    ) {
      continue;
    }

    const words = wordCount(rule.phrase);
    const candidate: KeywordMatch = {
      category: rule.category,
      urgency: rule.urgency,
      confidence: rule.confidence,
      matched: rule.phrase,
    };

    // Selection precedence: more words (more specific) wins; ties broken
    // by higher confidence.
    if (
      !best ||
      words > bestWordCount ||
      (words === bestWordCount && candidate.confidence > best.confidence)
    ) {
      best = candidate;
      bestWordCount = words;
    }
  }

  if (!best || best.confidence < ACCEPT_THRESHOLD) return null;
  return best;
}
