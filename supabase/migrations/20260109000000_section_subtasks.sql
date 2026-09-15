-- =============================================================================
--  One task system, not two.
--
--  The Gantt screen reads the three levels the schema already has: a submission
--  (milestones), the subdocuments inside it (milestone_sections), and the work
--  each subdocument needs. Only the third level was missing, and the tempting
--  thing to do was give it its own table.
--
--  It does not get one. A subtask IS a board task that names the section it
--  belongs to, so status, owner and due date live in exactly one row. Move a
--  card on the Board and the Gantt moves with it, because it is the same task.
--
--  Nullable, and it stays nullable: every task that exists today belongs to no
--  section and most never will. `on delete set null` so unpicking a section
--  from a milestone checklist never silently deletes the team's work.
--
--  Run AFTER 20260108. Idempotent: safe to run twice.
-- =============================================================================

alter table tasks add column if not exists section_id uuid
  references milestone_sections(id) on delete set null;

create index if not exists tasks_section on tasks (section_id);

comment on column tasks.section_id is
  'The milestone section this task is a subtask of, if any. The Gantt groups by '
  'it; the Board ignores it. Never a copy of the task — there is only one row.';

-- No new policies. `tasks` already says who may do what (20260108): an
-- administrator creates one, anyone on the roster moves it and picks its owner,
-- and only the president or a developer deletes it. Linking a task to a section
-- is an ordinary update, so it needs nothing extra.
