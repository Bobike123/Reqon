-- Pin the search_path of the two helpers 20260125000100 created without one
-- (Supabase advisor 0011, function_search_path_mutable). Neither is reachable
-- by an API role — the maintenance schema grants no USAGE — and neither looks
-- up a relation, so this only closes the lint. Idempotent.
alter function maintenance.checked_json(text, text) set search_path = pg_catalog;
alter function maintenance.legacy_department_target(text) set search_path = pg_catalog;
