import { useState, type ReactNode } from 'react'

// Settings → Backups → "How backups work": a short, step-by-step guide for the people who can open this page.
// Two audiences, one tab each. Diagrams are plain HTML (boxes and arrows), not images: they stay readable at
// phone width, follow the page's text size and can be read by a screen reader. Nothing here calls the database.

type Audience = 'leaders' | 'developer'

const TABS: readonly { id: Audience; label: string }[] = [
  { id: 'leaders', label: 'President & Vice President' },
  { id: 'developer', label: 'Developer' },
]

export function BackupsGuide({ defaultAudience = 'leaders' }: { defaultAudience?: Audience }) {
  const [audience, setAudience] = useState<Audience>(defaultAudience)

  return (
    <details className="rounded border border-slate-200 bg-white" data-testid="backups-guide" data-tutorial="backups-guide">
      <summary className="cursor-pointer p-3 text-sm font-medium text-slate-900">How backups work — step by step</summary>
      <div className="space-y-4 border-t border-slate-200 p-3">
        <Overview />

        <div role="tablist" aria-label="Guide for" className="flex flex-wrap gap-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`guide-tab-${t.id}`}
              aria-selected={audience === t.id}
              aria-controls={`guide-panel-${t.id}`}
              onClick={() => setAudience(t.id)}
              className={`rounded border px-3 py-1.5 text-sm ${
                audience === t.id ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white text-slate-800 hover:bg-slate-50'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div role="tabpanel" id={`guide-panel-${audience}`} aria-labelledby={`guide-tab-${audience}`} className="space-y-4">
          {audience === 'leaders' ? <LeadersGuide /> : <DeveloperGuide />}
        </div>
      </div>
    </details>
  )
}

/* ---------------------------------------------------------------- shared */

function Overview() {
  return (
    <div className="space-y-4">
      <Block title="The idea">
        <ul className={LIST}>
          <li>Every night the club data is copied, locked with a key, and stored in several places.</li>
          <li>If data is lost or damaged, a Developer brings it back from a copy.</li>
          <li>The copies are locked. Nobody can read one without a private key. The app does not have that key.</li>
        </ul>
      </Block>

      <Block title="What is in a backup">
        <ul className={LIST}>
          <li>Everything in the database: tasks, requirements, roster, departments, seasons, meetings, activity.</li>
          <li>Logins and password hashes, so people can sign in again after a restore.</li>
          <li>Not the attached files themselves. Photos, documents and videos are in file storage. A locked copy of them goes to Google Drive every Sunday.</li>
          <li>Not the Supabase settings or secrets. Those are set again by hand if the project is ever rebuilt.</li>
        </ul>
      </Block>

      <Diagram title="1 · Every night at 03:17 UTC" caption="What the scheduled backup does, in order.">
        <Flow
          steps={[
            { title: 'Database', detail: 'Read with a read-only login. It cannot change anything.' },
            { title: 'Copy and check', detail: 'The data is copied, then counted again. If it changed while copying, it tries again.' },
            { title: 'Lock', detail: 'The copy is encrypted for the key holders.' },
            { title: 'Store in Cloudflare R2', detail: 'Folder daily/. Kept 35 days.' },
            { title: 'Record the result', detail: 'This page shows it. Files whose 30 days after delete are over are removed from storage.' },
          ]}
        />
      </Diagram>

      <Diagram title="2 · Every Sunday, and on the 1st" caption="More copies, in different places, so one failure cannot lose everything.">
        <Fork
          from="The night's locked backup"
          branches={[
            { title: 'R2 weekly/', detail: 'Kept 26 weeks.' },
            { title: 'Private GitHub repository', detail: 'Newest 26 kept.' },
            { title: 'Google Drive', detail: 'Newest 8 kept, plus a locked copy of all attached files.' },
            { title: 'R2 monthly/ (on the 1st)', detail: 'Kept 24 months.' },
          ]}
        />
      </Diagram>

      <Diagram title="3 · Who can open a backup" caption="Locking uses a public key. Opening needs the matching private key.">
        <Flow
          steps={[
            { title: 'Public keys of the key holders', detail: 'Listed in the repository. Not secret.' },
            { title: 'Backup file is locked with all of them', detail: 'Each holder can open it alone.' },
            { title: 'Private key', detail: 'A file on the holder’s own computer. Never in the app, never in chat, never in email. Keep a second copy in a password manager.' },
          ]}
        />
      </Diagram>
    </div>
  )
}

/* -------------------------------------------------------- President & VP */

function LeadersGuide() {
  return (
    <div className="space-y-4" data-testid="guide-leaders">
      <Block title="Your job">
        <ul className={LIST}>
          <li>Look at the status above once a week.</li>
          <li>If it is not green, tell the Developer. Do not try to fix it yourself.</li>
          <li>Know that you can ask for a restore, and what to tell the Developer.</li>
        </ul>
      </Block>

      <Block title="Read the status">
        <ul className={LIST}>
          <li><strong>Green — “Backups are running.”</strong> Nothing to do.</li>
          <li><strong>Amber.</strong> The daily copy is fine, but a weekly copy (GitHub or Drive) is missing. Tell the Developer this week.</li>
          <li><strong>Red — “The daily backup needs attention.”</strong> No good backup for over 48 hours, or the last try failed. Tell the Developer today. Send the sentence shown on the page.</li>
          <li><strong>“No backup has run yet.”</strong> The club has no recovery copy. Tell the Developer at once.</li>
        </ul>
      </Block>

      <Block title="Download a backup (optional)">
        <ol className={ORDERED}>
          <li>Press “Download latest backup”.</li>
          <li>The file is saved on your computer. The link works for 10 minutes.</li>
          <li>The page shows a checksum (sha256). A Developer compares it to the file.</li>
          <li>You can open the file only if you hold a private key. Otherwise keep it as is.</li>
        </ol>
      </Block>

      <Block title="Asking for a restore">
        <ol className={ORDERED}>
          <li>Find out what is missing or wrong, and when it was last right.</li>
          <li>Do not edit or delete more in that area. New edits make a restore harder.</li>
          <li>Tell the Developer: what, where in the app, and the last time it was right.</li>
          <li>The Developer checks first and shows you what would change. Nothing is written before that.</li>
          <li>A restore brings back what was in the 03:17 UTC copy. Work done after that time may be gone.</li>
        </ol>
      </Block>

      <Diagram title="What happens when you ask" caption="The three ways to recover, from smallest to biggest.">
        <Cards
          items={[
            { title: 'A few rows are wrong', detail: 'The Developer puts back the old values for those rows only.' },
            { title: 'Rows are missing, the app works', detail: 'The Developer adds what is missing. Nothing live is changed. It can be undone.' },
            { title: 'The whole project is lost', detail: 'The Developer builds a new project and loads the full backup. Logins survive.' },
          ]}
        />
      </Diagram>

      <Block title="Keys and people">
        <ul className={LIST}>
          <li>“Readable by” on each backup shows how many keys can open it.</li>
          <li>New holder: they make their own key and send only the public part to a Developer.</li>
          <li>A holder leaves: tell a Developer to remove their key. Old backups stay readable by the old key. New ones do not.</li>
          <li>Never ask anyone to send you a private key.</li>
        </ul>
      </Block>
    </div>
  )
}

/* -------------------------------------------------------------- Developer */

function DeveloperGuide() {
  return (
    <div className="space-y-4" data-testid="guide-developer">
      <Block title="What runs where">
        <ul className={LIST}>
          <li><strong>Backup</strong> (GitHub Actions, <code>backup.yml</code>): daily 03:17 UTC. Run it by hand from the Actions tab; tick <em>force_weekly</em> to run the Sunday steps too.</li>
          <li><strong>Backup freshness</strong> (<code>backup-freshness.yml</code>): daily 09:47 UTC. Fails and emails the owners if the newest daily backup is older than 48 hours.</li>
          <li><strong>Restore drill</strong> (<code>restore-drill.yml</code>): Mondays 05:17 UTC. Restores the newest backup into a fresh project and compares it.</li>
          <li>This page is the independent signal: it turns red at 48 hours even if GitHub is silent.</li>
          <li>GitHub turns scheduled workflows off after 60 days without repository activity. That silences the backup and its check. This page still turns red.</li>
        </ul>
      </Block>

      <Block title="Each daily run, in detail">
        <ol className={ORDERED}>
          <li>Log in as <code>backup_reader</code> through the session pooler. It is read-only and has no password in the migrations.</li>
          <li>Refuse if the database is over 400 MB or the dump over 100 MB.</li>
          <li>Write a manifest (rows and md5 per table), dump <code>public</code> and <code>auth</code> separately, write the manifest again. If before and after differ, retry up to 3 times.</li>
          <li>Pack manifest and both dumps into one tar. Encrypt it with age to every key in <code>ops/backup/recipients.txt</code>.</li>
          <li>Upload to R2 <code>daily/</code> and compare the size. Sundays also <code>weekly/</code>, the 1st also <code>monthly/</code>.</li>
          <li>Sundays: push to the private repository, copy to Drive, mirror new attachment files to Drive encrypted.</li>
          <li>Call <code>backup-record</code> with the result, then <code>attachment-purge</code>.</li>
        </ol>
      </Block>

      <Block title="Open and check a backup">
        <ol className={ORDERED}>
          <li>Get a file: the button above, R2 <code>daily/ weekly/ monthly/</code>, the private repository, or Drive.</li>
          <li>Compare the checksum: <code>sha256sum reqon-backup-….tar.age</code>.</li>
          <li><code>ops/backup/verify.sh reqon-backup-….tar.age ~/reqon-backup.key</code> checks the checksum, decrypts, reads the manifest and the dumps.</li>
          <li>To look inside: <code>age -d -i ~/reqon-backup.key file.tar.age | tar -x</code> gives <code>manifest.json</code>, <code>public.dump</code>, <code>auth.dump</code>.</li>
        </ol>
        <p className="mt-2 text-xs text-slate-600">Only on your own computer. Delete decrypted files when done.</p>
      </Block>

      <Diagram title="Which recovery do I use?" caption="Pick the smallest one that fits.">
        <Cards
          items={[
            { title: 'A few rows edited badly', detail: 'restore.sh stage, then restore.revert_rows for the listed primary keys. Undo is possible.' },
            { title: 'Rows missing, project works', detail: 'Runbook A: restore.sh plan, then apply. Inserts only missing rows. Never overwrites live rows. Never brings back a row deleted on purpose.' },
            { title: 'Project lost', detail: 'Runbook B: new Supabase project, push migrations, restore.sh apply --exact, deploy functions, set secrets, Vercel variables, CORS.' },
          ]}
        />
      </Diagram>

      <Block title="Runbook A, step by step">
        <ol className={ORDERED}>
          <li>Pick the newest backup from before the damage. Run <code>verify.sh</code>.</li>
          <li>Set the target database login (the owner, not <code>backup_reader</code>) in the <code>PG*</code> variables, and <code>RESTORE_CONFIRM_HOST</code>.</li>
          <li><code>ops/backup/restore.sh plan &lt;backup&gt; &lt;key&gt;</code>. Dry run. Per table: staged, live, deleted since, to insert, rejected.</li>
          <li>Read the rejections. Each has a reason (missing login, conflict, broken rule, missing parent, file already purged).</li>
          <li><code>restore.sh apply &lt;backup&gt; &lt;key&gt;</code>. Type <code>restore</code> to confirm. Options: <code>--exclude schema.table</code>, <code>--skip-rejected</code>.</li>
          <li>It copies every public table to <code>maintenance_backup</code> first, then inserts in one transaction. All or nothing.</li>
          <li>Check the app. Keep the run id it prints.</li>
          <li>To take it back: <code>restore.sh undo &lt;run id&gt;</code>. It refuses if a restored row was edited since; <code>--force</code> overrides.</li>
        </ol>
        <ul className={`${LIST} mt-2`}>
          <li>A second apply of the same backup inserts nothing.</li>
          <li>Triggers are off during a restore. Constraints still apply.</li>
          <li>Deletions are known only from the day the delete-tracking migration ran.</li>
          <li>Run it when nobody is editing. It takes table locks for a few seconds.</li>
        </ul>
      </Block>

      <Block title="Runbook B, step by step">
        <ol className={ORDERED}>
          <li>Create a new Supabase project in the same region. <code>npx supabase link</code> to it.</li>
          <li><code>npx supabase db push --linked</code>. Schema always comes from the repository, never from a backup.</li>
          <li>Point <code>PG*</code> at the new owner login. <code>restore.sh apply &lt;backup&gt; &lt;key&gt; --exact</code>. It also restores logins.</li>
          <li><code>npx supabase functions deploy</code>.</li>
          <li>Set the Supabase secrets again, and the GitHub secrets that name the project. Set a new <code>backup_reader</code> password.</li>
          <li>Vercel: update <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code>, redeploy.</li>
          <li>R2 CORS: add the site address if it changed.</li>
          <li>Sign in, open the Board, open an attachment, run Backup by hand once.</li>
        </ol>
      </Block>

      <Block title="When the page is red">
        <ul className={LIST}>
          <li><strong>Login refused or database unreachable:</strong> <code>BACKUP_PG*</code> secrets, the pooler address, or the <code>backup_reader</code> password changed. Both the database and the GitHub secret must hold the same password.</li>
          <li><strong>Over the size limit:</strong> find out why the data grew before raising the limit in <code>backup.sh</code>.</li>
          <li><strong>Data kept changing:</strong> someone was writing at 03:17 UTC three times. Run again.</li>
          <li><strong>Dump failed or unreadable:</strong> read the Actions log (counts only). Usually <code>pg_dump</code> must be version 17.</li>
          <li><strong>Upload or push failed:</strong> a token expired or was revoked. Renew the secret.</li>
          <li><strong>Media mirror failed:</strong> the dump is safe; some files were not copied. Run again. Check the Drive quota.</li>
          <li><strong>Overdue:</strong> the workflow did not run. Check the Actions tab and that scheduled workflows are enabled.</li>
          <li><strong>Amber:</strong> run Backup with <em>force_weekly</em>.</li>
        </ul>
      </Block>

      <Block title="Keys and secrets">
        <ul className={LIST}>
          <li>Keep the age private key in a password manager and on a disk that is not your computer. Without it no backup can be read.</li>
          <li>New holder: they run <code>age-keygen</code>, send only the <code>age1…</code> line. Add it to <code>recipients.txt</code> in a pull request. Future backups include them.</li>
          <li>Holder leaves: remove the line. Old backups stay readable by that key.</li>
          <li>Three R2 tokens: attachments read and write (Supabase), backups read and write (GitHub and Supabase), attachments read only (GitHub, media mirror).</li>
          <li>Rotate a token: create the new one, set it in GitHub and in <code>npx supabase secrets set</code>, delete the old one.</li>
          <li>Never print secrets in a log. The repository is public and so are its Actions logs.</li>
        </ul>
      </Block>

      <Block title="Limits">
        <ul className={LIST}>
          <li>A restore brings back the state at 03:17 UTC. Later work is lost unless it is still live.</li>
          <li>Attachment files are not in the database backup. A restored row needs its file in R2. The 30-day delete grace and the Drive mirror cover this.</li>
          <li>Full details: <code>BACKUP.md</code>, <code>RUNBOOK_RESTORE.md</code>, <code>KEY_MANAGEMENT.md</code>, <code>R2_SETUP.md</code>.</li>
        </ul>
      </Block>
    </div>
  )
}

/* ---------------------------------------------------------- building blocks */

const LIST = 'list-disc space-y-1 pl-5 text-sm text-slate-700'
const ORDERED = 'list-decimal space-y-1 pl-5 text-sm text-slate-700'

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-1 text-sm font-semibold text-slate-900">{title}</h3>
      {children}
    </section>
  )
}

function Diagram({ title, caption, children }: { title: string; caption: string; children: ReactNode }) {
  return (
    <figure className="rounded border border-slate-200 bg-slate-50 p-3" data-testid="guide-diagram">
      <figcaption className="mb-2">
        <span className="block text-sm font-semibold text-slate-900">{title}</span>
        <span className="block text-xs text-slate-600">{caption}</span>
      </figcaption>
      {children}
    </figure>
  )
}

type Step = { title: string; detail?: string }

const BOX = 'rounded border border-slate-300 bg-white px-3 py-2'

function Box({ step }: { step: Step }) {
  return (
    <div className={BOX}>
      <p className="text-sm font-medium text-slate-900">{step.title}</p>
      {step.detail && <p className="text-xs text-slate-600">{step.detail}</p>}
    </div>
  )
}

const Arrow = () => (
  <li aria-hidden="true" className="text-center text-slate-400 select-none">
    ↓
  </li>
)

// Boxes from top to bottom, joined by arrows. One column, so it reads the same on a phone.
function Flow({ steps }: { steps: readonly Step[] }) {
  return (
    <ol className="space-y-1">
      {steps.flatMap((s, i) => [
        ...(i > 0 ? [<Arrow key={`a${i}`} />] : []),
        <li key={s.title}>
          <Box step={s} />
        </li>,
      ])}
    </ol>
  )
}

// One box that splits into several.
function Fork({ from, branches }: { from: string; branches: readonly Step[] }) {
  return (
    <div className="space-y-1">
      <div className={BOX}>
        <p className="text-sm font-medium text-slate-900">{from}</p>
      </div>
      <p aria-hidden="true" className="text-center text-slate-400 select-none">
        ↓
      </p>
      <ul className="grid gap-2 sm:grid-cols-2">
        {branches.map((b) => (
          <li key={b.title}>
            <Box step={b} />
          </li>
        ))}
      </ul>
    </div>
  )
}

// Side-by-side choices (no order).
function Cards({ items }: { items: readonly Step[] }) {
  return (
    <ul className="grid gap-2 sm:grid-cols-3">
      {items.map((s) => (
        <li key={s.title}>
          <Box step={s} />
        </li>
      ))}
    </ul>
  )
}
