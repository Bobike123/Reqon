-- =============================================================================
--  Specification domain and measurement history (20260122000000_spec_targets_and_measurements.sql).
--  Verdict matrix (regulatory, goal, zone), target constraints, the record /
--  correct / invalidate commands, idempotency, ordering (backdated, tied),
--  authorization, season isolation, append-only history and forged writes.
--  Real authenticated sessions. SAFE TO RUN AGAINST THE REAL PROJECT: it ends
--  by raising an exception, so every row rolls back.
--      SPEC MEASUREMENT CHECKS PASSED   or   SPEC MEASUREMENT CHECKS FAILED
-- =============================================================================

create or replace function pg_temp.act_as(who uuid, stmt text, r text default 'authenticated') returns text
language plpgsql as $fn$
declare res text;
begin
  perform set_config('role', r, true);
  perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', r)::text, true);
  perform set_config('request.jwt.claim.sub', who::text, true);
  begin
    execute stmt;
    res := 'ok';
  exception when others then
    res := sqlstate;
  end;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  return res;
end $fn$;

create or replace function pg_temp.act(who uuid, stmt text) returns text
language sql as $fn$ select pg_temp.act_as(who, stmt, 'authenticated') $fn$;

-- The same statement, run as the (owner) test session. Returns ok or the SQLSTATE.
create or replace function pg_temp.try(stmt text) returns text
language plpgsql as $fn$
begin
  begin
    execute stmt;
    return 'ok';
  exception when others then
    return sqlstate;
  end;
end $fn$;

-- A moment in the past: day k of a 60-day window that ends 20 days ago, so the
-- test never depends on today's date and never trips the "not in the future" rule.
create or replace function pg_temp.d(k int) returns text
language sql as $fn$ select (date_trunc('day', now()) - interval '60 days' + k * interval '1 day')::text $fn$;

create temp table results (n serial, label text, ok boolean, detail text);
create or replace function pg_temp.chk(label text, ok boolean, detail text default null) returns void
language plpgsql as $fn$
begin
  insert into results (label, ok, detail) values (label, coalesce(ok, false), detail);
end $fn$;

do $test$
declare
  dev  uuid := gen_random_uuid();   -- Developer
  pres uuid := gen_random_uuid();   -- President
  vp   uuid := gen_random_uuid();   -- Vice President
  head uuid := gen_random_uuid();   -- Head of a department
  mem  uuid := gen_random_uuid();   -- an ordinary active member
  mem2 uuid := gen_random_uuid();   -- another one
  alum uuid := gen_random_uuid();   -- alumnus
  nonm uuid := gen_random_uuid();   -- signed in, not on the roster
  sA uuid; sB uuid; dA text;
  spMin uuid; spTemp uuid; spMax uuid; spEq uuid; spRange uuid; spBool uuid; spBoolOpen uuid; spOpen uuid; spOther uuid;
  q text; n0 int; n1 int; m1 uuid; m2 uuid; m3 uuid; mHead uuid; sp record;
  seen_meas int; seen_verd int;
  r1 uuid := gen_random_uuid(); r2 uuid := gen_random_uuid(); r3 uuid := gen_random_uuid();
  nfail int; ntotal int;
begin
  insert into auth.users (id, email) select x.i, x.e from (values
    (dev,'sm-dev@t.test'),(pres,'sm-pres@t.test'),(vp,'sm-vp@t.test'),(head,'sm-head@t.test'),
    (mem,'sm-mem@t.test'),(mem2,'sm-mem2@t.test'),(alum,'sm-alum@t.test'),(nonm,'sm-non@t.test')) as x(i, e);
  insert into members (id, full_name, role, status) values
    (dev,'SM Dev','Lead','active'),(pres,'SM Pres','Lead','active'),(vp,'SM VP','Lead','active'),
    (head,'SM Head','Ch','active'),(mem,'SM Mem','Ch','active'),(mem2,'SM Mem2','Ch','active'),(alum,'SM Alum','Ch','alumni');
  insert into member_roles (member_id, role) values (dev,'developer'),(pres,'president'),(vp,'vicepresident');
  select key into dA from subteams where archived_at is null order by sort_order, key limit 1;
  update subteams set lead_id = head where key = dA;

  insert into seasons (label, is_current) values ('SM-A', false) returning id into sA;
  insert into seasons (label, is_current) values ('SM-B', false) returning id into sB;

  insert into specs (season_id, parameter, comparator, direction, target, unit, acceptable, goal, ideal)
    values (sA, 'SM mass', 'min', 'lower_better', 85, 'kg', 95, 90, 88) returning id into spMin;
  insert into specs (season_id, parameter, comparator, direction, target, unit, plausible_min, plausible_max)
    values (sA, 'SM temperature', 'min', 'higher_better', -5, 'C', -50, 200) returning id into spTemp;
  insert into specs (season_id, parameter, comparator, direction, target, unit, acceptable, goal, ideal)
    values (sA, 'SM width', 'max', 'lower_better', 450, 'mm', 430, 400, 380) returning id into spMax;
  insert into specs (season_id, parameter, comparator, direction, target, target_tolerance, goal, goal_tolerance)
    values (sA, 'SM hole', 'eq', 'exact', 25, 0.5, 25, 0.1) returning id into spEq;
  insert into specs (season_id, parameter, comparator, direction, target, target_max, target_min_inclusive, goal, goal_max)
    values (sA, 'SM number', 'range', 'range', 1, 99, false, 10, 20) returning id into spRange;
  insert into specs (season_id, parameter, comparator, direction, target_bool, goal_bool)
    values (sA, 'SM flag', 'bool', 'boolean', true, true) returning id into spBool;
  insert into specs (season_id, parameter, comparator, direction)
    values (sA, 'SM flag, rule unknown', 'bool', 'boolean') returning id into spBoolOpen;
  insert into specs (season_id, parameter, comparator, direction)
    values (sA, 'SM open rule', 'min', 'higher_better') returning id into spOpen;
  insert into specs (season_id, parameter, comparator, direction, target)
    values (sB, 'SM other season', 'max', 'lower_better', 10) returning id into spOther;

  -- Phase 4 (20260129000500): a higher/lower direction derived from the rule is scored only once a person has
  -- reviewed it, and the zone is green only with a readiness confirmation. This file is about the verdict
  -- matrix, so its fixtures are marked reviewed; the review and readiness rules have spec_evidence_test.sql.
  update specs set direction_reviewed_at = now() where season_id in (sA, sB);

  -- ===================================================== regulatory verdict matrix
  perform pg_temp.chk('V1 min: at the limit passes, below fails',
    spec_regulatory_verdict('min', 85, null, true, true, null, null, 85, null) = 'pass'
    and spec_regulatory_verdict('min', 85, null, true, true, null, null, 84.99, null) = 'fail');
  perform pg_temp.chk('V2 max: at the limit passes, above fails',
    spec_regulatory_verdict('max', 450, null, true, true, null, null, 450, null) = 'pass'
    and spec_regulatory_verdict('max', 450, null, true, true, null, null, 450.01, null) = 'fail');
  perform pg_temp.chk('V3 zero and negative values are ordinary numbers',
    spec_regulatory_verdict('min', -5, null, true, true, null, null, 0, null) = 'pass'
    and spec_regulatory_verdict('min', -5, null, true, true, null, null, -5, null) = 'pass'
    and spec_regulatory_verdict('min', -5, null, true, true, null, null, -6, null) = 'fail'
    and spec_regulatory_verdict('max', 0, null, true, true, null, null, 0, null) = 'pass');
  perform pg_temp.chk('V4 eq: exact, within the declared tolerance passes, outside fails; no tolerance means exact',
    spec_regulatory_verdict('eq', 25, null, true, true, null, null, 25, null) = 'pass'
    and spec_regulatory_verdict('eq', 25, null, true, true, null, null, 25.01, null) = 'fail'
    and spec_regulatory_verdict('eq', 25, null, true, true, 0.5, null, 25.5, null) = 'pass'
    and spec_regulatory_verdict('eq', 25, null, true, true, 0.5, null, 24.49, null) = 'fail');
  perform pg_temp.chk('V5 range: inclusive bounds pass at both edges, fail just outside',
    spec_regulatory_verdict('range', 1, 99, true, true, null, null, 1, null) = 'pass'
    and spec_regulatory_verdict('range', 1, 99, true, true, null, null, 99, null) = 'pass'
    and spec_regulatory_verdict('range', 1, 99, true, true, null, null, 0.99, null) = 'fail'
    and spec_regulatory_verdict('range', 1, 99, true, true, null, null, 99.01, null) = 'fail');
  perform pg_temp.chk('V6 range: an exclusive bound fails at the edge, passes just inside',
    spec_regulatory_verdict('range', 1, 99, false, true, null, null, 1, null) = 'fail'
    and spec_regulatory_verdict('range', 1, 99, false, true, null, null, 1.01, null) = 'pass'
    and spec_regulatory_verdict('range', 1, 99, true, false, null, null, 99, null) = 'fail'
    and spec_regulatory_verdict('range', 1, 99, true, false, null, null, 98.99, null) = 'pass');
  perform pg_temp.chk('V7 bool: equal passes, different fails',
    spec_regulatory_verdict('bool', null, null, true, true, null, true, null, true) = 'pass'
    and spec_regulatory_verdict('bool', null, null, true, true, null, true, null, false) = 'fail'
    and spec_regulatory_verdict('bool', null, null, true, true, null, false, null, false) = 'pass');
  perform pg_temp.chk('V8 nothing measured is unmeasured',
    spec_regulatory_verdict('min', 85, null, true, true, null, null, null, null) = 'unmeasured'
    and spec_regulatory_verdict('bool', null, null, true, true, null, true, null, null) = 'unmeasured');
  perform pg_temp.chk('V9 measured but the rule is incomplete is unevaluable, never pass',
    spec_regulatory_verdict('min', null, null, true, true, null, null, 100, null) = 'unevaluable'
    and spec_regulatory_verdict('max', null, null, true, true, null, null, 1, null) = 'unevaluable'
    and spec_regulatory_verdict('eq', null, null, true, true, null, null, 1, null) = 'unevaluable'
    and spec_regulatory_verdict('range', 1, null, true, true, null, null, 5, null) = 'unevaluable'
    and spec_regulatory_verdict('range', null, 9, true, true, null, null, 5, null) = 'unevaluable'
    and spec_regulatory_verdict('bool', null, null, true, true, null, null, null, true) = 'unevaluable');
  perform pg_temp.chk('V10 a value of the wrong kind is unevaluable',
    spec_regulatory_verdict('min', 85, null, true, true, null, null, null, true) = 'unevaluable'
    and spec_regulatory_verdict('bool', null, null, true, true, null, true, 1, null) = 'unevaluable');

  -- ============================================================ goal status matrix
  perform pg_temp.chk('G1 higher-better: at or above goal is met; between is short; below acceptable is unacceptable',
    spec_goal_status('higher_better', 20, null, null, null, 10, 20, null) = 'met'
    and spec_goal_status('higher_better', 20, null, null, null, 10, 25, null) = 'met'
    and spec_goal_status('higher_better', 20, null, null, null, 10, 15, null) = 'short'
    and spec_goal_status('higher_better', 20, null, null, null, 10, 10, null) = 'short'
    and spec_goal_status('higher_better', 20, null, null, null, 10, 9.99, null) = 'unacceptable');
  perform pg_temp.chk('G2 lower-better: acceptable 200 is a MAXIMUM; at or below goal 180 is met, up to 200 short, above 200 unacceptable',
    spec_goal_status('lower_better', 180, null, null, null, 200, 170, null) = 'met'
    and spec_goal_status('lower_better', 180, null, null, null, 200, 180, null) = 'met'
    and spec_goal_status('lower_better', 180, null, null, null, 200, 190, null) = 'short'
    and spec_goal_status('lower_better', 180, null, null, null, 200, 200, null) = 'short'
    and spec_goal_status('lower_better', 180, null, null, null, 200, 200.01, null) = 'unacceptable');
  perform pg_temp.chk('G3 no goal is not_set (a value worse than a set acceptable threshold is still unacceptable)',
    spec_goal_status('higher_better', null, null, null, null, null, 5, null) = 'not_set'
    and spec_goal_status('higher_better', null, null, null, null, 10, 5, null) = 'unacceptable'
    and spec_goal_status('lower_better', null, null, null, null, 10, 5, null) = 'not_set');
  perform pg_temp.chk('G4 range goal band: inside met, outside short, half-set band is not_set',
    spec_goal_status('range', 10, 20, null, null, null, 10, null) = 'met'
    and spec_goal_status('range', 10, 20, null, null, null, 20, null) = 'met'
    and spec_goal_status('range', 10, 20, null, null, null, 20.5, null) = 'short'
    and spec_goal_status('range', 10, null, null, null, null, 15, null) = 'not_set');
  perform pg_temp.chk('G5 exact goal with its own tolerance',
    spec_goal_status('exact', 25, null, 0.1, null, null, 25.1, null) = 'met'
    and spec_goal_status('exact', 25, null, 0.1, null, null, 25.2, null) = 'short'
    and spec_goal_status('exact', 25, null, null, null, null, 25, null) = 'met'
    and spec_goal_status('exact', null, null, null, null, null, 25, null) = 'not_set');
  perform pg_temp.chk('G6 boolean goal',
    spec_goal_status('boolean', null, null, null, true, null, null, true) = 'met'
    and spec_goal_status('boolean', null, null, null, true, null, null, false) = 'short'
    and spec_goal_status('boolean', null, null, null, null, null, null, false) = 'not_set'
    and spec_goal_status('boolean', null, null, null, true, null, null, null) = 'unmeasured');

  -- ========================================================================== zones
  perform pg_temp.chk('Z1 red only for a regulatory failure, whatever the goal says',
    spec_zone('fail', 'met') = 'red' and spec_zone('fail', 'not_set') = 'red' and spec_zone('fail', 'short') = 'red');
  perform pg_temp.chk('Z2 green needs an established pass AND the goal met',
    spec_zone('pass', 'met') = 'green' and spec_zone('pass', 'not_set') <> 'green'
    and spec_zone('unevaluable', 'met') <> 'green' and spec_zone('unmeasured', 'met') <> 'green');
  perform pg_temp.chk('Z3 amber: regulatory pass but the goal is short or unacceptable',
    spec_zone('pass', 'short') = 'amber' and spec_zone('pass', 'unacceptable') = 'amber');
  perform pg_temp.chk('Z4 unknown regulation, unmeasured or no goal is grey',
    spec_zone('unevaluable', 'short') = 'grey' and spec_zone('unmeasured', 'unmeasured') = 'grey'
    and spec_zone('pass', 'not_set') = 'grey');

  -- ================================================= target constraints (owner)
  perform pg_temp.chk('T1 a lower-better acceptable below its goal is refused (it would be a lower bound)',
    pg_temp.try(format($$insert into specs (season_id, parameter, comparator, direction, target, acceptable, goal)
      values (%L, 'T1', 'max', 'lower_better', 10, 5, 8)$$, sA)) = '23514');
  perform pg_temp.chk('T2 a higher-better acceptable above its goal is refused',
    pg_temp.try(format($$insert into specs (season_id, parameter, comparator, direction, target, acceptable, goal)
      values (%L, 'T2', 'min', 'higher_better', 1, 9, 5)$$, sA)) = '23514');
  perform pg_temp.chk('T3 the ordered targets are accepted; unknown ones stay NULL',
    pg_temp.try(format($$insert into specs (season_id, parameter, comparator, direction, target, acceptable, goal, ideal)
      values (%L, 'T3', 'max', 'lower_better', 10, 9, 8, 7)$$, sA)) = 'ok'
    and (select acceptable is null and goal is null and ideal is null from specs where id = spOpen));
  perform pg_temp.chk('T4 range goals must be ordered; acceptable/ideal do not apply to range or exact; goal_max only to range',
    pg_temp.try(format($$insert into specs (season_id, parameter, comparator, direction, target, target_max, goal, goal_max)
      values (%L, 'T4', 'range', 'range', 1, 99, 30, 20)$$, sA)) = '23514'
    and pg_temp.try(format($$insert into specs (season_id, parameter, comparator, direction, target, acceptable)
      values (%L, 'T4b', 'eq', 'exact', 1, 2)$$, sA)) = '23514'
    and pg_temp.try(format($$insert into specs (season_id, parameter, comparator, direction, target, goal_max)
      values (%L, 'T4c', 'max', 'lower_better', 1, 2)$$, sA)) = '23514');
  perform pg_temp.chk('T5 NaN and infinity are refused in every numeric target',
    pg_temp.try(format($$insert into specs (season_id, parameter, comparator, direction, target) values (%L, 'T5', 'min', 'higher_better', 'NaN')$$, sA)) = '23514'
    and pg_temp.try(format($$insert into specs (season_id, parameter, comparator, direction, target) values (%L, 'T5b', 'min', 'higher_better', 'Infinity')$$, sA)) = '23514'
    and pg_temp.try(format($$insert into specs (season_id, parameter, comparator, direction, target, goal) values (%L, 'T5c', 'min', 'higher_better', 1, '-Infinity')$$, sA)) = '23514');
  perform pg_temp.chk('T6 plausible bounds must be ordered; boolean specs take none',
    pg_temp.try(format($$insert into specs (season_id, parameter, comparator, direction, target, plausible_min, plausible_max)
      values (%L, 'T6', 'min', 'higher_better', 1, 10, 5)$$, sA)) = '23514'
    and pg_temp.try(format($$insert into specs (season_id, parameter, comparator, direction, target_bool, plausible_min)
      values (%L, 'T6b', 'bool', 'boolean', true, 0)$$, sA)) = '23514');
  perform pg_temp.chk('T7 rule shape: tolerance only for eq, target_max only for range, bool rules carry no number',
    pg_temp.try(format($$insert into specs (season_id, parameter, comparator, direction, target, target_tolerance) values (%L, 'T7', 'min', 'higher_better', 1, 0.1)$$, sA)) = '23514'
    and pg_temp.try(format($$insert into specs (season_id, parameter, comparator, direction, target, target_max) values (%L, 'T7b', 'max', 'lower_better', 1, 2)$$, sA)) = '23514'
    and pg_temp.try(format($$insert into specs (season_id, parameter, comparator, direction, target) values (%L, 'T7c', 'bool', 'boolean', 3)$$, sA)) = '23514'
    and pg_temp.try(format($$insert into specs (season_id, parameter, comparator, direction, target_bool) values (%L, 'T7d', 'min', 'higher_better', true)$$, sA)) = '23514');
  perform pg_temp.chk('T8 a range needs a real interval (lower < upper, or equal and both inclusive)',
    pg_temp.try(format($$insert into specs (season_id, parameter, comparator, direction, target, target_max) values (%L, 'T8', 'range', 'range', 9, 1)$$, sA)) = '23514'
    and pg_temp.try(format($$insert into specs (season_id, parameter, comparator, direction, target, target_max, target_min_inclusive) values (%L, 'T8b', 'range', 'range', 5, 5, false)$$, sA)) = '23514'
    and pg_temp.try(format($$insert into specs (season_id, parameter, comparator, direction, target, target_max) values (%L, 'T8c', 'range', 'range', 5, 5)$$, sA)) = 'ok');
  -- Two statements: a subselect in the same statement as try() would read the
  -- snapshot from before try() inserted the row.
  q := pg_temp.try(format($$insert into specs (season_id, parameter, comparator, target) values (%L, 'T9b', 'max', 3)$$, sA));
  perform pg_temp.chk('T9 direction and comparator must agree on kind; direction defaults from the comparator only when omitted',
    pg_temp.try(format($$insert into specs (season_id, parameter, comparator, direction, target) values (%L, 'T9', 'min', 'boolean', 1)$$, sA)) = '23514'
    and q = 'ok'
    and (select direction from specs where parameter = 'T9b') = 'lower_better'
    and (select measure_kind from specs where id = spBool) = 'boolean'
    and (select measure_kind from specs where id = spMin) = 'numeric');
  perform pg_temp.chk('T10 the seeded range spec now holds its bounds; no seeded spec is left with a missing bound',
    (select count(*) from specs where comparator = 'range' and season_id not in (sA, sB) and (target is null or target_max is null)) = 0
    and (select target = 1 and target_max = 99 from specs where comparator = 'range' and clause_key = 'A.3.1.6' limit 1));

  -- ====================================================================== record
  q := pg_temp.act(mem, format($$select record_spec_measurement(p_season_id => %L, p_spec_id => %L, p_value_numeric => '91.5', p_measured_at => %L, p_note => 'first weighing', p_source => 'scale 2', p_request_id => %L)$$, sA, spMin, pg_temp.d(10), r1));
  select id into m1 from spec_measurements where spec_id = spMin;
  perform pg_temp.chk('R1 an active member records a measurement: exactly one accepted observation',
    q = 'ok' and (select count(*) from spec_measurements where spec_id = spMin) = 1, q);
  perform pg_temp.chk('R2 the measurer is the caller, recorded_at is the server clock, note and source are kept',
    (select measured_by = mem and recorded_at between now() - interval '1 minute' and now() + interval '1 minute'
        and note = 'first weighing' and source = 'scale 2' and origin = 'entered' and invalidated_at is null
       from spec_measurements where id = m1));
  perform pg_temp.chk('R3 the current value follows in the same transaction (value, time, measurer, pointer)',
    (select measured = 91.5 and measured_by = mem and measured_at = pg_temp.d(10)::timestamptz and current_measurement_id = m1
       from specs where id = spMin));
  select * into sp from spec_verdicts where id = spMin;
  perform pg_temp.chk('R4 the view answers: regulatory pass (91.5 >= 85), goal short (lower is better, goal 90), amber',
    sp.verdict = 'pass' and sp.goal_status = 'short' and sp.zone = 'amber', format('%s/%s/%s', sp.verdict, sp.goal_status, sp.zone));
  perform pg_temp.chk('R5 exactly one activity event, by the caller, carrying value, time and "becomes current"',
    (select count(*) from activity where entity = 'spec' and entity_id = spMin::text and action = 'measurement_recorded'
        and actor_id = mem and (detail ->> 'measurement_id') = m1::text and (detail ->> 'becomes_current')::boolean
        and (detail -> 'value')::numeric = 91.5) = 1);

  q := pg_temp.act(mem, format($$select record_spec_measurement(p_season_id => %L, p_spec_id => %L, p_value_numeric => '91.5', p_measured_at => %L, p_note => 'first weighing', p_source => 'scale 2', p_request_id => %L)$$, sA, spMin, pg_temp.d(10), r1));
  perform pg_temp.chk('R6 a retry with the same request id creates no second observation and no second event',
    q = 'ok' and (select count(*) from spec_measurements where spec_id = spMin) = 1
    and (select count(*) from activity where entity = 'spec' and entity_id = spMin::text and action = 'measurement_recorded') = 1, q);
  q := pg_temp.act(mem, format($$select record_spec_measurement(p_season_id => %L, p_spec_id => %L, p_value_numeric => '92', p_measured_at => %L, p_request_id => %L)$$, sA, spMin, pg_temp.d(10), r1));
  perform pg_temp.chk('R7 the same request id for a different value is refused, not silently replayed', q = '23505', q);
  q := pg_temp.act(mem, format($$select record_spec_measurement(p_season_id => %L, p_spec_id => %L, p_value_numeric => '91.5', p_measured_at => %L, p_request_id => %L)$$, sA, spMin, pg_temp.d(11), r2));
  perform pg_temp.chk('R8 the same value with a NEW request id is a genuine repeat measurement: a second row',
    q = 'ok' and (select count(*) from spec_measurements where spec_id = spMin) = 2, q);
  q := pg_temp.act(mem2, format($$select record_spec_measurement(p_season_id => %L, p_spec_id => %L, p_value_numeric => '91.5', p_measured_at => %L, p_request_id => %L)$$, sA, spMin, pg_temp.d(12), r1));
  perform pg_temp.chk('R9 another member reusing the same request id gets their own row: the id gives no actor authority',
    q = 'ok' and (select count(*) from spec_measurements where spec_id = spMin and measured_by = mem2) = 1
    and (select count(*) from spec_measurements where spec_id = spMin and measured_by = mem) = 2, q);

  -- ordering
  q := pg_temp.act(mem, format($$select record_spec_measurement(p_season_id => %L, p_spec_id => %L, p_value_numeric => '99', p_measured_at => %L, p_note => 'late entry of an old reading', p_request_id => gen_random_uuid())$$, sA, spMin, pg_temp.d(1)));
  perform pg_temp.chk('O1 a backdated observation adds history and does not displace the newer current value',
    q = 'ok' and (select measured = 91.5 and measured_by = mem2 and measured_at = pg_temp.d(12)::timestamptz from specs where id = spMin)
    and (select count(*) from spec_measurements where spec_id = spMin) = 4, q);
  perform pg_temp.chk('O2 ...and its event says it did not become current',
    (select count(*) from activity where entity = 'spec' and entity_id = spMin::text and action = 'measurement_recorded'
        and (detail ->> 'becomes_current')::boolean = false and (detail -> 'value')::numeric = 99) = 1);
  q := pg_temp.act(mem, format($$select record_spec_measurement(p_season_id => %L, p_spec_id => %L, p_value_numeric => '88', p_measured_at => %L, p_request_id => gen_random_uuid())$$, sA, spMin, pg_temp.d(20)));
  perform pg_temp.chk('O3 a genuinely newer observation becomes current',
    q = 'ok' and (select measured = 88 and measured_at = pg_temp.d(20)::timestamptz from specs where id = spMin), q);

  insert into spec_measurements (spec_id, season_id, value_numeric, measured_at, recorded_at, measured_by, request_id)
    values (spMax, sA, 300, pg_temp.d(15)::timestamptz, pg_temp.d(15)::timestamptz + interval '1 second', mem, gen_random_uuid());
  insert into spec_measurements (spec_id, season_id, value_numeric, measured_at, recorded_at, measured_by, request_id)
    values (spMax, sA, 310, pg_temp.d(15)::timestamptz, pg_temp.d(15)::timestamptz + interval '2 second', mem, gen_random_uuid());
  perform refresh_spec_current(spMax);
  perform pg_temp.chk('O4 equal measured_at: the later server recorded_at is current',
    (select measured = 310 from specs where id = spMax));
  insert into spec_measurements (spec_id, season_id, value_numeric, measured_at, recorded_at, measured_by, request_id)
    values (spMax, sA, 320, pg_temp.d(15)::timestamptz, pg_temp.d(15)::timestamptz + interval '2 second', mem, gen_random_uuid());
  perform refresh_spec_current(spMax);
  perform pg_temp.chk('O5 equal measured_at and recorded_at: the higher id is current, deterministically',
    (select measured from specs where id = spMax) = (select value_numeric from spec_measurements
       where spec_id = spMax and measured_at = pg_temp.d(15)::timestamptz and recorded_at = pg_temp.d(15)::timestamptz + interval '2 second'
       order by id desc limit 1));
  perform refresh_spec_current(spMax);
  perform pg_temp.chk('O6 recomputing is stable (idempotent)',
    (select measured from specs where id = spMax) = (select value_numeric from spec_measurements
       where spec_id = spMax and measured_at = pg_temp.d(15)::timestamptz and recorded_at = pg_temp.d(15)::timestamptz + interval '2 second'
       order by id desc limit 1));

  -- input validation: typed values, bounds, no global cap
  n0 := (select count(*) from spec_measurements); n1 := (select count(*) from activity where entity = 'spec' and action = 'measurement_recorded');
  q := pg_temp.act(mem, format($$select record_spec_measurement(p_season_id => %L, p_spec_id => %L, p_request_id => gen_random_uuid())$$, sA, spTemp));
  perform pg_temp.chk('I1 an empty input is refused: no row, no fake zero, no clearing', q = '22004'
    and (select count(*) from spec_measurements where spec_id = spTemp) = 0 and (select measured is null from specs where id = spTemp), q);
  q := pg_temp.act(mem, format($$select record_spec_measurement(p_season_id => %L, p_spec_id => %L, p_value_numeric => 'NaN', p_request_id => gen_random_uuid())$$, sA, spTemp));
  perform pg_temp.chk('I2 NaN is refused', q = '22003', q);
  q := pg_temp.act(mem, format($$select record_spec_measurement(p_season_id => %L, p_spec_id => %L, p_value_numeric => 'Infinity', p_request_id => gen_random_uuid())$$, sA, spTemp));
  perform pg_temp.chk('I3 infinity is refused', q = '22003', q);
  q := pg_temp.act(mem, format($$select record_spec_measurement(p_season_id => %L, p_spec_id => %L, p_value_numeric => '1', p_value_bool => true, p_request_id => gen_random_uuid())$$, sA, spTemp));
  perform pg_temp.chk('I4 a number and a boolean together are refused', q = '22023', q);
  q := pg_temp.act(mem, format($$select record_spec_measurement(p_season_id => %L, p_spec_id => %L, p_value_bool => true, p_request_id => gen_random_uuid())$$, sA, spTemp));
  perform pg_temp.chk('I5 a boolean for a numeric specification is refused', q = '22023', q);
  q := pg_temp.act(mem, format($$select record_spec_measurement(p_season_id => %L, p_spec_id => %L, p_value_numeric => '1', p_request_id => gen_random_uuid())$$, sA, spBool));
  perform pg_temp.chk('I6 a number for a boolean specification is refused', q = '22023', q);
  q := pg_temp.act(mem, format($$select record_spec_measurement(p_season_id => %L, p_spec_id => %L, p_value_numeric => '-60', p_request_id => gen_random_uuid())$$, sA, spTemp));
  perform pg_temp.chk('I7 below this specification''s plausible minimum is refused', q = '22003', q);
  q := pg_temp.act(mem, format($$select record_spec_measurement(p_season_id => %L, p_spec_id => %L, p_value_numeric => '201', p_request_id => gen_random_uuid())$$, sA, spTemp));
  perform pg_temp.chk('I8 above its plausible maximum is refused', q = '22003', q);
  q := pg_temp.act(mem, format($$select record_spec_measurement(p_season_id => %L, p_spec_id => %L, p_value_numeric => '5', p_measured_at => %L, p_request_id => gen_random_uuid())$$, sA, spTemp, (now() + interval '1 day')::text));
  perform pg_temp.chk('I9 a measurement time in the future is refused', q = '22008', q);
  q := pg_temp.act(mem, format($$select record_spec_measurement(p_season_id => %L, p_spec_id => %L, p_value_numeric => '5', p_measured_at => '-infinity', p_request_id => gen_random_uuid())$$, sA, spTemp));
  perform pg_temp.chk('I9b a measurement time that is not a real moment (-infinity) is refused', q = '22008', q);
  q := pg_temp.act(mem, format($$select record_spec_measurement(p_season_id => %L, p_spec_id => %L, p_value_numeric => '1', p_request_id => null)$$, sA, spTemp));
  perform pg_temp.chk('I10 a request id is required', q = '22004', q);
  perform pg_temp.chk('I11 none of the refused saves left a row, an event or a changed current value',
    (select count(*) from spec_measurements) = n0
    and (select count(*) from activity where entity = 'spec' and action = 'measurement_recorded') = n1
    and (select measured is null from specs where id = spTemp));

  q := pg_temp.act(mem, format($$select record_spec_measurement(p_season_id => %L, p_spec_id => %L, p_value_numeric => '0', p_measured_at => %L, p_request_id => gen_random_uuid())$$, sA, spTemp, pg_temp.d(19)));
  perform pg_temp.chk('I12 zero is a valid measurement (not treated as empty)',
    q = 'ok' and (select measured = 0 from specs where id = spTemp), q);
  q := pg_temp.act(mem, format($$select record_spec_measurement(p_season_id => %L, p_spec_id => %L, p_value_numeric => '-20.5', p_measured_at => %L, p_request_id => gen_random_uuid())$$, sA, spTemp, pg_temp.d(21)));
  perform pg_temp.chk('I13 a negative value inside the bounds is valid',
    q = 'ok' and (select measured = -20.5 from specs where id = spTemp), q);
  q := pg_temp.act(mem, format($$select record_spec_measurement(p_season_id => %L, p_spec_id => %L, p_value_numeric => '1000000', p_measured_at => %L, p_request_id => gen_random_uuid())$$, sA, spMax, pg_temp.d(30)));
  perform pg_temp.chk('I14 there is no global maximum: a specification with no bound accepts a large value', q = 'ok', q);
  q := pg_temp.act(mem, format($$select record_spec_measurement(p_season_id => %L, p_spec_id => %L, p_value_bool => true, p_measured_at => %L, p_request_id => gen_random_uuid())$$, sA, spBool, pg_temp.d(5)));
  select * into sp from spec_verdicts where id = spBool;
  perform pg_temp.chk('I15 a boolean specification records a yes/no value: passes and meets its goal, but amber until a person confirms readiness (Phase 4)',
    q = 'ok' and sp.measured is null and sp.measured_bool is true and sp.verdict = 'pass' and sp.goal_status = 'met' and sp.zone = 'amber', q);
  perform pg_temp.act(mem, format($$select record_spec_measurement(p_season_id => %L, p_spec_id => %L, p_value_bool => true, p_measured_at => %L, p_request_id => gen_random_uuid())$$, sA, spBoolOpen, pg_temp.d(5)));
  select * into sp from spec_verdicts where id = spBoolOpen;
  perform pg_temp.chk('I16 a measured value against an unknown regulation is unevaluable and grey, never green',
    sp.verdict = 'unevaluable' and sp.zone = 'grey', format('%s/%s', sp.verdict, sp.zone));
  perform pg_temp.act(mem, format($$select record_spec_measurement(p_season_id => %L, p_spec_id => %L, p_value_numeric => '500', p_measured_at => %L, p_request_id => gen_random_uuid())$$, sA, spOpen, pg_temp.d(5)));
  select * into sp from spec_verdicts where id = spOpen;
  perform pg_temp.chk('I17 a numeric spec with no target is unevaluable: not pass and not fail', sp.verdict = 'unevaluable' and sp.zone = 'grey');
  select * into sp from spec_verdicts where id = spEq;
  perform pg_temp.chk('I18 an unmeasured specification reads unmeasured, grey', sp.verdict = 'unmeasured' and sp.zone = 'grey');
  perform pg_temp.act(mem, format($$select record_spec_measurement(p_season_id => %L, p_spec_id => %L, p_value_numeric => '1', p_measured_at => %L, p_request_id => gen_random_uuid())$$, sA, spRange, pg_temp.d(21)));
  select * into sp from spec_verdicts where id = spRange;
  perform pg_temp.chk('I19 the range rule is now evaluated: 1 on the exclusive lower bound fails (red)', sp.verdict = 'fail' and sp.zone = 'red');
  perform pg_temp.act(mem, format($$select record_spec_measurement(p_season_id => %L, p_spec_id => %L, p_value_numeric => '15', p_measured_at => %L, p_request_id => gen_random_uuid())$$, sA, spRange, pg_temp.d(22)));
  select * into sp from spec_verdicts where id = spRange;
  perform pg_temp.chk('I20 15 is inside the range and inside the goal band: pass, met, amber until readiness is confirmed (Phase 4)', sp.verdict = 'pass' and sp.goal_status = 'met' and sp.zone = 'amber');

  -- ======================================================================== permissions
  n0 := (select count(*) from spec_measurements);
  perform pg_temp.chk('P1 an alumnus cannot record', pg_temp.act(alum, format($$select record_spec_measurement(p_season_id => %L, p_spec_id => %L, p_value_numeric => '1', p_request_id => gen_random_uuid())$$, sA, spTemp)) = '42501');
  perform pg_temp.chk('P2 a signed-in user who is not on the roster cannot record', pg_temp.act(nonm, format($$select record_spec_measurement(p_season_id => %L, p_spec_id => %L, p_value_numeric => '1', p_request_id => gen_random_uuid())$$, sA, spTemp)) = '42501');
  perform pg_temp.chk('P3 anon cannot call the command',
    pg_temp.act_as(gen_random_uuid(), format($$select record_spec_measurement(p_season_id => %L, p_spec_id => %L, p_value_numeric => '1', p_request_id => gen_random_uuid())$$, sA, spTemp), 'anon') = '42501');
  perform pg_temp.chk('P4 a department Head can record (measuring is not target administration)',
    pg_temp.act(head, format($$select record_spec_measurement(p_season_id => %L, p_spec_id => %L, p_value_numeric => '10', p_measured_at => %L, p_request_id => gen_random_uuid())$$, sA, spTemp, pg_temp.d(23))) = 'ok');
  select id into mHead from spec_measurements where spec_id = spTemp and measured_by = head;
  perform pg_temp.chk('P5 nothing was written by the refused callers', (select count(*) from spec_measurements) = n0 + 1);

  -- direct writes
  q := pg_temp.act(mem, format($$insert into spec_measurements (spec_id, season_id, value_numeric, measured_at, measured_by, request_id) values (%L, %L, 1, now(), %L, gen_random_uuid())$$, spTemp, sA, mem));
  perform pg_temp.chk('F1 a member cannot insert a history row directly', q = '42501', q);
  q := pg_temp.act(dev, format($$insert into spec_measurements (spec_id, season_id, value_numeric, measured_at, measured_by, request_id) values (%L, %L, 1, now(), %L, gen_random_uuid())$$, spTemp, sA, mem));
  perform pg_temp.chk('F2 not even a Developer can: no write grant, so an actor or time cannot be forged', q = '42501', q);
  q := pg_temp.act(mem, format($$update specs set measured = 1, measured_by = %L, measured_at = now() where id = %L$$, mem2, spEq));
  perform pg_temp.chk('F3 a member''s direct update of specs.measured changes nothing (no row is updatable for them)',
    (select measured is null and measured_by is null from specs where id = spEq)
    and (select count(*) from spec_measurements where spec_id = spEq) = 0, q);
  q := pg_temp.act(dev, format($$update specs set measured = 1 where id = %L$$, spEq));
  perform pg_temp.chk('F4 an administrator''s direct update of the current value is refused by the guard', q = '42501'
    and (select measured is null from specs where id = spEq), q);
  q := pg_temp.act(dev, format($$update specs set measured_by = %L where id = %L$$, mem2, spMin));
  perform pg_temp.chk('F5 ...and so is forging the actor', q = '42501' and (select measured_by = mem from specs where id = spMin), q);
  q := pg_temp.act(dev, format($$update specs set current_measurement_id = null where id = %L$$, spMin));
  perform pg_temp.chk('F6 ...and repointing the current observation', q = '42501' and (select current_measurement_id is not null from specs where id = spMin), q);
  q := pg_temp.act(dev, format($$insert into specs (season_id, parameter, comparator, direction, target, measured) values (%L, 'F7', 'min', 'higher_better', 1, 5)$$, sA));
  perform pg_temp.chk('F7 a spec cannot be created already holding a measured value', q = '42501', q);
  perform pg_temp.chk('F8 history rows cannot be updated, even by the owner',
    pg_temp.try(format($$update spec_measurements set value_numeric = 1 where id = %L$$, m1)) = '42501'
    and pg_temp.try(format($$update spec_measurements set measured_at = now() where id = %L$$, m1)) = '42501'
    and pg_temp.try(format($$update spec_measurements set measured_by = %L where id = %L$$, mem2, m1)) = '42501');
  perform pg_temp.chk('F9 history rows cannot be deleted, even by the owner',
    pg_temp.try(format($$delete from spec_measurements where id = %L$$, m1)) = '42501');
  perform pg_temp.chk('F10 a specification with history cannot be deleted (RESTRICT)',
    pg_temp.try(format($$delete from specs where id = %L$$, spMin)) = '23503');
  perform pg_temp.chk('F11 refresh_spec_current is not callable by clients',
    pg_temp.act(dev, format($$select refresh_spec_current(%L)$$, spMin)) = '42501');
  -- A signed-in non-member sees nothing. Read while switched, record after switching back
  -- (the temp results table is not writable by that role).
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', nonm, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', nonm::text, true);
  seen_meas := (select count(*) from spec_measurements);
  seen_verd := (select count(*) from spec_verdicts);
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform pg_temp.chk('F12 a signed-in non-member sees no history and no verdicts (row-level protection, view included)',
    seen_meas = 0 and seen_verd = 0, format('%s / %s', seen_meas, seen_verd));
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', mem, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', mem::text, true);
  seen_meas := (select count(*) from spec_measurements);
  seen_verd := (select count(*) from spec_verdicts);
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform pg_temp.chk('F13 an ordinary member reads the history and the verdicts', seen_meas > 0 and seen_verd > 0, format('%s / %s', seen_meas, seen_verd));

  -- ===================================================================== target editing
  q := pg_temp.act(mem, format($$update specs set target = 1 where id = %L$$, spMin));
  perform pg_temp.chk('E1 an ordinary member cannot edit a regulatory limit', (select target = 85 from specs where id = spMin), q);
  q := pg_temp.act(head, format($$update specs set goal = 89, comparator = 'max' where id = %L$$, spMin));
  perform pg_temp.chk('E2 a department Head has no specification-wide authority: limit, comparator and goal unchanged',
    (select target = 85 and comparator = 'min' and goal = 90 from specs where id = spMin), q);
  perform pg_temp.chk('E3 nor can a Head add or delete a specification',
    pg_temp.act(head, format($$insert into specs (season_id, parameter, comparator, direction, target) values (%L, 'E3', 'max', 'lower_better', 1)$$, sA)) = '42501'
    and pg_temp.act(head, format($$delete from specs where id = %L$$, spOpen)) = 'ok'
    and exists (select 1 from specs where id = spOpen));
  q := pg_temp.act(vp, format($$update specs set goal = 89, acceptable = 96 where id = %L$$, spMin));
  perform pg_temp.chk('E4 the Vice President edits internal targets', q = 'ok' and (select goal = 89 and acceptable = 96 from specs where id = spMin), q);
  perform pg_temp.chk('E5 ...and the change is audited with from and to, by the actor, without touching the current value',
    (select count(*) from activity where entity = 'spec' and entity_id = spMin::text and action = 'targets_changed' and actor_id = vp
        and detail -> 'changes' -> 'goal' ->> 'from' = '90' and detail -> 'changes' -> 'goal' ->> 'to' = '89'
        and not ((detail -> 'changes') ? 'measured')) = 1);
  perform pg_temp.chk('E6 the President and the Developer can also edit targets',
    pg_temp.act(pres, format($$update specs set ideal = 87 where id = %L$$, spMin)) = 'ok'
    and pg_temp.act(dev, format($$update specs set ideal = 86 where id = %L$$, spMin)) = 'ok');
  perform pg_temp.chk('E7 an invalid target edit by an administrator is refused by the constraints, leaving the row unchanged',
    pg_temp.act(pres, format($$update specs set acceptable = 50 where id = %L$$, spMin)) = '23514'
    and (select acceptable = 96 from specs where id = spMin));
  perform pg_temp.chk('E8 recording a measurement does not write a targets_changed event',
    (select count(*) from activity where entity = 'spec' and entity_id = spTemp::text and action = 'targets_changed') = 0);
  perform pg_temp.chk('E9 a tightened plausibility bound applies to the NEXT measurement only',
    pg_temp.act(dev, format($$update specs set plausible_min = 0 where id = %L$$, spTemp)) = 'ok'
    and pg_temp.act(mem, format($$select record_spec_measurement(p_season_id => %L, p_spec_id => %L, p_value_numeric => '-1', p_measured_at => %L, p_request_id => gen_random_uuid())$$, sA, spTemp, pg_temp.d(24))) = '22003'
    and (select measured = 10 from specs where id = spTemp));

  -- ========================================================================= season
  n0 := (select count(*) from spec_measurements where spec_id = spOther);
  q := pg_temp.act(mem, format($$select record_spec_measurement(p_season_id => %L, p_spec_id => %L, p_value_numeric => '1', p_measured_at => %L, p_request_id => gen_random_uuid())$$, sA, spOther, pg_temp.d(5)));
  perform pg_temp.chk('S1 recording against a specification of another season is refused', q = '23514'
    and (select count(*) from spec_measurements where spec_id = spOther) = n0, q);
  q := pg_temp.act(mem, format($$select record_spec_measurement(p_season_id => %L, p_spec_id => %L, p_value_numeric => '1', p_measured_at => %L, p_request_id => gen_random_uuid())$$, sB, spOther, pg_temp.d(5)));
  perform pg_temp.chk('S2 with the right season it is accepted, and the row carries that season',
    q = 'ok' and (select season_id = sB from spec_measurements where spec_id = spOther), q);
  perform pg_temp.chk('S3 a history row whose season differs from its specification''s is refused on every path',
    pg_temp.try(format($$insert into spec_measurements (spec_id, season_id, value_numeric, measured_at, measured_by, request_id) values (%L, %L, 1, now(), %L, gen_random_uuid())$$, spOther, sA, mem)) = '23514');
  perform pg_temp.chk('S4 a specification with history cannot move to another season',
    pg_temp.try(format($$update specs set season_id = %L where id = %L$$, sA, spOther)) = '23514');
  perform pg_temp.chk('S5 a season with measurements cannot be deleted',
    pg_temp.try(format($$delete from seasons where id = %L$$, sB)) <> 'ok' and exists (select 1 from seasons where id = sB));

  -- ==================================================================== correction
  select id into m3 from spec_measurements where spec_id = spMin and value_numeric = 88;   -- the current one, by mem
  perform pg_temp.chk('C0 the current value before the correction is 88', (select measured = 88 from specs where id = spMin));
  q := pg_temp.act(mem2, format($$select correct_spec_measurement(p_measurement_id => %L, p_reason => 'typo', p_value_numeric => '89', p_request_id => gen_random_uuid())$$, m3));
  perform pg_temp.chk('C1 another ordinary member cannot correct someone else''s measurement', q = '42501'
    and (select invalidated_at is null from spec_measurements where id = m3), q);
  q := pg_temp.act(mem, format($$select correct_spec_measurement(p_measurement_id => %L, p_reason => '   ', p_value_numeric => '89', p_request_id => gen_random_uuid())$$, m3));
  perform pg_temp.chk('C2 a correction needs a reason', q = '22023', q);
  q := pg_temp.act(mem, format($$select correct_spec_measurement(p_measurement_id => %L, p_reason => 'misread the dial', p_request_id => gen_random_uuid())$$, m3));
  perform pg_temp.chk('C3 a correction needs a value (withdrawing is a separate command)', q = '22004', q);
  n0 := (select count(*) from spec_measurements where spec_id = spMin);
  q := pg_temp.act(mem, format($$select correct_spec_measurement(p_measurement_id => %L, p_reason => 'misread the dial', p_value_numeric => '89', p_request_id => %L)$$, m3, r3));
  select id into m2 from spec_measurements where request_id = r3 and measured_by = mem;
  perform pg_temp.chk('C4 the author corrects their own confirmed value: a new row is appended, the old one is kept',
    q = 'ok' and (select count(*) from spec_measurements where spec_id = spMin) = n0 + 1 and exists (select 1 from spec_measurements where id = m3), q);
  perform pg_temp.chk('C5 the old row is marked invalidated with the reason, actor and time; its value is untouched',
    (select invalidated_at is not null and invalidated_by = mem and invalidation_reason = 'misread the dial' and value_numeric = 88 from spec_measurements where id = m3));
  perform pg_temp.chk('C6 the new row is a correction that points at the old one and keeps its measured time',
    (select origin = 'correction' and corrects_id = m3 and value_numeric = 89 and measured_at = pg_temp.d(20)::timestamptz from spec_measurements where id = m2));
  perform pg_temp.chk('C7 the current value is the corrected one, in the same transaction',
    (select measured = 89 and current_measurement_id = m2 from specs where id = spMin));
  perform pg_temp.chk('C8 the correction is audited with the reason and both values',
    (select count(*) from activity where entity = 'spec' and entity_id = spMin::text and action = 'measurement_corrected' and actor_id = mem
        and detail ->> 'reason' = 'misread the dial' and (detail ->> 'from')::numeric = 88 and (detail ->> 'to')::numeric = 89
        and detail ->> 'corrects' = m3::text) = 1);
  q := pg_temp.act(mem, format($$select correct_spec_measurement(p_measurement_id => %L, p_reason => 'again', p_value_numeric => '90', p_request_id => gen_random_uuid())$$, m3));
  perform pg_temp.chk('C9 a measurement that was already corrected cannot be corrected again', q = '22023', q);
  q := pg_temp.act(mem, format($$select correct_spec_measurement(p_measurement_id => %L, p_reason => 'misread the dial', p_value_numeric => '89', p_request_id => %L)$$, m3, r3));
  perform pg_temp.chk('C10 a retry of the same correction returns it and writes nothing more',
    q = 'ok' and (select count(*) from spec_measurements where spec_id = spMin) = n0 + 1
    and (select count(*) from activity where action = 'measurement_corrected' and entity_id = spMin::text) = 1, q);
  q := pg_temp.act(dev, format($$select correct_spec_measurement(p_measurement_id => %L, p_reason => 'administrator fix', p_value_numeric => '89.25', p_request_id => gen_random_uuid())$$, m2));
  perform pg_temp.chk('C11 a specification administrator can correct someone else''s measurement',
    q = 'ok' and (select measured = 89.25 and measured_by = dev from specs where id = spMin), q);
  perform pg_temp.chk('C12 an invalidated row can no longer be edited or un-invalidated',
    pg_temp.try(format($$update spec_measurements set invalidation_reason = 'x' where id = %L$$, m3)) = '42501'
    and pg_temp.try(format($$update spec_measurements set invalidated_at = null, invalidation_reason = null where id = %L$$, m3)) = '42501');

  -- invalidate: falls back to the next accepted observation, or to unmeasured
  q := pg_temp.act(head, format($$select invalidate_spec_measurement(%L, 'wrong specimen')$$, mHead));
  perform pg_temp.chk('X1 the author withdraws their measurement; the current value falls back to the next accepted one',
    q = 'ok' and (select measured = -20.5 from specs where id = spTemp), q);
  perform pg_temp.chk('X2 ...and the withdrawal is audited with its reason',
    (select count(*) from activity where entity = 'spec' and entity_id = spTemp::text and action = 'measurement_invalidated' and detail ->> 'reason' = 'wrong specimen') = 1);
  perform pg_temp.chk('X3 a retry of the same withdrawal is a no-op',
    pg_temp.act(head, format($$select invalidate_spec_measurement(%L, 'wrong specimen')$$, mHead)) = 'ok'
    and (select count(*) from activity where entity = 'spec' and entity_id = spTemp::text and action = 'measurement_invalidated') = 1);
  perform pg_temp.chk('X4 a withdrawal needs a reason and an authorised caller',
    pg_temp.act(mem, format($$select invalidate_spec_measurement(%L, '')$$, m1)) = '22023'
    and pg_temp.act(alum, format($$select invalidate_spec_measurement(%L, 'x')$$, m1)) = '42501'
    and pg_temp.act(mem2, format($$select invalidate_spec_measurement(%L, 'x')$$, m1)) = '42501');
  perform pg_temp.act(dev, format($$select invalidate_spec_measurement(id, 'test clean-up') from spec_measurements where spec_id = %L and invalidated_at is null$$, spTemp));
  select * into sp from spec_verdicts where id = spTemp;
  perform pg_temp.chk('X5 with no accepted observation left the specification is unmeasured and its cache empty (not zero)',
    sp.measured is null and sp.measured_by is null and sp.measured_at is null and sp.current_measurement_id is null and sp.verdict = 'unmeasured'
    and (select count(*) from spec_measurements where spec_id = spTemp) = 3);

  -- ============================================================= atomicity and audit
  -- Force a failure AFTER the history row is inserted: the cache update violates a
  -- temporary constraint, so the whole command must leave nothing behind.
  perform pg_temp.try('set constraints all immediate');
  perform pg_temp.chk('A0 the temporary constraint for the atomicity check is installed',
    pg_temp.try(format('alter table specs add constraint tmp_atomic check (id <> %L or measured is null or measured < 1000)', spEq)) = 'ok');
  n0 := (select count(*) from spec_measurements); n1 := (select count(*) from activity);
  q := pg_temp.act(mem, format($$select record_spec_measurement(p_season_id => %L, p_spec_id => %L, p_value_numeric => '5000', p_measured_at => %L, p_request_id => gen_random_uuid())$$, sA, spEq, pg_temp.d(5)));
  perform pg_temp.chk('A1 a failure after the insert rolls the whole save back (row, cache and event together)',
    q = '23514' and (select count(*) from spec_measurements) = n0 and (select count(*) from activity) = n1
    and (select measured is null and current_measurement_id is null from specs where id = spEq), q);
  execute 'alter table specs drop constraint tmp_atomic';
  perform pg_temp.chk('A2 no secret material is written to any spec activity row',
    (select count(*) from activity where entity = 'spec' and detail::text ~* '(password|token|secret|jwt|bearer)') = 0);

  select count(*) filter (where not ok), count(*) into nfail, ntotal from results;
  if nfail > 0 then
    raise exception E'SPEC MEASUREMENT CHECKS FAILED — % of % checks did not behave as expected.\n%\n\nFull run:\n%',
      nfail, ntotal,
      (select string_agg(label || coalesce(': ' || detail, ''), E'\n' order by n) from results where not ok),
      (select string_agg(case when ok then 'ok  ' else 'FAIL' end || '  ' || label, E'\n' order by n) from results);
  end if;
  raise exception E'SPEC MEASUREMENT CHECKS PASSED — all % checks behaved as expected. Every test row has been rolled back.\n%',
    ntotal, (select string_agg('ok    ' || label, E'\n' order by n) from results);
end
$test$;
