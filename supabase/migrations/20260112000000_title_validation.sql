-- =============================================================================
--  Title validation for user-authored task and proposal titles.
--
--  WHAT WAS WRONG. Nothing stopped a blank or absurdly long title reaching
--  `tasks.title` or `task_proposals.title` through the Data API directly — the
--  UI trims and requires non-empty text before submitting (see
--  SuggestProposalForm.tsx, PromoteDialog.tsx), but a form is a convenience,
--  not a guarantee: a script or a future screen calling PostgREST straight
--  could write a blank title, or one long enough to break every layout that
--  assumes a task title fits on one line.
--
--  AFTER: the same rule `meetings.title` already enforces (20260108: trimmed
--  length between 1 and 200) now applies to tasks and task_proposals too — the
--  three user-authored title columns in this schema, made consistent rather
--  than each inventing its own bound. 200 also matches the maxLength already
--  used on task-title inputs (Gantt.tsx) and other free-text fields this size
--  (FinanceEntryDialog.tsx's description) — not a new number, the one already
--  chosen for text like this.
--
--  Deliberately NOT applied elsewhere: task.detail, task_proposals.context and
--  similar free-text fields are optional notes, not identifying titles, and
--  sprinkling the same bound across every text column in the schema would
--  constrain columns nobody asked to constrain.
--
--  Run AFTER 20260111. Idempotent: safe to run twice — and fails loudly rather
--  than silently, if any existing row would violate the new rule, exactly as
--  ordinary `ALTER TABLE ... ADD CONSTRAINT` already does.
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Enforce 1–200 trimmed characters on tasks.title and
--                   task_proposals.title at the database, not just the form.
--    Existing data  ADD CONSTRAINT validates every existing row; one violating
--                   row makes the migration fail with nothing changed. Check
--                   beforehand with:
--                     select id from tasks where length(btrim(title)) not between 1 and 200;
--                     select id from task_proposals where length(btrim(title)) not between 1 and 200;
--    New objects    CHECK constraints tasks_title_not_blank,
--                   task_proposals_title_not_blank.
--    Locking        ADD CONSTRAINT takes an ACCESS EXCLUSIVE lock on each
--                   table while it scans existing rows: reads and writes to
--                   that table wait for the scan (small tables here).
--    Authorization  Unchanged.
--    Rollback       ALTER TABLE ... DROP CONSTRAINT for each. No data effect.
--    Deploy order   Independent of the frontend (the UI already enforces the
--                   same rule); apply any time after 20260111.
-- =============================================================================

do $$ begin
  alter table tasks add constraint tasks_title_not_blank
    check (length(btrim(title)) between 1 and 200);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table task_proposals add constraint task_proposals_title_not_blank
    check (length(btrim(title)) between 1 and 200);
exception when duplicate_object then null; end $$;
