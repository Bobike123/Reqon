-- =============================================================================
--  Add `clause_key` to v_attention so its clause rows can be acted on.
--
--  WHY: the view exposes a clause as `ref = printed_ref`. The regulations book
--  prints two different clauses as E.5.4.5, and two more as F.5.2.3, so
--  printed_ref does NOT identify a row. Without the key, assigning an owner
--  from the Priorities screen would be a guess between two different rules.
--
--  This is additive only. The WHERE clauses and the `reason` CASE expressions
--  below are copied verbatim from the original definition — the attention
--  scoring stays in SQL and is not duplicated in React. Only a column is added.
-- =============================================================================

create or replace view v_attention as
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
where cs.state not in ('compliant','verified','na')
  and (cs.starred or cs.state = 'blocked'
       or c.criticality in ('blocking','penalty'))
union all
select 'task', t.id::text, t.title, t.owner_id, t.season_id,
       case when t.state = 'blocked' then 'blocked'
            when t.due_date < current_date then 'overdue'
            else 'starred' end,
       t.starred,
       null::text
from tasks t
where t.state not in ('done','cancelled')
  and (t.starred or t.state in ('blocked','urgent') or t.due_date < current_date);

-- Keep the RLS fix from 20260102000000: a view runs as its owner unless told
-- otherwise, and CREATE OR REPLACE resets reloptions.
alter view v_attention set (security_invoker = on);
