import type { Clause } from '../clauses/types.ts'

// The requirement picker's options. Identity is ALWAYS clause_key: printed_ref
// is not unique (20260103), so two rows can print the same reference. Where a
// printed reference is shared, the label adds what tells them apart (section,
// article) and the key itself, so a person can see they are different rules.
export type RequirementOption = {
  key: string
  ref: string
  summary: string
  // A label that is unique across the whole list.
  label: string
  duplicate: boolean
  search: string
}

const SUMMARY_LENGTH = 90

export function buildRequirementOptions(clauses: readonly Pick<Clause, 'clause_key' | 'printed_ref' | 'body' | 'section' | 'article' | 'article_title'>[]): RequirementOption[] {
  const counts = new Map<string, number>()
  for (const c of clauses) counts.set(c.printed_ref, (counts.get(c.printed_ref) ?? 0) + 1)
  return clauses.map((c) => {
    const duplicate = (counts.get(c.printed_ref) ?? 0) > 1
    const summary = c.body.length > SUMMARY_LENGTH ? `${c.body.slice(0, SUMMARY_LENGTH)}…` : c.body
    const where = [c.section && `section ${c.section}`, c.article != null && `article ${c.article}`, c.article_title]
      .filter(Boolean)
      .join(' ')
    const label = duplicate ? `${c.printed_ref} (${where}; key ${c.clause_key}) — ${summary}` : `${c.printed_ref} — ${summary}`
    return {
      key: c.clause_key,
      ref: c.printed_ref,
      summary,
      label,
      duplicate,
      search: `${c.printed_ref} ${c.clause_key} ${c.body} ${c.article_title ?? ''}`.toLowerCase(),
    }
  })
}

export const MAX_RESULTS = 30

// Matches every word typed, anywhere in the reference, key, wording or article
// title. Already-selected options are left in the results so they can be
// unticked from the same list.
export function searchRequirements(options: readonly RequirementOption[], text: string, limit = MAX_RESULTS): RequirementOption[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean)
  const hits = words.length === 0 ? options : options.filter((o) => words.every((w) => o.search.includes(w)))
  return hits.slice(0, limit)
}
