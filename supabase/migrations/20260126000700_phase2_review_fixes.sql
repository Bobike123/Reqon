-- =============================================================================
--  Backend completion Phase 2: fixes from the Phase 2 security review
--  (docs/backend-completion/phase-02.md §6). Forward fix; 20260126000100 and
--  20260126000400 are already applied to the local stack and stay unchanged.
--
--  WHAT WAS WRONG (both Low, neither a privilege gain over the President/VP's
--  existing department powers, but both disagreed with PERMISSIONS.md).
--   1. set_proposal_department() let any active President or Vice President move
--      a proposal unconditionally. PERMISSIONS §2.3 allows them only as the
--      no-Head governance fallback (F): moving a proposal out of a department
--      that HAS a Head would sidestep that Head's review (§3.3).
--   2. can_grant_role(NULL) fell through CASE to the "else" branch and answered
--      true for the President/VP/Developer, although its comment says NULL ->
--      false. Not reachable (member_roles.role is NOT NULL; a null role in
--      apply_role_plan fails before any write), but the helper must be exact.
--
--  AFTER.
--   1. set_proposal_department(): Developer; the author while 'open'; a Head of
--      both source and target; the President/VP only where
--      department_authority(source) = 'governance_fallback' (the source has no
--      Head, or the proposal has no department yet). Everything else unchanged.
--   2. can_grant_role(NULL) = false.
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Align two Phase 2 functions with PERMISSIONS.md.
--    Existing data  None.
--    Authorization  Narrower only.
--    Locking        CREATE OR REPLACE FUNCTION: catalog locks only.
--    Rollback       Re-create the 20260126000100 / 20260126000400 bodies.
--    Deploy order   After 20260126000600. Grants are kept by CREATE OR REPLACE.
-- =============================================================================

create or replace function can_grant_role(p_role privileged_role) returns boolean
language sql stable security definer set search_path = public as $fn$
  select case
    when p_role is null then false
    when p_role = 'developer' then has_role('developer')
    when p_role in ('president', 'vicepresident') then has_role('president') or has_role('developer')
    else has_role('president') or has_role('vicepresident') or has_role('developer')
  end;
$fn$;

create or replace function set_proposal_department(p_proposal_id uuid, p_subteam_key text, p_reason text)
returns task_proposals
language plpgsql security definer set search_path = public as $fn$
declare
  v task_proposals%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_allowed boolean;
begin
  if auth.uid() is null or not is_active_member() then
    raise exception 'Only an active member may move a proposal between departments.' using errcode = '42501';
  end if;
  if v_reason is null or length(v_reason) > 500 then
    raise exception 'Say why the proposal changes department (1 to 500 characters).' using errcode = '23514';
  end if;
  if p_subteam_key is null then
    raise exception 'A proposal needs a department.' using errcode = '23502';
  end if;

  v := lock_proposal_for_command(p_proposal_id);
  if v.archived_at is not null or v.state = 'decided' then
    raise exception 'Only an unresolved proposal can move to another department.' using errcode = '22023';
  end if;
  if v.subteam_key is not distinct from p_subteam_key then
    return v;
  end if;

  perform 1 from subteams where key = p_subteam_key for share;
  if not exists (select 1 from subteams where key = p_subteam_key and archived_at is null) then
    raise exception 'A proposal can only belong to an active department.' using errcode = '23514';
  end if;

  v_allowed := is_developer()
    or (v.raised_by = auth.uid() and v.state = 'open')
    or coalesce(department_authority(v.subteam_key) = 'governance_fallback', false)
    or (v.subteam_key is not null
        and coalesce(department_authority(v.subteam_key) in ('head', 'parent_head'), false)
        and coalesce(department_authority(p_subteam_key) in ('head', 'parent_head'), false));
  if not v_allowed then
    raise exception 'Only the author (before review), a Head of both departments, a Developer, or the '
      'President or Vice President for a department without a Head may move this proposal.'
      using errcode = '42501';
  end if;

  perform set_config('reqon.change_reason', v_reason, true);
  perform set_config('reqon.proposal_write', 'on', true);
  update task_proposals set subteam_key = p_subteam_key where id = p_proposal_id returning * into v;
  perform set_config('reqon.proposal_write', 'off', true);
  perform set_config('reqon.change_reason', '', true);

  return v;
end $fn$;
