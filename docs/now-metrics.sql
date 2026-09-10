-- =============================================================================
--  Now screen — every number, and the query that reproduces it.
--
--  Paste any block into the Supabase SQL editor. If a tile on the Now screen
--  disagrees with the query below, the tile is wrong.
--
--  All of these read the CURRENT season. `v_current_season` is the single
--  source of truth for which season that is (seasons.is_current).
--
--  Nothing here is recomputed in React: the app runs these same shapes through
--  PostgREST and renders the result.
-- =============================================================================

-- ---------------------------------------------------------------- 1. Deadline
-- Days to the next milestone deadline.
-- Source: milestones.due_on, current season, earliest date not yet passed.
-- A milestone with due_on = NULL (MS1-7, which happens at the Final Event and
-- has no published window) is EXCLUDED here and rendered as "TBC" — never as a
-- made-up date.
select m.key, m.name, m.due_on, (m.due_on - current_date) as days_remaining
from milestones m
join v_current_season s on s.id = m.season_id
where m.due_on is not null and m.due_on >= current_date
order by m.due_on
limit 1;

-- ------------------------------------------------- 2. Live obligations
-- Resolved / total obligations, excluding parked subteams.
-- Source: v_subteam_progress (duties, resolved), is_parked = false.
-- "Resolved" is defined by the view as state in (compliant, verified, na).
-- Parked = Race Operations, which only bites at the Final Event: 491 team
-- duties total, 58 of them RACEOP, leaving 433 live.
select sum(duties)   as total_live_obligations,
       sum(resolved) as resolved
from v_subteam_progress
where not is_parked;

-- ------------------------------------------------------------- 3. MS1 points
-- Points at stake across the MS1 deliverables.
-- Source: milestones.max_points for the current season, MS1 keys only.
-- Should total 600 (75 + 100 + 150 + 60 + 75 + 80 + 60), confirmed both in the
-- individual milestone articles and again at F.13.2.1. The Rider Eligibility
-- Declaration (key 'RED') carries 0 points and is excluded by the key filter.
select sum(m.max_points) as ms1_points_at_stake
from milestones m
join v_current_season s on s.id = m.season_id
where m.key like 'MS1%';

-- ---------------------------------------------------------------- 4. Overdue
-- Overdue items.
-- Source: v_attention, reason = 'overdue'. The view decides what counts as
-- overdue (task not done/cancelled with due_date < current_date); the app does
-- not re-derive it.
select count(*) as overdue
from v_attention a
join v_current_season s on s.id = a.season_id
where a.reason = 'overdue';

-- ------------------------------------------------------------ 5. Open topics
-- Topics raised but not yet agendaed or decided.
-- Source: topics.state = 'open', current season.
select count(*) as open_topics
from topics t
join v_current_season s on s.id = t.season_id
where t.state = 'open';

-- ---------------------------------------------------------------- 6. Blocked
-- Blocked items, both rules and tasks.
-- Source: v_attention, reason = 'blocked'. Covers clause_status.state =
-- 'blocked' and tasks.state = 'blocked' in one place, again decided by SQL.
select count(*) as blocked
from v_attention a
join v_current_season s on s.id = a.season_id
where a.reason = 'blocked';

-- ------------------------------------------------------- 7. Subteam progress
-- The grid. Straight from the view, no arithmetic in the client beyond the
-- percentage bar width (resolved / duties).
select key, name, duties, resolved, in_progress, blocked, is_parked
from v_subteam_progress
order by duties desc;

-- --------------------------------------------------------------- Priorities
-- The Priorities screen is v_attention verbatim for the current season.
-- `reason` is computed by the view; React only groups and renders it.
select kind, ref, reason, starred, owner_id, clause_key
from v_attention a
join v_current_season s on s.id = a.season_id;
