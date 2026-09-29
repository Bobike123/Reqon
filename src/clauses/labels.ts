// What the small labels on a Register row mean, defined once. The Register, the
// tutorial and any future screen read from here, so a label is never explained
// two different ways.
//
// Two kinds of label exist on a clause, and they are different columns:
//   * criticality — what happens if the team gets it wrong (NC RISK, PENALTY).
//   * obligation  — what KIND of rule it is (SPORTING, PROCESS, …). It says how
//     the rule is to be met, not how much it matters.
// PARKED is neither. It comes from the clause's DEPARTMENT and is about
// competition scope (the work only bites at the Final Event); it is unrelated
// to a department being archived (docs ADR-0001, R52.1).
//
// The wording of the obligation kinds is derived from the label itself and how
// the app uses it. The regulations source ships no glossary, so the club
// should review these sentences against the book (see the Phase 7 handoff).
export type LabelInfo = {
  // What is printed on the badge.
  label: string
  // One plain sentence that stands on its own, for people who cannot hover.
  summary: string
}

const CRITICALITY: Record<string, LabelInfo> = {
  blocking: {
    label: 'NC RISK',
    summary: 'Breaking this rule scores NC (not classified): the bike does not run.',
  },
  penalty: {
    label: 'PENALTY',
    summary: 'Breaking this rule risks MP, SP or NP penalty points.',
  },
}

export function criticalityInfo(criticality: string): LabelInfo | null {
  return CRITICALITY[criticality] ?? null
}

const OBLIGATION: Record<string, string> = {
  admin: 'An administrative rule: registration, fees, paperwork and how the team deals with the Organization.',
  constraint: 'A limit on the design, such as a size, mass or allowed range, that the bike must stay within.',
  deliverable: 'Something the team has to hand in, on time and in the required format.',
  info: 'Background or definition. It explains the competition and asks nothing of the team by itself.',
  process: 'A procedure to follow, such as a check, a sequence or how something is done at an event.',
  prohibition: 'Something the team must not do or must not fit.',
  requirement: 'Something the bike or the team must have or provide.',
  sporting: 'A rule about how the competition is run, scored or raced, rather than how the bike is built.',
  verification: 'A check or test that shows another rule is met, for example at scrutineering.',
}

export function obligationInfo(obligation: string): LabelInfo {
  return {
    label: obligation.toUpperCase(),
    summary:
      OBLIGATION[obligation] ?? `A rule of kind “${obligation}”. The regulations use this word for a group of related rules.`,
  }
}

export const PARKED_INFO: LabelInfo = {
  label: 'PARKED',
  summary:
    'The department that owns this rule is parked for competition scope: its work only applies at the Final Event, so it is dimmed for now. This is not the same as a department being archived.',
}
