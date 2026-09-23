import { useState } from 'react'
import { buildSeasonExport, downloadJson } from '../../data/exportSeason.ts'
import { useCurrentSeason } from '../../data/useCurrentSeason.ts'
import { todayIso } from '../../lib/dates.ts'

// The season handover download. Its own data (useCurrentSeason), its own
// exporting/error state — nothing else on the page depends on it.
export function SeasonExport() {
  const currentSeason = useCurrentSeason()
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  async function doExport() {
    if (!currentSeason.data?.id) return
    setExporting(true)
    setExportError(null)
    try {
      const data = await buildSeasonExport(currentSeason.data.id)
      const label = String(currentSeason.data.label ?? 'season').replace(/\W+/g, '-')
      downloadJson(`reqon-${label}-${todayIso()}.json`, data)
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Export failed')
    } finally {
      setExporting(false)
    }
  }

  return (
    <>
      <p className="mb-2 text-xs text-slate-500">
        The team&apos;s work this season as one JSON file: rules, tasks, proposals, meetings,
        milestones, measurements, handover notes and the change log. Of the roster it
        includes only name, job title and status — so owner ids resolve — and never phone
        numbers, private notes, emails, passwords or keys. The regulations book and the
        finance ledger are not included.
      </p>
      {exportError && (
        <p role="alert" className="mb-2 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          {exportError}
        </p>
      )}
      <button
        type="button"
        onClick={() => void doExport()}
        disabled={exporting || !currentSeason.data}
        data-testid="export-button"
        className="min-h-11 rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 disabled:opacity-60 sm:min-h-0"
      >
        {exporting ? 'Preparing…' : 'Download season JSON'}
      </button>
    </>
  )
}
