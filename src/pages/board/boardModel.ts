// The overdue rule lives in tasks/overdue.ts, shared with the Gantt, so no
// screen can drift into its own definition of "late". Re-exported here so the
// Board's own imports keep working.
export { isOverdue } from '../../tasks/overdue.ts'
