-- An invitation link that survives being looked at.
--
-- Supabase's recovery tokens are the wrong shape for a link a manager sends by
-- hand. Two things kill them, and both were demonstrated rather than guessed:
--
--   * generating a second link invalidates the first, so a manager who presses
--     the button twice has silently killed the link they already sent
--   * the token is spent on first fetch — and a link sent by text or email is
--     fetched before a human ever taps it, by iMessage building a preview, by
--     Outlook Safe Links, by any scanner in front of a club's mailbox
--
-- So the link a person receives is now ours: an opaque token in our own table,
-- valid for seven days, and spent only when somebody deliberately presses a
-- button on the page. A preview fetch renders that page and consumes nothing.
-- The fragile Supabase token is still what creates the session, but it is now
-- minted and used inside a single request, where nothing can get at it.
create table if not exists staff_invites (
  token      text primary key default encode(gen_random_bytes(24), 'hex'),
  course_id  uuid not null references courses(id) on delete cascade,
  email      text not null,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  used_at    timestamptz
);
create index if not exists staff_invites_email_idx on staff_invites (lower(email));

alter table staff_invites enable row level security;  -- no policies: service only
revoke all on staff_invites from anon, authenticated;

/**
 * Mint an invitation for someone at your club.
 *
 * Previous unused invitations for the same address are retired, so a manager
 * pressing the button twice ends up with one live link rather than two — the
 * same intent Supabase has, made explicit and confined to this table.
 */
create or replace function create_staff_invite(p_email text)
returns text
language plpgsql volatile security definer set search_path = public as $$
declare g record; v_token text; v_email text := lower(btrim(p_email));
begin
  select * into g from assert_can_manage(null);

  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'that is not an email address' using errcode = '22023';
  end if;

  update staff_invites set used_at = now()
   where lower(email) = v_email and course_id = g.course_id and used_at is null;

  insert into staff_invites (course_id, email, created_by)
  values (g.course_id, v_email, g.actor_id)
  returning token into v_token;

  return v_token;
end;
$$;

revoke all on function create_staff_invite(text) from public, anon, authenticated;
grant execute on function create_staff_invite(text) to authenticated;

/**
 * What an invitation is for, without spending it.
 *
 * The landing page needs to greet somebody by name before they press anything.
 * Deliberately separate from redeeming: a link preview will call this, and a
 * preview must not burn the invitation.
 */
create or replace function peek_staff_invite(p_token text)
returns table (email text, full_name text, course_name text, valid boolean)
language sql stable security definer set search_path = public as $$
  select i.email,
         coalesce(pp.full_name, p.full_name, split_part(i.email, '@', 1)),
         c.name,
         (i.used_at is null and i.expires_at > now())
    from staff_invites i
    join courses c on c.id = i.course_id
    left join pending_profiles pp
      on lower(pp.email) = lower(i.email) and pp.course_id = i.course_id
    left join profiles p
      on lower(p.email) = lower(i.email) and p.course_id = i.course_id
   where i.token = p_token
$$;

revoke all on function peek_staff_invite(text) from public, anon, authenticated;
grant execute on function peek_staff_invite(text) to service_role;

/**
 * Spend it. Returns the address the caller should now be signed in as.
 *
 * The update is the check: one statement claims the row only if it is still
 * unused and unexpired, so two taps in quick succession cannot both succeed.
 */
create or replace function redeem_staff_invite(p_token text)
returns text
language plpgsql volatile security definer set search_path = public as $$
declare v_email text;
begin
  update staff_invites set used_at = now()
   where token = p_token and used_at is null and expires_at > now()
  returning email into v_email;

  if v_email is null then
    raise exception 'that invitation is no longer valid' using errcode = '22023';
  end if;
  return v_email;
end;
$$;

revoke all on function redeem_staff_invite(text) from public, anon, authenticated;
grant execute on function redeem_staff_invite(text) to service_role;
