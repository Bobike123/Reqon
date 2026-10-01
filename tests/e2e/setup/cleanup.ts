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
  deleteProposalsWhere(`title like '${prefix}%'`)
}

// Removes proposals matching a SQL condition on task_proposals, with their
// requirement links and review discussion. proposal_comments is append-only
// (trg_guard_proposal_comment_rows refuses UPDATE and DELETE for everyone, so
// the discussion is real history) and references its proposal ON DELETE
// RESTRICT; a fixture that was never real history is removed with the same
// pause-the-guard pattern global-teardown.ts uses for spec measurements.
export function deleteProposalsWhere(condition: string) {
  const ids = `select id from task_proposals where ${condition}`
  runSql(`alter table proposal_comments disable trigger trg_guard_proposal_comment_rows`)
  try {
    runSql(`delete from proposal_comments where proposal_id in (${ids})`)
  } finally {
    runSql(`alter table proposal_comments enable trigger trg_guard_proposal_comment_rows`)
  }
  runSql(`delete from proposal_requirements where proposal_id in (${ids})`)
  runSql(`delete from task_proposals where ${condition}`)
}
