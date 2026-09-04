import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { matchKeywords, type Category, type Urgency } from "./keywords";

/**
 * Model-backed triage — the second pass, and the only one that costs money.
 *
 * Cost discipline is structural, not incidental:
 *  - The free keyword pass runs first and resolves most reports. classifyReport
 *    only calls the API when that returns null, so spend scales with *unusual*
 *    reports rather than with volume.
 *  - Haiku, because this is short-text classification into ten fixed buckets.
 *  - A forced, strict tool call: the model returns a validated object and
 *    nothing else, so we never pay for prose or retry a malformed response.
 *  - max_tokens 200 caps the worst case; a classification needs a fraction.
 *  - Member text is truncated before sending — a pasted essay shouldn't be
 *    able to run up the bill.
 *
 * Roughly $0.001 per classified report, and most reports never reach here.
 */

const MODEL = "claude-haiku-4-5";
const MAX_BODY_CHARS = 1200;

export const CATEGORIES: Category[] = [
  "pace_of_play",
  "course_maintenance",
  "cart_issue",
  "pro_shop",
  "f_and_b",
  "restroom_facilities",
  "practice_facility",
  "safety",
  "caddie_valet",
  "needs_review",
];

export interface Classification {
  category: Category;
  urgency: Urgency;
  summary: string;
  confidence: number;
  source: "keyword" | "model";
  /** Only set for model classifications, for cost reporting. */
  usage?: { input: number; output: number };
}

const SYSTEM = `You triage issues reported by members at a private golf club.

Classify the report into exactly one category:
- pace_of_play: slow groups, waiting, backups, needing a marshal
- course_maintenance: turf, bunkers, irrigation, cart paths, trees, tee/course equipment
- cart_issue: a golf cart that won't start, is damaged, or has a dead battery
- pro_shop: merchandise, tee times, scorecards, pin sheets, club storage
- f_and_b: beverage cart, halfway house, restaurant, food or drink orders
- restroom_facilities: on-course or clubhouse restrooms, supplies, plumbing
- practice_facility: driving range, putting green, range balls, mats
- safety: injury, illness, lightning, animals, being hit by a ball, anything hazardous
- caddie_valet: caddies, bag drop, valet, starter
- needs_review: you genuinely cannot tell what is being reported

Urgency: urgent only for a real safety or injury situation. high for something
blocking play or worsening quickly. normal for most things. low for cosmetic
or minor items.

A member describing their own aches, soreness, or a bad round is not a safety
report. Only classify as safety when someone needs help or is in danger.
Complaints about another group's behaviour are pace_of_play or needs_review,
not safety, unless someone is being endangered.

Prefer needs_review over a confident guess. A misrouted report wastes a
crew member's trip; an unclear one simply gets a human's attention.
Set confidence below 0.6 when the report is ambiguous.

The summary is one short line for a staff member's phone. No pleasantries.`;

const TOOL: Anthropic.Tool = {
  name: "classify_report",
  description: "Record the classification of a member's report.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      category: { type: "string", enum: CATEGORIES },
      urgency: { type: "string", enum: ["low", "normal", "high", "urgent"] },
      summary: { type: "string", description: "One short line for a staff phone." },
      confidence: { type: "number", description: "0 to 1." },
    },
    required: ["category", "urgency", "summary", "confidence"],
  },
};

let client: Anthropic | null = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

/** Model pass. Call only when the keyword pass has already returned null. */
export async function classifyWithModel(body: string): Promise<Classification> {
  // Never spend a request on nothing. The API rejects empty content with a 400,
  // and an empty report is a human's problem regardless.
  const text = body.trim();
  if (text.length < 3) {
    return {
      category: "needs_review",
      urgency: "normal",
      summary: "Empty or unreadable report",
      confidence: 0,
      source: "model",
    };
  }

  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 200,
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: "tool", name: "classify_report" },
    messages: [{ role: "user", content: text.slice(0, MAX_BODY_CHARS) }],
  });

  const block = response.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    // strict + forced tool_choice makes this near-impossible, but a silently
    // dropped report is unacceptable — fall back to human attention.
    return {
      category: "needs_review",
      urgency: "normal",
      summary: body.slice(0, 80),
      confidence: 0,
      source: "model",
    };
  }

  const out = block.input as {
    category: Category;
    urgency: Urgency;
    summary: string;
    confidence: number;
  };

  return {
    category: out.confidence < 0.6 ? "needs_review" : out.category,
    urgency: out.urgency,
    summary: out.summary,
    confidence: out.confidence,
    source: "model",
    usage: {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
    },
  };
}

/**
 * Full triage. Keywords first (free), model only on fall-through.
 * This is the function the queue worker calls.
 */
export async function classifyReport(body: string): Promise<Classification> {
  const kw = matchKeywords(body);
  if (kw) {
    return {
      category: kw.category,
      urgency: kw.urgency,
      summary: body.slice(0, 80),
      confidence: kw.confidence,
      source: "keyword",
    };
  }
  return classifyWithModel(body);
}
