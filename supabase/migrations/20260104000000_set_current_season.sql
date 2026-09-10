-- =============================================================================
--  Atomic season switch.
--
--  WHY THIS EXISTS: `seasons_one_current` is a unique index on (is_current)
--  WHERE is_current, so at most one season may be current. Switching therefore
--  needs TWO writes — clear the old, set the new — and the order is forced:
--  setting the new one first violates the index.
--
--  Done from the client that is two round trips. If the first succeeds and the
--  second fails (tab closed, network drop, token expiry) the club is left with
--  NO current season at all, and every season-scoped query in the app returns
--  nothing. The app looks broken and the fix needs SQL.
--
--  A function body is one transaction: both updates commit together or neither
--  does. That is the database's own atomic mechanism, not a client-side rule.
--
--  SECURITY DEFINER is required so the function may update the row it is
--  clearing regardless of the caller's own row-level access — so the board
--  check below is the authorization, and search_path is pinned so the function
--  cannot be tricked into calling a shadowed is_board().
-- =============================================================================

create or replace function set_current_season(p_season_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  -- Authorization lives here, in the database. A client-side `if (isBoard)` is
  -- a suggestion; this is the rule.
  if not is_board() then
    raise exception 'Only board members may change the current season'
      using errcode = '42501';
  end if;

  if not exists (select 1 from seasons where id = p_season_id) then
    raise exception 'Season % does not exist', p_season_id
      using errcode = '23503';
  end if;

  update seasons set is_current = false where is_current and id <> p_season_id;
  update seasons set is_current = true  where id = p_season_id;
end;
$fn$;

-- Signed-out callers must not reach it at all.
revoke all on function set_current_season(uuid) from public;
revoke all on function set_current_season(uuid) from anon;
grant execute on function set_current_season(uuid) to authenticated;
