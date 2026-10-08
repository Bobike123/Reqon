-- =============================================================================
--  Hosted migration-history repair: read-only before/after check (2026-10-02)
--
--  Run on the hosted project immediately BEFORE and immediately AFTER the
--  `supabase migration repair` commands in README §6a (SQL Editor, psql, or an
--  agent's read-only execute_sql). It writes nothing.
--
--  part = 'schema'  one row per catalog class of schema public (+ maintenance
--                   functions), hashed exactly like
--                   scripts/backend-completion/catalog-fingerprint.sql and
--                   compared with a fresh build of all 59 repository files
--                   (20260101000000 .. 20260130000000). Every row must say `ok`
--                   both times. The platform function rls_auto_enable() is
--                   left out (Supabase creates it; no repository file does).
--                   A new migration changes these hashes: the expected values
--                   are only valid while the repository has these 59 files.
--  part = 'data'    row count and content hash of every public table and of
--                   auth.users. The BEFORE and AFTER outputs must be identical
--                   (the repair touches supabase_migrations only).
--  part = 'history' supabase_migrations.schema_migrations: before the repair
--                   22 rows (platform timestamps); after it 59 rows whose
--                   versions are exactly the 59 repository versions.
-- =============================================================================
set search_path = "$user", public, extensions;

with
fn as (
  select 'function' c, p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' n,
    md5(regexp_replace(regexp_replace(p.prosrc,'--[^\n]*','','g'),'\s+',' ','g')||p.prosecdef::text||coalesce(p.proconfig::text,'')||pg_get_function_result(p.oid)) h
  from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
  where ns.nspname='public' and p.prokind in ('f','p') and p.proname <> 'rls_auto_enable'
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
  where ns.nspname='public' and p.prokind in ('f','p') and p.proname <> 'rls_auto_enable'
    and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')
),
pub as (
  select 'publication' c, 'supabase_realtime' n, md5(coalesce(string_agg(tablename, ',' order by tablename),'')) h from pg_publication_tables where pubname='supabase_realtime' and schemaname='public'
),
rls as (
  select 'rls' c, relname n, md5(relrowsecurity::text||relforcerowsecurity::text) h from pg_class cl join pg_namespace ns on ns.oid=cl.relnamespace where ns.nspname='public' and relkind in ('r','p')
),
fcm as (
  select 'fn_comment' c, p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' n, md5(coalesce(obj_description(p.oid,'pg_proc'),'')) h
  from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
  where ns.nspname='public' and p.prokind in ('f','p') and p.proname <> 'rls_auto_enable'
    and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')
),
tcm as (
  select 'rel_comment' c, cl.relname n, md5(coalesce(obj_description(cl.oid,'pg_class'),'')) h
  from pg_class cl join pg_namespace ns on ns.oid=cl.relnamespace where ns.nspname='public' and cl.relkind in ('r','v','p')
),
ccm as (
  select 'col_comments' c, cl.relname n, md5(string_agg(a.attname||':'||coalesce(col_description(cl.oid,a.attnum),''), '|' order by a.attname)) h
  from pg_class cl join pg_namespace ns on ns.oid=cl.relnamespace join pg_attribute a on a.attrelid=cl.oid and a.attnum>0 and not a.attisdropped
  where ns.nspname='public' and cl.relkind in ('r','v','p') group by cl.relname
),
mfn as (
  select 'maint_fn' c, p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' n,
    md5(regexp_replace(regexp_replace(p.prosrc,'--[^\n]*','','g'),'\s+',' ','g')||p.prosecdef::text||coalesce(p.proconfig::text,'')) h
  from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='maintenance'
),
allx as (
  select c, n, left(h,8) h from (
    select * from fn union all select * from col union all select * from con union all select * from idx union all
    select * from trg union all select * from pol union all select * from vw union all select * from en union all
    select * from gr union all select * from fg union all select * from pub union all select * from rls union all
    select * from fcm union all select * from tcm union all select * from ccm union all select * from mfn) x
),
actual as (
  select c, count(*)||' '||left(md5(string_agg(n||'|'||h, E'\n' order by n collate "C")),12) v from allx group by c
),
expected(c, v) as (values
  ('columns','33 b6b753f345d5'), ('constraints','27 9064b96d4a36'), ('enums','8 7f68caca62de'),
  ('fn_execute','127 cc8205d8f5f7'), ('function','127 14d44b1bab70'), ('grants','33 32c920ef2dff'),
  ('indexes','27 24f23416c3e5'), ('policies','27 821818d23a1e'), ('publication','1 b8d8a9211c79'),
  ('rls','27 888b0544305a'), ('triggers','22 bb7fd1d83fe3'), ('views','6 15f5fa118d47'),
  ('col_comments','33 11e8b8146abd'), ('fn_comment','127 bb5fb85e2a70'), ('maint_fn','6 a81fbc32980b'),
  ('rel_comment','33 e4895afc6017')
),
repo_versions(v) as (values
  ('20260101000000'),('20260101000001'),('20260102000000'),('20260103000000'),('20260104000000'),('20260105000000'),
  ('20260106000000'),('20260107000000'),('20260108000000'),('20260109000000'),('20260110000000'),('20260111000000'),
  ('20260112000000'),('20260113000000'),('20260114000000'),('20260115000000'),('20260116000000'),('20260117000000'),
  ('20260118000000'),('20260119000000'),('20260120000000'),('20260121000000'),('20260122000000'),('20260123000000'),
  ('20260124000000'),('20260125000000'),('20260125000100'),('20260125000200'),('20260125000300'),('20260125000400'),
  ('20260125000500'),('20260125000600'),('20260126000000'),('20260126000100'),('20260126000200'),('20260126000300'),
  ('20260126000400'),('20260126000500'),('20260126000600'),('20260126000700'),('20260127000000'),('20260127000100'),
  ('20260127000200'),('20260127000300'),('20260128000000'),('20260128000100'),('20260128000200'),('20260128000300'),
  ('20260128000400'),('20260128000500'),('20260129000000'),('20260129000100'),('20260129000200'),('20260129000300'),
  ('20260129000400'),('20260129000500'),('20260129000600'),('20260129000700'),('20260130000000')
),
hist as (select version from supabase_migrations.schema_migrations)
select 'schema' as part, e.c as item, coalesce(a.v, '(missing)') as value,
       case when a.v = e.v then 'ok' else 'DIFFERS (expected ' || e.v || ')' end as verdict
from expected e left join actual a on a.c = e.c
union all
select 'schema', a.c, a.v, 'UNEXPECTED class' from actual a where a.c not in (select c from expected)
union all
select 'data', c.relname,
  (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', c.relname), false, true, '')))[1]::text || ' ' ||
  left((xpath('/row/h/text()', query_to_xml(format('select md5(coalesce(string_agg(x::text, %L order by x::text), %L)) as h from public.%I x', E'\n', '', c.relname), false, true, '')))[1]::text, 12),
  'compare before/after'
from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
where ns.nspname = 'public' and c.relkind = 'r'
union all
select 'data', 'auth.users', count(*) || ' ' || left(md5(coalesce(string_agg(id::text, ',' order by id), '')), 12), 'compare before/after'
from auth.users
union all
select 'history', 'rows', (select count(*) from hist)::text,
  case when (select count(*) from hist) = 59 and not exists (select v from repo_versions except select version from hist)
            and not exists (select version from hist except select v from repo_versions)
       then 'ok: exactly the 59 repository versions'
       else 'not reconciled: ' || (select count(*) from repo_versions where v not in (select version from hist)) || ' repository versions missing, '
            || (select count(*) from hist where version not in (select v from repo_versions)) || ' foreign versions' end
order by 1, 2;
