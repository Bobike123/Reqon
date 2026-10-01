-- Catalog fingerprint of the `public` schema: one row per object, `class|name|hash8`.
-- Read-only (catalog views only). Run the SAME file against two databases and diff the output; it is how
-- rehearse-phase5.sh proves "fresh install == upgrade" and how the runbook proves "hosted == repository".
-- Function bodies are compared with comments and whitespace removed; hashes cover signatures, security
-- definer flag, search_path setting, result type, constraints, index/trigger/view definitions, policies
-- (command, roles, USING, WITH CHECK), grants to the API roles, EXECUTE rights per API role, RLS flags, and
-- the realtime publication. Platform-owned extension objects are ignored.
with
fn as (
  select 'function' c, p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' n,
    md5(regexp_replace(regexp_replace(p.prosrc,'--[^\n]*','','g'),'\s+',' ','g')||p.prosecdef::text||coalesce(p.proconfig::text,'')||pg_get_function_result(p.oid)) h
  from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
  where ns.nspname='public' and p.prokind in ('f','p')
    and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')
),
col as (
  select 'columns' c, c.table_name n,
    md5(string_agg(c.column_name||':'||c.data_type||':'||c.is_nullable||':'||coalesce(regexp_replace(c.column_default,'\s+',' ','g'),''), '|' order by c.column_name)) h
  from information_schema.columns c where c.table_schema='public' group by c.table_name
),
con as (
  select 'constraints' c, cl.relname n,
    md5(string_agg(co.conname||':'||regexp_replace(pg_get_constraintdef(co.oid),'\s+',' ','g'), '|' order by co.conname)) h
  from pg_constraint co join pg_class cl on cl.oid=co.conrelid join pg_namespace ns on ns.oid=cl.relnamespace
  where ns.nspname='public' group by cl.relname
),
idx as (
  select 'indexes' c, tablename n, md5(string_agg(indexname||':'||regexp_replace(indexdef,'\s+',' ','g'), '|' order by indexname)) h
  from pg_indexes where schemaname='public' group by tablename
),
trg as (
  select 'triggers' c, cl.relname n,
    md5(string_agg(t.tgname||':'||t.tgenabled::text||':'||regexp_replace(pg_get_triggerdef(t.oid),'\s+',' ','g'), '|' order by t.tgname)) h
  from pg_trigger t join pg_class cl on cl.oid=t.tgrelid join pg_namespace ns on ns.oid=cl.relnamespace
  where ns.nspname='public' and not t.tgisinternal group by cl.relname
),
pol as (
  select 'policies' c, tablename n,
    md5(string_agg(policyname||':'||cmd||':'||permissive||':'||roles::text||':'||coalesce(regexp_replace(qual,'\s+',' ','g'),'')||':'||coalesce(regexp_replace(with_check,'\s+',' ','g'),''), '|' order by policyname)) h
  from pg_policies where schemaname='public' group by tablename
),
vw as (
  select 'views' c, viewname n, md5(regexp_replace(definition,'\s+',' ','g')||coalesce((select reloptions::text from pg_class where oid=(quote_ident(schemaname)||'.'||quote_ident(viewname))::regclass),'')) h
  from pg_views where schemaname='public'
),
en as (
  select 'enums' c, t.typname n, md5(string_agg(e.enumlabel, ',' order by e.enumsortorder)) h
  from pg_type t join pg_enum e on e.enumtypid=t.oid join pg_namespace ns on ns.oid=t.typnamespace where ns.nspname='public' group by t.typname
),
gr as (
  select 'grants' c, table_name n, md5(string_agg(grantee||':'||privilege_type, ',' order by grantee, privilege_type)) h
  from information_schema.role_table_grants where table_schema='public' and grantee in ('anon','authenticated','service_role') group by table_name
),
fg as (
  select 'fn_execute' c, p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' n,
    md5(coalesce((select string_agg(r.rolname, ',' order by r.rolname) from pg_roles r where r.rolname in ('anon','authenticated','service_role') and has_function_privilege(r.rolname, p.oid, 'EXECUTE')),'')) h
  from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
  where ns.nspname='public' and p.prokind in ('f','p')
    and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')
),
pub as (
  select 'publication' c, 'supabase_realtime' n, md5(coalesce(string_agg(tablename, ',' order by tablename),'')) h from pg_publication_tables where pubname='supabase_realtime' and schemaname='public'
),
rls as (
  select 'rls' c, relname n, md5(relrowsecurity::text||relforcerowsecurity::text) h from pg_class cl join pg_namespace ns on ns.oid=cl.relnamespace where ns.nspname='public' and relkind in ('r','p')
),
allx as (select * from fn union all select * from col union all select * from con union all select * from idx union all select * from trg union all select * from pol union all select * from vw union all select * from en union all select * from gr union all select * from fg union all select * from pub union all select * from rls)
select c, n, left(h,8) h from allx order by c, n
