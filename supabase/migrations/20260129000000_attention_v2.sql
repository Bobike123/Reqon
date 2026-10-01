-- =============================================================================
--  Backend completion Phase 4, step 1 of 7: attention() reports every reason a
--  row is listed, not only the first one. (phase-01 finding F-07.)
--
--  WHAT WAS WRONG. attention() returned ONE `reason` chosen by CASE order
--  (blocked, then overdue, then urgent, then starred). The Now screen counted
--  overdue work as rows whose reason was 'overdue', so a task that was BOTH blocked
--  and overdue — the worst kind — was missing from the overdue figure.
--
--  AFTER. The same rows, the same `reason` (ordering unchanged, so the Priorities
--  list looks as before), plus four independent flags:
--     is_overdue  a task whose deadline is before the caller's day (open, not archived)
--     is_blocked  a Blocked task, or a Blocked requirement
--     is_urgent   a task with priority 'urgent'
--     is_starred  starred by a member
--  Counts (Now tiles) are taken from the flags, so one row can be blocked, urgent and
--  overdue at once and counts in each. Requirements never carry is_overdue or is_urgent.
--  Archived and Done/Cancelled tasks are still never listed.
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Independent flags for attention counts.
--    Existing data  None touched; a function only. A function's result columns cannot
--                   change under CREATE OR REPLACE, so it is dropped and re-created with
--                   the identical name, arguments, security and grants (same transaction).
--    Authorization  SECURITY INVOKER (RLS applies to the caller); EXECUTE for
--                   authenticated and service_role only, as before.
--    Locking        DROP/CREATE FUNCTION only.
--    Rollback       Re-create the 20260119000000 definition.
--    Deploy order   Any time; the Phase 4 client counts by flag.
-- =============================================================================

drop function if exists attention(uuid, date);

create function attention(p_season uuid, p_today date)
returns table (
  kind text, ref text, title text, owner_id uuid, season_id uuid,
  reason text, starred boolean, clause_key text,
  is_overdue boolean, is_blocked boolean, is_urgent boolean, is_starred boolean
)
language sql stable set search_path = public as $fn$
  select 'clause'::text as kind, c.printed_ref as ref, c.body as title,
         cs.owner_id, cs.season_id,
         case when cs.state = 'blocked' then 'blocked'
              when c.criticality = 'blocking' then 'score-killer'
              when c.criticality = 'penalty' then 'penalty'
              else 'starred' end as reason,
         cs.starred,
         c.clause_key,
         false as is_overdue,
         cs.state = 'blocked' as is_blocked,
         false as is_urgent,
         cs.starred as is_starred
  from clause_status cs
  join clauses c on c.clause_key = cs.clause_key
  where cs.season_id = p_season
    and cs.state not in ('compliant', 'verified', 'na')
    and (cs.starred or cs.state = 'blocked' or c.criticality in ('blocking', 'penalty'))
  union all
  select 'task', t.id::text, t.title, t.owner_id, t.season_id,
         case when t.state = 'blocked' then 'blocked'
              when t.due_date < p_today then 'overdue'
              when t.priority = 'urgent' then 'urgent'
              else 'starred' end,
         t.starred,
         null::text,
         coalesce(t.due_date < p_today, false),
         t.state = 'blocked',
         t.priority = 'urgent',
         t.starred
  from tasks t
  where t.season_id = p_season
    and t.archived_at is null
    and t.state not in ('done', 'cancelled')
    and (t.starred or t.state = 'blocked' or t.priority = 'urgent' or t.due_date < p_today);
$fn$;

comment on function attention(uuid, date) is
  'What needs attention in a season: open, unarchived tasks and unresolved requirements. `reason` is the first applicable reason (blocked, overdue, urgent, starred; for requirements blocked, score-killer, penalty, starred); is_overdue / is_blocked / is_urgent / is_starred are independent, so counts never depend on which reason came first.';

revoke all on function attention(uuid, date) from public, anon;
grant execute on function attention(uuid, date) to authenticated, service_role;
