/**
 * docs/api.md, generated from the migrations.
 *
 * The backend is already RPC-shaped: every staff action is a SECURITY DEFINER
 * function called through supabase-js, reads go through a handful of views.
 * That is a fine contract for a mobile team — but until now the only copy of
 * it was the migrations folder, which nobody building an iOS app should have to
 * read. So the contract is derived from the one place it is true: a throwaway
 * Postgres with every migration applied, asked which functions `anon` and
 * `authenticated` may actually execute, with what signature, and which views
 * they may read. Nothing here is typed by hand except the auth flows, which
 * live in Supabase Auth and the Next app rather than in SQL.
 *
 * Generated, not maintained: `npm run test:api-doc` regenerates it and fails
 * the offline suite if the committed file differs. A function added without
 * re-running this is a failing build, not a stale page.
 *
 *   npm run api:doc                 writes docs/api.md
 *   tsx scripts/api-doc.mts <path>  writes somewhere else (the drift test)
 */
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const OUTPUT = "docs/api.md";
const MIGRATIONS = "supabase/migrations";

interface Fn {
  name: string;
  args: string;
  returns: string;
  anon: boolean;
  authenticated: boolean;
  service_role: boolean;
}
interface View { name: string; invoker: boolean }
interface Column { name: string; type: string }

/**
 * The migration that (last) defined a function, and the first paragraph of
 * that file's leading `--` header. The header explains the migration, which is
 * the closest thing to "why does this function exist" that is written down;
 * the file name is given beside it so a reader can go and read the rest.
 */
function definedIn(files: string[], name: string): { file: string; why: string } | null {
  const re = new RegExp(`function\\s+(public\\.)?${name}\\s*\\(`, "i");
  for (const f of [...files].reverse()) {
    const text = readFileSync(join(MIGRATIONS, f), "utf8");
    if (!re.test(text)) continue;
    const para: string[] = [];
    for (const line of text.split("\n")) {
      if (!line.startsWith("--")) break;
      const body = line.replace(/^--\s?/, "");
      if (body.trim() === "") break;
      para.push(body.trim());
    }
    return { file: f, why: para.join(" ") };
  }
  return null;
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/**
 * The parts of the contract that are not SQL: how a session comes to exist.
 * Written by hand because they live in Supabase Auth and app/actions, and
 * kept here rather than in the doc so the doc stays a pure build artefact.
 */
const AUTH_FLOWS = `## Authentication

Every call below is made with supabase-js against the project URL and the
publishable (anon) key. Staff calls carry the signed-in user's JWT, which
supabase-js attaches once a session exists. There is no self-service sign-up:
a manager invites; the person signs in. \`anon\` is the member, scanning a
placard; \`authenticated\` is staff.

Functions raise rather than return an error shape. PostgREST turns a raised
exception into an HTTP 400 whose body carries the message; \`42501\` is "you
are not allowed to", \`22023\` is "that input is wrong". One message is used for
every failed sign-in and every unknown address, so nothing can be enumerated
(CLAUDE.md, CC6).

### Password sign-in

1. \`supabase.auth.signInWithPassword({ email, password })\`. On any failure
   show "That email and password don't match." — never distinguish wrong
   password from no such account.
2. Call \`claim_profile()\` immediately. It links the auth user to the profile
   the manager created and returns \`{ claimed, course_slug, full_name }\`.
   \`claimed = false\` with a valid session means the person has credentials
   but no invitation at any club: show "you are not on staff here", not an
   error, and sign out.
3. \`me()\` for the signed-in person's profile, role, club and \`account_kind\`
   (\`station\` is a shared login such as the pro shop counter: it hands work
   over with \`assign_report\` rather than claiming it).
4. If \`user.user_metadata.must_change_password\` is true, require a new
   password before anything else:
   \`supabase.auth.updateUser({ password, data: { must_change_password: false } })\`.

### Invitation (how an account gets its first session)

A manager calls \`create_staff_invite(p_email)\` and receives an opaque token,
valid seven days, which is sent to the person as
\`https://<web host>/join?t=<token>\`. Opening the page spends nothing; pressing
its button calls a server action that, with the service role, runs
\`redeem_staff_invite(p_token)\` (returns the email, marks the token used), then
\`auth.admin.generateLink({ type: 'recovery', email })\` for a \`hashed_token\`,
and the browser exchanges that with
\`supabase.auth.verifyOtp({ token_hash, type: 'recovery' })\`. The session now
exists; \`claim_profile()\` runs and the person is sent to set a password.

\`peek_staff_invite\` and \`redeem_staff_invite\` are service-role only and do not
appear in the tables below. A native app therefore cannot redeem an
invitation on its own: open the \`/join\` link in the system browser, or have
the person set a password there first and then sign in with it.

### Forgot password

\`supabase.auth.resetPasswordForEmail(email, { redirectTo })\`. Whatever the
result, tell the person "If that address is on staff here, a sign-in link is on
its way." The link lands on \`/auth/callback\`, which calls \`verifyOtp\` and then
\`/account/password\`. The built-in mailer allows roughly one message a minute
per address; a rate-limit reply is "sent moments ago, check your inbox".

### Push (native)

On launch, and whenever the OS issues a new token, call
\`register_device(p_platform, p_token, p_app_version)\`; it is an upsert on the
token and resets the device's failure count. On sign-out call
\`unregister_device(p_token)\` before \`supabase.auth.signOut()\`.

What arrives: FCM \`notification { title, body }\` plus
\`data { url, urgency, tag }\`; APNs \`aps.alert { title, body }\`, \`sound\`,
\`interruption-level\` (\`time-sensitive\` when urgency is \`urgent\`, else
\`active\`), and \`url\`, \`tag\` beside \`aps\`. \`url\` is a path on the web app
(\`/app/report/<id>\`); \`tag\` is the report id, for collapsing repeats.

### Reads and realtime

The queue is \`my_queue\` (your departments, plus anything handed to you) and
\`staff_queue\` (the whole club); read them with \`.from('my_queue').select()\`.
They are \`security_invoker\` views over RLS-protected tables, so they return
only the caller's club. For live updates subscribe to \`postgres_changes\` on
\`public.reports\` filtered by \`course_id\` and re-read the view on any event.
`;

export async function generateApiDoc(): Promise<string> {
  const db = await PGlite.create({ extensions: { pgcrypto } });
  await db.exec(readFileSync("supabase/test-bootstrap.sql", "utf8"));
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) await db.exec(readFileSync(join(MIGRATIONS, f), "utf8"));

  const { rows: fns } = await db.query<Fn>(`
    select p.proname as name,
           pg_get_function_arguments(p.oid) as args,
           pg_get_function_result(p.oid) as returns,
           has_function_privilege('anon', p.oid, 'execute') as anon,
           has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
           has_function_privilege('service_role', p.oid, 'execute') as service_role
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
       and p.prorettype <> 'trigger'::regtype
       -- Extension members (pgcrypto lands in public here; Supabase keeps it
       -- in the extensions schema) are not this product's API.
       and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
       and (has_function_privilege('anon', p.oid, 'execute')
            or has_function_privilege('authenticated', p.oid, 'execute'))
     order by p.proname, pg_get_function_arguments(p.oid)`);

  const { rows: views } = await db.query<View>(`
    select c.relname as name,
           coalesce('security_invoker=on' = any(c.reloptions)
                    or 'security_invoker=true' = any(c.reloptions), false) as invoker
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'v'
       and has_table_privilege('authenticated', c.oid, 'select')
     order by c.relname`);

  const columnsOf = async (view: string): Promise<Column[]> =>
    (await db.query<Column>(`
      select a.attname as name, format_type(a.atttypid, a.atttypmod) as type
        from pg_attribute a
       where a.attrelid = ('public.' || quote_ident($1))::regclass
         and a.attnum > 0 and not a.attisdropped
       order by a.attnum`, [view])).rows;

  const roles = (f: Fn) =>
    [f.anon && "anon", f.authenticated && "authenticated", f.service_role && "service_role"]
      .filter(Boolean).join(", ");

  const table = (list: Fn[]) => {
    const lines = [
      "| Function | Returns | Roles | Defined in | Why |",
      "|---|---|---|---|---|",
    ];
    for (const f of list) {
      const d = definedIn(files, f.name);
      lines.push(
        `| \`${cell(f.name)}(${cell(f.args)})\` | \`${cell(f.returns)}\` | ${roles(f)} | ` +
        `${d ? `\`${d.file}\`` : "—"} | ${d ? cell(d.why) : "—"} |`,
      );
    }
    return lines.join("\n");
  };

  const member = fns.filter((f) => f.anon);
  const staff = fns.filter((f) => !f.anon && f.authenticated);

  const out: string[] = [];
  out.push("# ProResponse API");
  out.push("");
  out.push("Generated by `npm run api:doc` from the migrations — do not edit.");
  out.push("");
  out.push(
    "Everything callable is a Postgres function reached as `supabase.rpc('<name>', { p_… })`, " +
    "or a view read with `supabase.from('<view>').select()`. The roles column is the grant as it " +
    "stands after every migration: `anon` is a member with the publishable key and no session, " +
    "`authenticated` is signed-in staff, `service_role` is the worker and the web app's admin client. " +
    "A function absent from these tables is not callable from a client at all.",
  );
  out.push("");
  out.push(AUTH_FLOWS.trimEnd());
  out.push("");
  out.push("## Member surface (`anon`)");
  out.push("");
  out.push("What a placard scan can call before anyone signs in.");
  out.push("");
  out.push(table(member));
  out.push("");
  out.push("## Staff surface (`authenticated`)");
  out.push("");
  out.push(
    "Every one of these takes the caller from `auth.uid()`; none accepts a caller id. " +
    "Functions that act on another person check the caller's role against the target's and " +
    "write an `admin_events` row.",
  );
  out.push("");
  out.push(table(staff));
  out.push("");
  out.push("## Views readable by staff");
  out.push("");
  out.push(
    "All are `security_invoker`, so the underlying tables' row-level security applies to the " +
    "reader: a view returns rows from the caller's club and nothing else.",
  );
  for (const v of views) {
    out.push("");
    out.push(`### \`${v.name}\`${v.invoker ? "" : "  — NOT security_invoker (fix before shipping)"}`);
    out.push("");
    out.push("| Column | Type |");
    out.push("|---|---|");
    for (const c of await columnsOf(v.name)) out.push(`| \`${cell(c.name)}\` | \`${cell(c.type)}\` |`);
  }
  out.push("");
  await db.close();
  return out.join("\n");
}

// Run directly: write the file. Imported (by the drift test): do nothing.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2] ?? OUTPUT;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, await generateApiDoc());
  console.log(`wrote ${target}`);
}
