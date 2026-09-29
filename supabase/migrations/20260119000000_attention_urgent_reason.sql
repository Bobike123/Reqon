-- =============================================================================
--  attention(): an urgent-PRIORITY task now says why it is listed.
--
--  Phase 6 (Now/Priorities on the priority model, ADR-0004/0007). 20260116 made
--  urgency a priority, and attention() correctly includes tasks with
--  priority = 'urgent' — but its CASE labelled them 'starred' (the ELSE), so the
--  Priorities screen could not tell an urgent task from a starred one. Reasons
--  are ordered blocked, overdue, urgent, starred.
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Add reason 'urgent' to attention().
--    Existing data  None touched; a function body only.
--    Authorization  Unchanged: SECURITY INVOKER, so RLS applies to the caller;
--                   EXECUTE stays with authenticated only.
--    Locking        CREATE OR REPLACE FUNCTION, no table lock.
--    Rollback       Forward recovery: re-create the previous body.
--    Deploy order   After 20260118, with the Phase 6 client (Priorities styles
--                   the new reason; an older client shows it unstyled).
-- =============================================================================
create or replace function attention(p_season uuid, p_today date)
returns table (
  kind text, ref text, title text, owner_id uuid, season_id uuid,
  reason text, starred boolean, clause_key text
)
language sql stable set search_path = public as $fn$
  select 'clause'::text as kind, c.printed_ref as ref, c.body as title,
         cs.owner_id, cs.season_id,
         case when cs.state = 'blocked' then 'blocked'
              when c.criticality = 'blocking' then 'score-killer'
              when c.criticality = 'penalty' then 'penalty'
              else 'starred' end as reason,
         cs.starred,
         c.clause_key
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
         null::text
  from tasks t
  where t.season_id = p_season
    and t.archived_at is null
    and t.state not in ('done', 'cancelled')
    and (t.starred or t.state = 'blocked' or t.priority = 'urgent' or t.due_date < p_today);
$fn$;
