import { runSql } from './db.ts'

// Every task/proposal an E2E spec creates through the real UI must be
// removed afterward — RLS refuses a normal DELETE for good reason (R14.2:
// no path physically deletes a task or proposal), so this uses the same
// superuser path global-teardown.ts uses for its own fixtures. Specs tag
// every title they create with the same distinctive prefix so this can find
// them without tracking ids across page objects.
export function deleteTasksAndProposalsByTitlePrefix(prefix: string) {
  // Deleting a promoted task's own row first lets task_requirements cascade
  // with it in the same statement — deleting the link rows independently
  // first trips assert_task_links() (a promoted task must keep >= 1 link).
  runSql(`delete from tasks where title like '${prefix}%'`)
  runSql(`delete from proposal_requirements where proposal_id in (select id from task_proposals where title like '${prefix}%')`)
  runSql(`delete from task_proposals where title like '${prefix}%'`)
}
