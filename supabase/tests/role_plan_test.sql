-- =============================================================================
--  Atomic role-plan checks (20260111000000_atomic_role_plan.sql).
--
--  SAFE TO RUN AGAINST THE REAL PROJECT. Everything it creates happens inside
--  one block that always ends by raising an exception, so Postgres rolls every
--  change back. Nothing is left behind, pass or fail.
--
--  Run it in the Supabase SQL Editor, or with psql, after ALL migrations. The
--  result arrives as an "error" message that begins with
--      ROLE PLAN CHECKS PASSED   or   ROLE PLAN CHECKS FAILED
--  That "error" is the rollback doing its job.
--
--  What it proves:
--    * a non-president cannot call apply_role_plan at all
--    * a plan that only grants and revokes roles that leave a president in
--      place applies completely, in one call
--    * a plan that revokes the last president is refused, AND every other
--      change earlier in that SAME call — a grant that alone would have
--      succeeded — is rolled back with it: proof the whole call is one
--      transaction, not "apply until the first refusal" (the bug this
--      replaced)
--    * an "add" for a role already held, and a "remove" for a role already
--      not held, are both no-ops rather than errors (idempotent, matching
--      giveRole/takeRole's previous behaviour)
-- =============================================================================

create or replace function pg_temp.as_user(who uuid) returns void
language plpgsql as $fn$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', who, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', who::text, true);
end $fn$;

create or replace function pg_temp.note(
  inout lines text[], inout failures text[], label text, ok boolean, detail text default null
) returns record language plpgsql as $fn$
begin
  lines := lines || format('%s  %s%s', case when ok then 'ok  ' else 'FAIL' end, label,
    case when detail is null then '' else ' — ' || detail end);
  if not ok then
    failures := failures || format('%s%s', label, case when detail is null then '' else ': ' || detail end);
  end if;
end $fn$;

do $test$
declare
  pre uuid := gen_random_uuid();  -- the only president, going in
  vp  uuid := gen_random_uuid();  -- vice-president, holds one role already
  mem uuid := gen_random_uuid();  -- ordinary member, holds nothing
  lines    text[] := '{}';
  failures text[] := '{}';
begin
  insert into auth.users (id, email) values
    (pre, 'rp-pre@roles.test'), (vp, 'rp-vp@roles.test'), (mem, 'rp-mem@roles.test');
  insert into members (id, full_name, role) values
    (pre, 'RP President', 'President'), (vp, 'RP Vice', 'Operations'), (mem, 'RP Member', 'Chassis');
  insert into member_roles (member_id, role) values (pre, 'president'), (vp, 'vicepresident');

  -- --------------------------------------------------- unauthorized caller
  perform pg_temp.as_user(mem);
  begin
    perform apply_role_plan(jsonb_build_array(
      jsonb_build_object('member_id', mem, 'role', 'president', 'action', 'add')
    ));
    select * into lines, failures from pg_temp.note(lines, failures, 'a member cannot call apply_role_plan', false, 'no exception was raised');
  exception
    when insufficient_privilege then
      select * into lines, failures from pg_temp.note(lines, failures, 'a member cannot call apply_role_plan', true);
    when others then
      select * into lines, failures from pg_temp.note(lines, failures, 'a member cannot call apply_role_plan', false, format('wrong error: %s %s', sqlstate, sqlerrm));
  end;
  perform 1 from member_roles where member_id = mem and role = 'president';
  select * into lines, failures from pg_temp.note(lines, failures, 'the refused attempt granted nothing', not found);

  -- --------------------------------------------------- a valid plan, whole
  perform pg_temp.as_user(pre);
  perform apply_role_plan(jsonb_build_array(
    jsonb_build_object('member_id', mem, 'role', 'treasurer', 'action', 'add'),
    jsonb_build_object('member_id', vp,  'role', 'vicepresident', 'action', 'remove'),
    jsonb_build_object('member_id', mem, 'role', 'vicepresident', 'action', 'add')
  ));
  perform 1 from member_roles where member_id = mem and role = 'treasurer';
  select * into lines, failures from pg_temp.note(lines, failures, 'the grant landed', found);
  perform 1 from member_roles where member_id = vp and role = 'vicepresident';
  select * into lines, failures from pg_temp.note(lines, failures, 'the revoke landed', not found);
  perform 1 from member_roles where member_id = mem and role = 'vicepresident';
  select * into lines, failures from pg_temp.note(lines, failures, 'the second grant in the same plan landed too', found);
  perform 1 from member_roles where member_id = mem and role = 'treasurer' and assigned_by = pre;
  select * into lines, failures from pg_temp.note(lines, failures, 'assigned_by is the caller, not forgeable from the plan', found);

  -- ------------------------------------ idempotent add / idempotent remove
  perform apply_role_plan(jsonb_build_array(
    jsonb_build_object('member_id', mem, 'role', 'treasurer', 'action', 'add'),     -- already held
    jsonb_build_object('member_id', vp,  'role', 'vicepresident', 'action', 'remove')  -- already gone
  ));
  select * into lines, failures from pg_temp.note(lines, failures, 're-granting an already-held role does not error', true);
  perform 1 from member_roles where member_id = mem and role = 'treasurer';
  select * into lines, failures from pg_temp.note(lines, failures, 'still exactly the one treasurer row', found);

  -- ------------------ a plan that would leave no president: refused WHOLE
  --
  -- trg_guard_last_president looks at ALL of member_roles, not just this
  -- test's rows — on a seeded project pre is not really the only president,
  -- so removing it would be allowed and this check would prove nothing.
  -- Every other president is removed for the rest of this test so pre
  -- genuinely is the last one; the whole block still rolls back at the end,
  -- so nothing real is lost even for the moments in between.
  delete from member_roles where role = 'president' and member_id <> pre;

  begin
    perform apply_role_plan(jsonb_build_array(
      jsonb_build_object('member_id', mem, 'role', 'developer', 'action', 'add'),
      jsonb_build_object('member_id', pre, 'role', 'president', 'action', 'remove')
    ));
    select * into lines, failures from pg_temp.note(lines, failures, 'a plan that removes the last president is refused', false, 'no exception was raised');
  exception
    when others then
      select * into lines, failures from pg_temp.note(lines, failures,
        'a plan that removes the last president is refused',
        sqlerrm like 'The club must always have a president%', format('got %s %s', sqlstate, sqlerrm));
  end;
  perform 1 from member_roles where member_id = pre and role = 'president';
  select * into lines, failures from pg_temp.note(lines, failures, 'the president role was never actually removed', found);
  perform 1 from member_roles where member_id = mem and role = 'developer';
  select * into lines, failures from pg_temp.note(lines, failures,
    'the earlier grant in that SAME refused plan was rolled back too — not "apply until the first refusal"', not found);

  -- ------------------------------------------------------------------- verdict
  if array_length(failures, 1) > 0 then
    raise exception E'ROLE PLAN CHECKS FAILED — % of % checks did not behave as expected.\n%\n\nFull run:\n%',
      array_length(failures, 1), array_length(lines, 1),
      array_to_string(failures, E'\n'), array_to_string(lines, E'\n');
  end if;
  raise exception E'ROLE PLAN CHECKS PASSED — all % checks behaved as expected. Every test row has been rolled back.\n%',
    array_length(lines, 1), array_to_string(lines, E'\n');
end
$test$;
