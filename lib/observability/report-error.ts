/**
 * One shape for every error the app reports.
 *
 * Errors used to go out as `console.error("staff surface error", digest, err)`
 * on the client and as a bare thrown message on the server — three formats,
 * none of them greppable, none carrying where the error happened. This writes
 * a single JSON line so a log search for `"scope":"action.resolve_report"`
 * finds every failure of that action and nothing else.
 *
 * Vendor-free by design. Vercel captures stdout and stderr per invocation,
 * which is enough to find an error from a report id; a Sentry DSN (or any
 * other sink) can be added later behind this one function without touching a
 * caller. Until then there is nothing to configure and nothing to leak to.
 *
 * What is never in the line: request bodies, secrets, a member's report text.
 * `context` is for identifiers — a report id, a function name, a digest — and
 * the caller is responsible for keeping it that way. The stack is cut to its
 * first five frames, which locate the throw without reproducing every
 * framework frame beneath it.
 */
export interface ReportedError {
  level: "error";
  scope: string;
  message: string;
  name: string;
  stack?: string;
  context?: Record<string, unknown>;
  at: string;
}

const STACK_LINES = 5;

/** The line, without writing it — so a test can assert on the shape. */
export function describeError(
  scope: string,
  err: unknown,
  context?: Record<string, unknown>,
): ReportedError {
  const e = err instanceof Error ? err : null;
  const line: ReportedError = {
    level: "error",
    scope,
    message: e ? e.message : String(err),
    name: e ? e.name : typeof err,
    at: new Date().toISOString(),
  };
  const stack = e?.stack?.split("\n").slice(0, STACK_LINES).join("\n");
  if (stack) line.stack = stack;
  if (context && Object.keys(context).length > 0) line.context = context;
  return line;
}

/**
 * Report and return, never swallow: a caller that must fail still fails.
 * Typical use is `catch (e) { reportError(scope, e, ctx); throw e; }`.
 */
export function reportError(
  scope: string,
  err: unknown,
  context?: Record<string, unknown>,
): ReportedError {
  const line = describeError(scope, err, context);
  console.error(JSON.stringify(line));
  return line;
}
