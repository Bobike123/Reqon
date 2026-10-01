-- =============================================================================
--  Specification evidence (backend completion Phase 4): migrations 20260129000300
--  (team / competition context), 0400 (readiness) and 0500 (direction review and the
--  verdict view); PERMISSIONS.md §8.
--
--  SAFE TO RUN AGAINST THE REAL PROJECT: one DO block that always raises, so every
--  fixture rolls back. Fixture people are new @p4-spec.test identities; fixture
--  specifications are named "PSPEC ...".
--
--  Result: SPEC EVIDENCE CHECKS PASSED / FAILED.
--
--  Covers: team and competition observations are separate (the competition value never becomes
--  current, feeds a verdict or affects readiness); who may record competition evidence; units;
--  finite / plausible / boundary validation for min, max, range, exact and boolean; retry
--  identity; deterministic current value with tied timestamps, backdated records and corrections;
--  readiness (a person confirms one exact passing measurement with a note; lapses on a newer
--  measurement, a correction, a withdrawal or a changed target; never returns by itself; passing
--  or meeting a goal alone is never green); direction review (unreviewed until confirmed, goals
--  need a reviewed direction, unknown stays unknown); append-only readiness history.
-- =============================================================================

create or replace function pg_temp.q(who uuid, expr text) returns text language plpgsql as $fn$
declare r text;
begin
  if who is null then
    perform set_config('role', 'anon', true);
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    perform set_config('request.jwt.claim.sub', '', true);
  else
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', who::text, true);
  end if;
  begin
    execute 'select (' || expr || ')::text' into r;
  exception
    when insufficient_privilege then r := 'DENIED';
    when others then r := 'ERROR ' || sqlstate || ': ' || sqlerrm;
  end;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  return coalesce(r, 'null');
end $fn$;

create or replace function pg_temp.attempt(who uuid, stmt text) returns text language plpgsql as $fn$
declare n bigint; result text;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', who::text, true);
  begin
    execute stmt;
    get diagnostics n = row_count;
    result := case when n > 0 then 'ALLOWED' else 'DENIED' end;
  exception
    when insufficient_privilege then result := 'DENIED';
    when others then result := 'ERROR ' || sqlstate || ': ' || sqlerrm;
  end;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  return result;
end $fn$;

create temp table results (n serial, label text, got text, expected text);
create or replace function pg_temp.expect(label text, got text, expected text) returns void
language sql as $fn$ insert into pg_temp.results (label, got, expected) values (label, got, expected); $fn$;

-- Record an observation as `who`; returns the new measurement id, or DENIED / ERROR <state>: <message>.
create or replace function pg_temp.rec(who uuid, p_spec uuid, p_value numeric, p_at timestamptz default null,
  p_ctx text default 'team', p_req uuid default gen_random_uuid(), p_unit text default null, p_bool boolean default null)
returns text language sql as $fn$
  select pg_temp.q(who, format('(record_spec_measurement(%L, %L, %L, %L, %L, %L, null, null, %L, %L)).id',
    (select season_id from specs where id = p_spec), p_spec, p_req, p_value, p_bool, p_at, p_ctx, p_unit));
$fn$;

create or replace function pg_temp.cur(p_spec uuid) returns text language sql as $fn$
  select coalesce(current_measurement_id::text, 'none') from specs where id = p_spec;
$fn$;

do $test$
declare
  season uuid;
  pre uuid := gen_random_uuid(); vp uuid := gen_random_uuid(); dev uuid := gen_random_uuid();
  ha uuid := gen_random_uuid(); hb uuid := gen_random_uuid(); mem uuid := gen_random_uuid(); mem2 uuid := gen_random_uuid();
  pa text; pb text; cl text;
  s1 uuid; s2 uuid; s3 uuid; s4 uuid; s5 uuid; s6 uuid;
  m1 text; m2 text; m3 text; a text; b text;
  rid uuid := gen_random_uuid();
  t0 timestamptz := date_trunc('minute', now()) - interval '1 hour';
  n_before bigint;
  n_total int; n_bad int; v_report text;
begin
  select id into season from seasons where is_current limit 1;
  select c.clause_key into cl from clauses c join seasons s on s.regs_ref = c.regs_ref
   where s.id = season and c.subteam_key is not null order by c.clause_key limit 1;
  select subteam_key into pa from clauses where clause_key = cl;
  select key into pb from subteams where archived_at is null and parent_key is null and key <> pa order by sort_order, key limit 1;

  insert into auth.users (id, email)
  select id, k || '@p4-spec.test' from (values (pre, 'pre'), (vp, 'vp'), (dev, 'dev'), (ha, 'ha'), (hb, 'hb'), (mem, 'mem'), (mem2, 'mem2')) v(id, k);
  insert into members (id, full_name, role, status)
  select id, 'E ' || k, 'Member', 'active' from (values (pre, 'pre'), (vp, 'vp'), (dev, 'dev'), (ha, 'ha'), (hb, 'hb'), (mem, 'mem'), (mem2, 'mem2')) v(id, k);
  insert into member_roles (member_id, role) values (pre, 'president'), (vp, 'vicepresident'), (dev, 'developer');
  update subteams set lead_id = ha where key = pa;
  update subteams set lead_id = hb where key = pb;

  insert into specs (season_id, parameter, comparator, target, unit, clause_key, direction, plausible_min, plausible_max)
    values (season, 'PSPEC minimum mass', 'min', 100, 'kg', cl, 'higher_better', 0, 1000) returning id into s1;
  insert into specs (season_id, parameter, comparator, target_bool, clause_key, direction)
    values (season, 'PSPEC boolean', 'bool', true, cl, 'boolean') returning id into s2;
  insert into specs (season_id, parameter, comparator, target, target_max, target_min_inclusive, target_max_inclusive, direction)
    values (season, 'PSPEC range', 'range', 10, 20, true, false, 'range') returning id into s3;
  insert into specs (season_id, parameter, comparator, target, target_tolerance, unit, direction)
    values (season, 'PSPEC exact', 'eq', 50, 0.5, 'mm', 'exact') returning id into s4;
  insert into specs (season_id, parameter, comparator, target, unit, clause_key, direction, plausible_min, plausible_max)
    values (season, 'PSPEC maximum mass', 'max', 80, 'kg', cl, 'lower_better', 0, 1000) returning id into s5;
  insert into specs (season_id, parameter, comparator, target, unit, direction)
    values (season, 'PSPEC never measured', 'min', 5, 'V', 'higher_better') returning id into s6;

  -- ============================================ team and competition are separate
  m1 := pg_temp.rec(mem, s1, 105, t0);
  perform pg_temp.expect('any active member records a team observation', (m1 ~ '^[0-9a-f-]{36}$')::text, 'true');
  perform pg_temp.expect('... and it becomes the current value', (pg_temp.cur(s1) = m1)::text, 'true');
  perform pg_temp.expect('a member cannot record a competition result', pg_temp.rec(mem, s1, 90, t0 + interval '1 minute', 'competition'), 'DENIED');
  perform pg_temp.expect('nor the Head of another department', pg_temp.rec(hb, s1, 90, t0 + interval '1 minute', 'competition'), 'DENIED');
  a := pg_temp.rec(ha, s1, 90, t0 + interval '1 minute', 'competition');
  perform pg_temp.expect('the Head of the requirement''s department records one', (a ~ '^[0-9a-f-]{36}$')::text, 'true');
  perform pg_temp.expect('... it never becomes the current (ours) value', (pg_temp.cur(s1) = m1)::text, 'true');
  perform pg_temp.expect('... the team verdict is unaffected (passes at 105), the competition verdict is its own (fails at 90)',
    (select verdict || ':' || competition_verdict || ':' || (competition_value = 90)::text from spec_verdicts where id = s1), 'pass:fail:true');
  b := pg_temp.rec(vp, s1, 120, t0 + interval '2 minutes', 'competition');
  perform pg_temp.expect('the Vice President records a later competition result, which becomes the competition value',
    (select (competition_measurement_id = b::uuid and competition_value = 120)::text from spec_verdicts where id = s1), 'true');
  perform pg_temp.expect('a bad context is refused', pg_temp.rec(pre, s1, 1, null, 'league'), 'ERROR 22023%');
  perform pg_temp.expect('a member cannot correct a competition result',
    pg_temp.q(mem, format('(correct_spec_measurement(%L, ''typo'', gen_random_uuid(), 121)).id', b)), 'DENIED');
  a := pg_temp.q(ha, format('(correct_spec_measurement(%L, ''typo'', gen_random_uuid(), 121)).id', b));
  perform pg_temp.expect('the department''s Head can, and the correction keeps the competition context',
    (select context from spec_measurements where id::text = a), 'competition');
  perform pg_temp.expect('a member cannot withdraw a competition result',
    pg_temp.q(mem, format('(invalidate_spec_measurement(%L, ''no'')).id', a)), 'DENIED');

  -- ================================================================ units
  perform pg_temp.expect('a value entered in another unit than the specification''s is refused',
    pg_temp.rec(mem, s1, 220, t0 + interval '3 minutes', 'team', gen_random_uuid(), 'lb'), 'ERROR 22023%');
  perform pg_temp.expect('the specification''s own unit is accepted, whatever the case',
    (pg_temp.rec(mem, s1, 106, t0 + interval '3 minutes', 'team', gen_random_uuid(), 'KG') ~ '^[0-9a-f-]{36}$')::text, 'true');
  m2 := pg_temp.cur(s1);

  -- ====================================================== validation, boundaries
  perform pg_temp.expect('an empty value creates nothing', pg_temp.rec(mem, s1, null), 'ERROR 22004%');
  perform pg_temp.expect('NaN is refused', pg_temp.q(mem, format('(record_spec_measurement(%L, %L, gen_random_uuid(), ''NaN''::numeric)).id', season, s1)), 'ERROR 22003%');
  perform pg_temp.expect('infinity is refused', pg_temp.q(mem, format('(record_spec_measurement(%L, %L, gen_random_uuid(), ''Infinity''::numeric)).id', season, s1)), 'ERROR 22003%');
  perform pg_temp.expect('below the plausible minimum is refused', pg_temp.rec(mem, s1, -1), 'ERROR 22003%');
  perform pg_temp.expect('above the plausible maximum is refused', pg_temp.rec(mem, s1, 1001), 'ERROR 22003%');
  perform pg_temp.expect('a number and a yes/no together are refused', pg_temp.rec(mem, s1, 5, null, 'team', gen_random_uuid(), null, true), 'ERROR 22023%');
  perform pg_temp.expect('a yes/no for a numeric specification is refused', pg_temp.rec(mem, s1, null, null, 'team', gen_random_uuid(), null, true), 'ERROR 22023%');
  perform pg_temp.expect('a number for a boolean specification is refused', pg_temp.rec(mem, s2, 1), 'ERROR 22023%');
  perform pg_temp.expect('a moment in the future is refused', pg_temp.rec(mem, s1, 100, now() + interval '2 days'), 'ERROR 22008%');
  perform pg_temp.expect('another season''s identity cannot be used for this specification',
    pg_temp.q(mem, format('(record_spec_measurement(%L, %L, gen_random_uuid(), 1)).id', gen_random_uuid(), s1)), 'ERROR 23514%');
  perform pg_temp.expect('minimum: exactly the target passes, just under fails',
    spec_regulatory_verdict('min', 100, null, null, null, null, null, 100, null) || ':' || spec_regulatory_verdict('min', 100, null, null, null, null, null, 99.999, null), 'pass:fail');
  perform pg_temp.expect('maximum: exactly the target passes, just over fails',
    spec_regulatory_verdict('max', 80, null, null, null, null, null, 80, null) || ':' || spec_regulatory_verdict('max', 80, null, null, null, null, null, 80.001, null), 'pass:fail');
  perform pg_temp.expect('range [10, 20): the inclusive end passes, the exclusive end fails, both sides just outside fail',
    spec_regulatory_verdict('range', 10, 20, true, false, null, null, 10, null) || ':' || spec_regulatory_verdict('range', 10, 20, true, false, null, null, 20, null) || ':'
    || spec_regulatory_verdict('range', 10, 20, true, false, null, null, 19.999, null) || ':' || spec_regulatory_verdict('range', 10, 20, true, false, null, null, 9.999, null), 'pass:fail:pass:fail');
  perform pg_temp.expect('exact 50 +- 0.5: the tolerance edge passes, beyond it fails',
    spec_regulatory_verdict('eq', 50, null, null, null, 0.5, null, 50.5, null) || ':' || spec_regulatory_verdict('eq', 50, null, null, null, 0.5, null, 50.51, null), 'pass:fail');
  perform pg_temp.expect('boolean: the wanted value passes, the other fails',
    spec_regulatory_verdict('bool', null, null, null, null, null, true, null, true) || ':' || spec_regulatory_verdict('bool', null, null, null, null, null, true, null, false), 'pass:fail');
  perform pg_temp.expect('a missing target is unevaluable, never a pass or a fail; nothing measured is unmeasured',
    spec_regulatory_verdict('min', null, null, null, null, null, null, 5, null) || ':' || spec_regulatory_verdict('min', 5, null, null, null, null, null, null, null), 'unevaluable:unmeasured');
  perform pg_temp.expect('a never-measured specification is unmeasured and grey, never a confirmed zero',
    (select verdict || ':' || zone || ':' || (measured is null)::text from spec_verdicts where id = s6), 'unmeasured:grey:true');

  -- ======================================================= retry identity
  select count(*) into n_before from spec_measurements where spec_id = s1;
  a := pg_temp.rec(mem, s1, 107, t0 + interval '4 minutes', 'team', rid);
  b := pg_temp.rec(mem, s1, 107, t0 + interval '4 minutes', 'team', rid);
  perform pg_temp.expect('a retry with the same request id returns the same observation and adds none',
    (a = b)::text || ':' || ((select count(*) from spec_measurements where spec_id = s1) - n_before)::text, 'true:1');
  perform pg_temp.expect('the same request id for a different value is refused', pg_temp.rec(mem, s1, 108, t0 + interval '4 minutes', 'team', rid), 'ERROR 23505%');
  a := pg_temp.rec(ha, s1, 107, t0 + interval '4 minutes', 'competition', rid);
  perform pg_temp.expect('... and for a different context (the same member and request id, now as a team value)',
    pg_temp.rec(ha, s1, 107, t0 + interval '4 minutes', 'team', rid), 'ERROR 23505%');
  perform pg_temp.expect('another member''s request id is theirs alone (the same id is a new save for someone else)',
    (pg_temp.rec(mem2, s1, 107.5, t0 + interval '5 minutes', 'team', rid) ~ '^[0-9a-f-]{36}$')::text, 'true');

  -- ==================================== deterministic current value (S5, clean slate)
  a := pg_temp.rec(mem, s5, 70, t0);
  b := pg_temp.rec(mem, s5, 71, t0 - interval '2 days');
  perform pg_temp.expect('a backdated observation adds history without displacing the newer current value', (pg_temp.cur(s5) = a)::text, 'true');
  -- Two observations with the very same measured time AND the same recorded time (one transaction): the id decides.
  a := pg_temp.rec(mem, s5, 72, t0 + interval '10 minutes');
  b := pg_temp.rec(mem2, s5, 73, t0 + interval '10 minutes');
  perform pg_temp.expect('tied measured and recorded times resolve by id, the same way every time',
    (pg_temp.cur(s5) = greatest(a::uuid, b::uuid)::text)::text, 'true');
  m3 := pg_temp.cur(s5);
  a := pg_temp.q(dev, format('(correct_spec_measurement(%L, ''misread'', gen_random_uuid(), 74)).origin', m3));
  perform pg_temp.expect('a correction is a new row of origin correction', a, 'correction');
  -- The correction keeps the measured time of the row it replaces, and is recorded in the same transaction as
  -- the other tied observation, so the id decides again: whichever has the greater id is current.
  perform pg_temp.expect('the current value is the greatest-id of the tied, still-accepted observations',
    (select measured::text from specs where id = s5),
    (select value_numeric::text from spec_measurements where spec_id = s5 and context = 'team' and invalidated_at is null
      and measured_at = t0 + interval '10 minutes' order by id desc limit 1));
  perform pg_temp.expect('the corrected row is invalidated with its reason, never rewritten',
    (select (invalidated_at is not null and invalidation_reason = 'misread' and value_numeric in (72, 73))::text from spec_measurements where id = m3::uuid), 'true');
  m3 := pg_temp.cur(s5);
  a := pg_temp.q(dev, format('(correct_spec_measurement(%L, ''older reading was wrong'', gen_random_uuid(), 60, null, %L)).id',
       (select id from spec_measurements where spec_id = s5 and value_numeric = 70), t0 - interval '3 days'));
  perform pg_temp.expect('a BACKDATED correction is recorded but leaves the newer observation current, deliberately',
    (a ~ '^[0-9a-f-]{36}$')::text || ':' || (pg_temp.cur(s5) = m3)::text, 'true:true');
  perform pg_temp.expect('history is append-only for everyone',
    pg_temp.attempt(dev, format('delete from spec_measurements where spec_id = %L', s5)) || ':' ||
    pg_temp.attempt(dev, format('update spec_measurements set value_numeric = 1 where spec_id = %L', s5)), 'DENIED:DENIED');

  -- ================================================================ readiness
  perform pg_temp.expect('passing alone is not green: a passing, never-checked specification is amber and not confirmed',
    (select zone || ':' || readiness from spec_verdicts where id = s1), 'amber:not_confirmed');
  m1 := pg_temp.cur(s1);
  perform pg_temp.expect('a member cannot confirm readiness', pg_temp.q(mem, format('(confirm_spec_readiness(%L, %L, ''checked'')).id', s1, m1)), 'DENIED');
  perform pg_temp.expect('nor the Head of another department', pg_temp.q(hb, format('(confirm_spec_readiness(%L, %L, ''checked'')).id', s1, m1)), 'DENIED');
  perform pg_temp.expect('a note of what was checked is required (whitespace is not a note)', pg_temp.q(ha, format('(confirm_spec_readiness(%L, %L, E''\n\t'')).id', s1, m1)), 'ERROR 23514%');
  perform pg_temp.expect('only the CURRENT measurement can be confirmed',
    pg_temp.q(ha, format('(confirm_spec_readiness(%L, %L, ''checked'')).id', s1, (select id from spec_measurements where spec_id = s1 and context = 'team' and id::text <> m1 limit 1))), 'ERROR 40001%');
  perform pg_temp.expect('a competition observation cannot be confirmed as ours',
    pg_temp.q(ha, format('(confirm_spec_readiness(%L, %L, ''checked'')).id', s1, (select id from spec_measurements where spec_id = s1 and context = 'competition' limit 1))), 'ERROR 40001%');
  a := pg_temp.q(ha, format('(confirm_spec_readiness(%L, %L, ''Weighed on the calibrated scale'')).id', s1, m1));
  perform pg_temp.expect('the Head of the requirement''s department confirms it', (a ~ '^[0-9a-f-]{36}$')::text, 'true');
  perform pg_temp.expect('... now green, ready, attributed',
    (select zone || ':' || readiness || ':' || (readiness_confirmed_by = ha)::text || ':' || (readiness_measurement_id = m1::uuid)::text from spec_verdicts where id = s1), 'green:ready:true:true');
  perform pg_temp.expect('confirming the same measurement again is a retry: the same confirmation, no second row',
    (pg_temp.q(ha, format('(confirm_spec_readiness(%L, %L, ''Weighed on the calibrated scale'')).id', s1, m1)) = a)::text || ':' || (select count(*)::text from spec_readiness where spec_id = s1), 'true:1');
  b := pg_temp.rec(ha, s1, 130, t0 + interval '20 minutes', 'competition');
  perform pg_temp.expect('a competition observation does not touch readiness or the zone', (select zone || ':' || readiness from spec_verdicts where id = s1), 'green:ready');
  perform pg_temp.expect('a member cannot withdraw a confirmation', pg_temp.q(mem, format('revoke_spec_readiness(%L, ''no'')', s1)), 'DENIED');

  -- a newer team measurement lapses it, durably
  m2 := pg_temp.rec(mem, s1, 109, t0 + interval '30 minutes');
  perform pg_temp.expect('a newer team measurement lapses the confirmation (automatic, with its reason)',
    (select readiness || ':' || zone || ':' || (readiness_reason like 'A newer measurement%')::text from spec_verdicts where id = s1), 'lapsed:amber:true');
  perform pg_temp.expect('... audited as a system lapse',
    (select count(*)::text from activity where entity = 'spec' and entity_id = s1::text and action = 'readiness_lapsed' and actor_id is null), '1');
  a := pg_temp.q(mem, format('(invalidate_spec_measurement(%L, ''wrong scale'')).id', m2));
  perform pg_temp.expect('withdrawing the newer reading does NOT bring the old confirmation back',
    (a ~ '^[0-9a-f-]{36}$')::text || ':' || (select readiness from spec_verdicts where id = s1), 'true:lapsed');
  perform pg_temp.expect('a lapsed confirmation reads "was ready", with when',
    (select (readiness_confirmed_at is not null and readiness_revoked_at is not null)::text from spec_verdicts where id = s1), 'true');

  -- re-confirm, then a correction of the checked measurement lapses it
  m1 := pg_temp.cur(s1);
  perform pg_temp.expect('someone confirms again on the (again) current measurement',
    (pg_temp.q(vp, format('(confirm_spec_readiness(%L, %L, ''Rechecked'')).id', s1, m1)) ~ '^[0-9a-f-]{36}$')::text, 'true');
  perform pg_temp.expect('... the previous confirmation stays in the history', (select count(*)::text from spec_readiness where spec_id = s1), '2');
  a := pg_temp.q(dev, format('(correct_spec_measurement(%L, ''misread'', gen_random_uuid(), 111)).id', m1));
  perform pg_temp.expect('a specification administrator corrects the checked measurement', (a ~ '^[0-9a-f-]{36}$')::text, 'true');
  perform pg_temp.expect('... which lapses the confirmation',
    (select readiness from spec_verdicts where id = s1), 'lapsed');
  m1 := pg_temp.cur(s1);
  perform pg_temp.expect('confirm once more',
    (pg_temp.q(dev, format('(confirm_spec_readiness(%L, %L, ''Rechecked after correction'')).id', s1, m1)) ~ '^[0-9a-f-]{36}$')::text, 'true');

  -- a changed target lapses it
  perform pg_temp.expect('a specification administrator changes the target', pg_temp.attempt(dev, format('update specs set target = 90 where id = %L', s1)), 'ALLOWED');
  perform pg_temp.expect('... the confirmation lapses because the rule changed',
    (select readiness || ':' || coalesce(readiness_reason, '-') || ':' || zone from spec_verdicts where id = s1), 'lapsed:The rule or the targets of this specification changed.:amber');
  perform pg_temp.expect('a member cannot change a target', pg_temp.attempt(mem, format('update specs set target = 1 where id = %L', s1)), 'DENIED');

  -- explicit withdrawal, and the history cannot be edited
  m1 := pg_temp.cur(s1);
  perform pg_temp.q(ha, format('(confirm_spec_readiness(%L, %L, ''Rechecked against the new target'')).id', s1, m1));
  perform pg_temp.expect('the Head withdraws it, with a reason', pg_temp.q(ha, format('revoke_spec_readiness(%L, ''Scale recalibration pending'')', s1)), 'true');
  perform pg_temp.expect('... withdrawing again is a harmless retry', pg_temp.q(ha, format('revoke_spec_readiness(%L, ''Scale recalibration pending'')', s1)), 'false');
  perform pg_temp.expect('readiness history cannot be edited, deleted or inserted directly, even by a Developer',
    pg_temp.attempt(dev, format('update spec_readiness set note = ''x'' where spec_id = %L', s1)) || ':' ||
    pg_temp.attempt(dev, format('delete from spec_readiness where spec_id = %L', s1)) || ':' ||
    pg_temp.attempt(dev, format('insert into spec_readiness (spec_id, season_id, measurement_id, note) values (%L, %L, %L, ''x'')', s1, season, m1)), 'DENIED:DENIED:DENIED');
  perform pg_temp.expect('nothing can be confirmed for a specification that was never measured',
    pg_temp.q(vp, format('(confirm_spec_readiness(%L, %L, ''x'')).id', s6, m1)), 'ERROR 40001%');

  -- ============================================================ direction review
  perform pg_temp.expect('a higher/lower direction derived from the rule is "not reviewed"; range, exact and boolean are not flagged',
    (select array_agg(direction_needs_review::text order by parameter)::text from spec_verdicts where id in (s1, s2, s3, s4)), '{false,false,true,false}');
  perform pg_temp.expect('a goal cannot be set on an unreviewed direction (unknown stays unknown)',
    pg_temp.attempt(dev, format('update specs set goal = 120 where id = %L', s1)), 'ERROR 23514%Review which way%');
  perform pg_temp.expect('a member cannot review a direction', pg_temp.q(mem, format('(review_spec_direction(%L, ''lower_better'', ''x'')).id', s1)), 'DENIED');
  perform pg_temp.expect('a note is required', pg_temp.q(dev, format('(review_spec_direction(%L, ''lower_better'', E''  \n'')).id', s1)), 'ERROR 23514%');
  perform pg_temp.expect('a range specification has no higher/lower direction to review', pg_temp.q(dev, format('(review_spec_direction(%L, ''lower_better'', ''x'')).id', s3)), 'ERROR 22023%');
  perform pg_temp.expect('the Developer reviews it and may flip it (a floor set by the rules can still mean lighter is better)',
    pg_temp.q(dev, format('(review_spec_direction(%L, ''lower_better'', ''A heavier bike is slower; the rule is only a floor'')).direction', s1)), 'lower_better');
  perform pg_temp.expect('... it is now reviewed, by whom and when',
    (select (direction_reviewed_by = dev and direction_reviewed_at is not null and not direction_needs_review)::text from spec_verdicts where id = s1), 'true');
  perform pg_temp.expect('the same review again is a retry',
    pg_temp.q(dev, format('(review_spec_direction(%L, ''lower_better'', ''A heavier bike is slower; the rule is only a floor'')).direction', s1)), 'lower_better');
  a := pg_temp.attempt(dev, format('update specs set goal = 95, acceptable = 100 where id = %L', s1));
  perform pg_temp.expect('now a goal may be set', a, 'ALLOWED');
  perform pg_temp.expect('... and it is scored the reviewed way round (111 kg is heavier than the 100 kg acceptable limit: unacceptable)',
    (select goal_status from spec_verdicts where id = s1), 'unacceptable');
  perform pg_temp.expect('editing a direction by hand makes it unreviewed again, so with goals set the edit is refused',
    pg_temp.attempt(dev, format('update specs set direction = ''higher_better'' where id = %L', s1)), 'ERROR 23514%');

  perform pg_temp.q(dev, format('(review_spec_direction(%L, ''lower_better'', ''Lighter is faster'')).id', s5));
  perform pg_temp.attempt(dev, format('update specs set goal = 76 where id = %L', s5));
  perform pg_temp.expect('meeting the goal and passing the rule together is still only amber until a person confirms',
    (select goal_status || ':' || verdict || ':' || zone from spec_verdicts where id = s5), 'met:pass:amber');
  perform pg_temp.expect('nothing was reviewed on the club''s behalf: an untouched specification is flagged',
    (select direction_needs_review::text from spec_verdicts where id = s6), 'true');

  -- Review finding: the goal guard fires on the write that SETS a target or the direction, not on every edit.
  update specs set goal = 5 where id = s6;  -- a goal that arrived some other way (import), direction still unreviewed
  perform pg_temp.expect('an edit that touches no target or direction is allowed although a goal is held on an unreviewed direction',
    pg_temp.attempt(dev, format('update specs set plausible_max = 9 where id = %L', s6)), 'ALLOWED');
  perform pg_temp.expect('... but changing that goal is still refused until the direction is reviewed',
    pg_temp.attempt(dev, format('update specs set goal = 6 where id = %L', s6)), 'ERROR 23514%');
  update specs set goal = null, plausible_max = null where id = s6;
  -- Review finding: a lapse is never stamped before the confirmation it ends (both use clock_timestamp()).
  perform pg_temp.expect('no revoked confirmation reads as revoked before it was confirmed',
    (select coalesce(bool_and(revoked_at >= confirmed_at), true)::text from spec_readiness where revoked_at is not null), 'true');

  -- A failing current measurement cannot be confirmed ready.
  perform pg_temp.rec(mem, s5, 90, t0 + interval '40 minutes');
  perform pg_temp.expect('a measurement that fails the requirement cannot be confirmed ready',
    pg_temp.q(vp, format('(confirm_spec_readiness(%L, %L, ''checked'')).id', s5, pg_temp.cur(s5))), 'ERROR 22023%');

  select count(*), count(*) filter (where not (got like expected)),
         string_agg(case when not (got like expected) then format('  FAIL  %s — expected %s, got %s', label, expected, got) end, E'\n' order by n)
    into n_total, n_bad, v_report from pg_temp.results;
  if n_bad > 0 then
    raise exception E'SPEC EVIDENCE CHECKS FAILED — % of % checks did not behave as expected.\n%', n_bad, n_total, v_report;
  end if;
  raise exception 'SPEC EVIDENCE CHECKS PASSED — all % checks', n_total;
end
$test$;
