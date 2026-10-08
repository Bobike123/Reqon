# Reqon

Internal web app for the SDU Motorbike Club's MotoStudent entry. It tracks
compliance against the 1,146-clause regulations book, the team's tasks, weekly
meeting decisions, and the bike's measured dimensions.

It is a static single-page app. There is no server of ours: the browser talks
straight to Supabase (Postgres), and **the security lives in the database**, not
in this code.

---

## 1. Prerequisites

| Need | Version | Check with |
|---|---|---|
| Node.js | 22.22.2 or newer (see `.nvmrc`) | `node --version` |
| npm | 10.9.7 or newer (the version bundled with Node 22.22.2) | `npm --version` |
| A Supabase project | free tier is enough | see §6 |
| Docker | any recent version — **only** for the database tests (§2a) | `docker info` |

The Node and npm versions are enforced, not advisory: `.npmrc` sets
`engine-strict=true`, so `npm ci` refuses to install on anything older than
`package.json`'s `engines`.

Running the app itself needs no Docker and no database on your laptop.

---

## 2. Run it locally

```bash
git clone <the club's repository URL>
cd reqon
npm ci                         # clean install, exactly what package-lock.json pins
cp .env.example .env.local     # then edit .env.local — see §3
npm run dev
```

Open the URL it prints (usually <http://localhost:5173>) and sign in with your
club account.

Other commands:

```bash
npm run build         # production build into dist/, then the bundle-size budget check
npm run preview       # serve the built dist/ locally, to check it before deploying
npm test              # run the frontend test suite (Vitest)
npm run test:coverage # the same suite, failing if coverage drops below the floors in vite.config.ts
npm run typecheck     # tsc, no emit
npm run lint          # oxlint, scoped to src/, vite.config.ts and scripts/
npm run check         # typecheck + lint + test, in that order
npm run test:db       # database tests — needs Docker, see §2a
```

### 2a. Verifying a change

Frontend tests alone do not cover the security boundary — that lives in the
database. Before calling a change done, run both halves:

```bash
npm ci
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run test:db
npm ls --depth=0
npm audit
```

`npm run test:db` runs `scripts/verify_db.sh`. It starts a throwaway
`postgres:17` container (same major version as the hosted project), applies
`scripts/local_auth_shim.sql` (stand-ins for Supabase's `auth` schema and
roles), then every migration in order. It then races two real `psql`
processes against `promote_proposal()` and runs every
`supabase/tests/*.sql` file. It exits 0 only if everything passed, and it
removes the container either way. No Supabase account, credentials or
network access to a real project are involved. The first run pulls the
`postgres:17` image.

CI (`.github/workflows/ci.yml`) runs the same two halves as separate jobs,
`frontend` and `database`, so a red job tells you which boundary broke.
`docs/ARCHITECTURE.md` explains what each gate proves.

### 2b. Against a local Supabase stack (development)

Development can run entirely on your machine, against the local Supabase stack
the pinned CLI starts in Docker. Nothing here touches a hosted project.

```bash
npm run local:setup   # start the local stack if needed, apply pending migrations
                      # (forward only, never a reset), then set up the Requirements Book
npm run dev           # when .env.development.local points at http://127.0.0.1:54321,
                      # `predev` first checks the stack is up and migrated and syncs the Book
```

`.env.development.local` (git-ignored) holds the local URL and the local
**anon** key from `npx supabase status`. When the dev server points at a
hosted project instead, `predev` says so and does nothing.

**The Requirements Book is set up automatically** by
`npm run book:sync:local` (`scripts/book/sync-local.mjs`), which `local:setup`
and `predev` run for you:

- The source file is described, with its SHA-256, in `supabase/book/editions.json`
  (MS2627 Rev.01: `static/book/MS2627_MotoStudent.pdf`, 234 pages, printed page =
  PDF page). A different file under that name is refused, never silently used.
- It is uploaded through the local Storage API to the **private** `regulations`
  bucket at `editions/<edition>/<sha256 prefix>.pdf`, read back and compared.
  Then the edition's existing `regulation_documents` row is pointed at it.
- Each clause's printed page (`clauses.source_page`) is derived from the PDF
  text: its reference must open a paragraph whose words match the clause's own
  text. Tables of contents and cross-references are ignored. Two clauses that
  print the same reference are told apart by their content. A page already
  recorded is never overwritten; a disagreement is reported. The derivation
  is written to `supabase/book/ms2627-rev-01.pages.json`, tied to the PDF and
  clause fingerprints.
- It only ever talks to this checkout's own local stack. It reads the service-role
  key from `npx supabase status` into its own process, and never prints or stores it.
- A second run changes nothing. An interrupted run leaves the old source in
  place and can simply be run again. Two runs at once are serialised by an
  advisory lock.

```bash
npm run book:sync:local -- --dry-run    # what would change, writing nothing
npm run book:sync:local -- --rederive   # read the PDF again even if the manifest matches
```

If it reports a **conflict**, it has changed nothing. Conflicts are: another
source is already configured, the configured object is missing or different,
or a recorded page disagrees. Fix the named row in **Settings → Requirements
Book**, or clear it, then run it again. If it says the stack is not running,
run `npm run local:setup`.

`npm run test:e2e` (Playwright) runs against this same local stack and dev
server.

---

## 3. Environment variables

`.env.local` holds two values, both of which are **safe in the browser**:

```
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key-here
```

Get them from the Supabase dashboard: **Project Settings → API**.

- `.env.local` is git-ignored. Never commit it.
- `.env.example` is committed and contains placeholders only. If you add a
  variable, add it there too so the next person knows it exists.
- Anything prefixed `VITE_` is **baked into the JavaScript** at build time.
  Anyone can read it. That is fine for these two, because Row Level Security
  decides what the anon key is allowed to see.

> **Never put the `service_role` key or the database password in `.env.local`,
> in the hosting dashboard, or anywhere else in this repository.** The
> `service_role` key bypasses Row Level Security completely — with it, anyone
> can read and change the entire database from their browser console.

---

## 4. Deploying

The build output is plain static files. Any of the three hosts below works; the
config for all three is already in the repository.

**Settings, whichever host you pick:**

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Output directory | `dist` |
| Environment variables | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` |

**Cloudflare Pages** (recommended — Prompt 0's first choice)
1. Create a Pages project and connect the club's Git repository.
2. Framework preset **Vite**; build command and output directory as above.
3. Add the two environment variables under **Settings → Environment variables**,
   for both Production and Preview.
4. Deploy. `public/_redirects` handles SPA routing automatically.

**Netlify** — `netlify.toml` and `public/_redirects` are already correct. Connect
the repo, add the two variables, deploy.

**Vercel** — `vercel.json` is already correct. Import the repo, add the two
variables, deploy.

### Why the redirects file matters

React Router handles `/register`, `/board` and the rest **in the browser**. The
host only has one real file, `index.html`. Without the SPA fallback rule, opening
`https://<site>/register` directly — a refresh, a bookmark, a link someone pasted
into the group chat — asks the host for a file that does not exist and returns
404. `public/_redirects` (Cloudflare Pages, Netlify) and `vercel.json` (Vercel)
tell the host to serve `index.html` with a **200** so the URL is preserved and
the router renders the right screen.

### Security headers

`public/_headers` (Cloudflare Pages, Netlify) and the `headers` block in
`vercel.json` set `X-Frame-Options: DENY`, `nosniff`, a referrer policy, and
cache rules — hashed assets cached forever, `index.html` never cached, so a
deploy cannot leave someone pointing at chunks that no longer exist.

A Content-Security-Policy is worth adding once the club has picked its Supabase
project, because the policy has to name that exact origin. A starting point is
in the comments at the bottom of `public/_headers`. Test it on every screen
before enabling it — a wrong `connect-src` breaks sign-in and realtime silently.

### To update the deployed site

Push to the main branch. All three hosts rebuild automatically. If you changed
environment variables, you must **redeploy** — they are baked in at build time,
so an existing deployment keeps the old values.

Pushing does **not** deploy database migrations. Those go through the Supabase
CLI, before the matching frontend — see §6a.

---

## 5. Where the credentials live

**Not here.** The repository and this README contain no passwords.

Store these in the club's own **Accounts and Logins** document, which the club
owns — not a student's personal password manager:

- the Supabase account login (email + password, and 2FA recovery codes)
- the Supabase **database password** (shown once, at project creation)
- the Supabase `service_role` key — needed for admin scripts, **never** for this app
- the hosting account login (Cloudflare / Netlify / Vercel)
- the Git hosting account login

The anon key and project URL are not secrets and live in the host's environment
variables.

---

## 6. What Supabase must look like

The database schema is in `supabase/migrations/`. Apply it to a project only
with the Supabase CLI (`supabase db push`, see §6a) — never by pasting files into
the SQL Editor, which leaves the migration history empty.

**Authentication settings:**
1. **Authentication → Providers**: Email on, "Confirm email" **off** (accounts
   are issued by hand, to people the club knows).
2. **Authentication → Sign-ups**: public sign-up **disabled**.
3. Every table has Row Level Security on. Do not turn it off "just to test".

**Migrations, in order:**

| File | What it does |
|---|---|
| `20260101000000_paddock_control_schema.sql` | tables, views, triggers, RLS policies |
| `20260101000001_reference_data.sql` | subteams, the 1,146 clauses, milestones, specs |
| `20260102000000_views_security_invoker.sql` | **security fix** — see §11 |
| `20260103000000_attention_clause_key.sql` | adds `clause_key` to `v_attention` |
| `20260104000000_set_current_season.sql` | atomic season switch |
| `20260105000000_privileged_roles.sql` | privileged roles (`member_roles`) and the policies that use them — see §7 |
| `20260106000000_finance_ledger.sql` | the finance ledger (`finance_entries`): readable by the four roles, writable by the Treasurer — see §7 |
| `20260107000000_developer_full_access.sql` | the Developer role becomes full access, for maintenance — see §7 |
| `20260108000000_proposals_and_meetings.sql` | splits the old "Meetings" screen into task proposals, board tasks and real meetings — see §8 |
| `20260109000000_section_subtasks.sql` | adds `tasks.section_id`, which is what makes a Gantt subtask a real board task instead of a second copy |
| `20260110000000_atomic_proposal_promotion.sql` | `promote_proposal()`: promotion as one race-safe transaction, plus a one-task-per-proposal unique index |
| `20260111000000_atomic_role_plan.sql` | `apply_role_plan()`: a whole role change applies completely or not at all |
| `20260112000000_title_validation.sql` | task and proposal titles must be 1–200 characters (trimmed), enforced in the database |
| `20260113000000_idempotent_realtime_publication.sql` | puts exactly the five live-updating tables in the realtime publication, failing loudly if it cannot |
| `20260114000000_activity_audit_trail.sql` | the `activity` audit trail: written only by database triggers, readable but not writable by members |
| `20260115000000_department_lifecycle.sql` | Departments: `subteams.lead_id` as Head, the 10-active cap (trigger, race-tested), reconciliation preflight/apply — see §7a |
| `20260116000000_task_lifecycle_and_authorization.sql` | task states/priority rework, `can_edit_task`/`guard_task_edit`, department-scoped Head task authority — see §7b |
| `20260117000000_traceability_and_proposal_commands.sql` | `task_requirements`/`proposal_requirements`, `submit_proposal`/`review_proposal`/`promote_proposal` rewritten around Head authority — see §7b |
| `20260118000000_phase4_authorization_hardening.sql` | an independent security review's fixes: permissive-policy ORs, stale grants, old function overloads |
| `20260119000000_attention_urgent_reason.sql` | the Now/Priorities attention query learns the `urgent` priority |
| `20260120000000_requirements_book.sql` | `regulation_documents` (Book edition/page metadata), a private storage bucket for the PDF |
| `20260121000000_gantt_link_audit.sql` | Gantt link/unlink of **existing** tasks only, milestone/section audit events |
| `20260122000000_spec_targets_and_measurements.sql` | `specs` targets (regulatory + internal), `spec_measurements` append-only history, `spec_verdicts` view — see §7c |
| `20260123000000_automation_audit_realtime_export.sql` | the no-argument `archive_stale_done_tasks()` scheduler target, full task/proposal audit coverage, checked `season_id` on the requirement junctions, `milestones`/`proposal_requirements` added to realtime — see §7d |

Each migration from `20260110` on carries an **implementation note** at the
top: purpose, existing-data compatibility, locking, authorization, rollback
and deploy order. Read it before applying. `20260110` and `20260111` must be
applied **before** deploying a frontend that calls their functions, and every
migration from `20260115` on must deploy together with the matching client
build. The table stops at `20260123`; `supabase/migrations/` is the complete
list (59 files, through `20260130000000`, on 2026-10-02 — all of them are
applied to the hosted project, see §6a).

Run them in exactly this order. `20260105` rewrites the season switch from
`20260104`, so running `04` again afterwards would break it. `20260105` also
converts any existing board members into roles by job title ("President" →
President, "Vice…" → Vice President, "Treasurer" → Treasurer, anything else →
Vice President, so nobody loses access they had) and prints one line per person.

Sanity check afterwards:

```sql
select count(*) from clauses;                          -- 1146
select count(*) from clauses where is_team_duty;       -- 491
select * from v_subteam_progress order by duties desc; -- DOCS 129, ADMIN 82, ...
```

### 6a. Production migrations — the only supported workflow

The Supabase CLI decides what is "pending" from one table,
`supabase_migrations.schema_migrations`, by **version number**. It never looks
at the schema. So every production migration goes through the CLI, from this
repository:

```bash
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase migration list --linked      # every old version must show in BOTH columns
npx supabase db push --linked --dry-run   # must list only the new file(s)
npx supabase db push --linked
```

Never apply a migration to production any other way: not the SQL Editor, not
`psql`, not an agent's MCP `apply_migration` tool. The SQL Editor records no
history row. `apply_migration` records a platform timestamp instead of the
repository version. Either way the next `db push` thinks the file is still
pending. This is how the hosted project came to have 22 history rows for 59
applied files.

> **Warning — never run `supabase db push` against production while
> `supabase migration list` shows a version in only one column.** Run
> `db push --dry-run` first; if it proposes any file that is already applied,
> or fails with "Remote migration versions not found in local migrations
> directory", stop and repair the history first. Never use `--include-all`.
> When the CLI suggests `supabase db pull`, ignore that here: `db pull` writes
> a new migration from the live schema instead of fixing the bookkeeping. A
> replay is not harmless: `20260101000001_reference_data.sql` upserts
> milestones, and later files re-create older function bodies.

**History repair of the hosted project — EXECUTED 2026-10-02** (CLI 2.117.0, by the project owner's login). Result: `migration list` 59 matched, none local- or remote-only; `db push --dry-run` "Remote database is up to date."; schema and all 28 data fingerprints identical before and after; the 22 removed rows were first dumped to the git-ignored `supabase/.backups/`. What was found and why: On 2026-10-02
the hosted history had 22 rows, all keyed by platform timestamps
(`20260924124502` … `20261001100523`). None of them is a repository version,
and none of the 59 repository versions was recorded. The hosted schema was then
proved equal to a fresh build of all 59 files, `20260130000000_role_hierarchy`
included. The comparison covered 16 catalog classes: functions (bodies,
`SECURITY DEFINER`, `search_path`), `EXECUTE` rights, columns, constraints,
indexes, triggers, policies, views, enums, grants, RLS flags, the realtime
publication, comments, and the `maintenance` functions. The only extra object
was the Supabase platform function `rls_auto_enable()`. Of the 22 rows, 21 carry
statement text md5-identical to their repository file. The
`department_lifecycle` row differs from `20260115000000` only in comments.
Nothing is missing from production, so the repair is bookkeeping only. It
rewrites no schema and no data, and re-runs no SQL.

Run it as the project owner, after `login` and `link` above:

```bash
# 0. read-only BEFORE snapshot: every 'schema' row ok; keep the 'data' rows
#    (supabase/maintenance/2026-10-02_verify_migration_history.sql, SQL Editor)
npx supabase migration list --linked   # expect 59 local-only, 22 remote-only
# 1. forget the 22 platform-timestamp rows (each one is a repository file, see above)
npx supabase migration repair --linked --status reverted \
  20260924124502 20260929090632 20260929091048 20260929091309 20260929091406 20260929091509 20260929095225 \
  20260930230849 20260930230918 20260930230944 20260930231006 20260930231007 20260930231142 20261001100141 \
  20261001100158 20261001100232 20261001100256 20261001100331 20261001100408 20261001100439 20261001100504 \
  20261001100523
# 2. record the 59 repository versions that are proven applied — an explicit list,
#    never `$(ls supabase/migrations)`: a file added later must NOT be marked applied
npx supabase migration repair --linked --status applied \
  20260101000000 20260101000001 20260102000000 20260103000000 20260104000000 20260105000000 20260106000000 \
  20260107000000 20260108000000 20260109000000 20260110000000 20260111000000 20260112000000 20260113000000 \
  20260114000000 20260115000000 20260116000000 20260117000000 20260118000000 20260119000000 20260120000000 \
  20260121000000 20260122000000 20260123000000 20260124000000 20260125000000 20260125000100 20260125000200 \
  20260125000300 20260125000400 20260125000500 20260125000600 20260126000000 20260126000100 20260126000200 \
  20260126000300 20260126000400 20260126000500 20260126000600 20260126000700 20260127000000 20260127000100 \
  20260127000200 20260127000300 20260128000000 20260128000100 20260128000200 20260128000300 20260128000400 \
  20260128000500 20260129000000 20260129000100 20260129000200 20260129000300 20260129000400 20260129000500 \
  20260129000600 20260129000700 20260130000000
# 3. verify
npx supabase migration list --linked          # 59 rows, both columns filled
npx supabase db push --linked --dry-run       # "Remote database is up to date."
# 4. re-run the verify SQL: 'schema' all ok, 'history' ok, 'data' identical to step 0
```

`bash scripts/backend-completion/rehearse-history-repair.sh` runs exactly these
commands against a disposable copy, with the same 22 rows, and shows
"Remote database is up to date." with an unchanged catalog. If any new
migration was applied to production before the repair, stop: the expected hashes
in the verify file no longer apply, and that file's version must be checked
before it is added to step 2. Keep these commands as the record of what was run; do
not run them again.

---

## 7. Adding someone to the club

**In the app: Settings → Roster → Add someone to the roster.** Enter their full
name, the email they will sign in with, a first password (at least 8
characters) and a job title, then press **Add to roster**. That creates their
login and their roster row in one step. Give them the password privately; they
change it in **Settings → Your account**.

Only an active **President, Vice President or Developer** can do this
(`can_add_members()`, migration `20260131000000_member_onboarding.sql`). A new
person never gets a privileged role here — hand one out afterwards with
**Change roles**.

How it stays safe: creating a login needs the `service_role` key, which must
never reach a browser (§3). So the browser calls the **`create-member` Edge
Function** (`supabase/functions/create-member/`), the only place that key is
used, and sends nothing but the signed-in person's own session. The function
asks the database *as that person* whether they may add members, creates the
login, and then inserts the roster row *as that person*, so Row Level Security
(`admin_roster_insert`) decides again. If the roster step fails, the login is
deleted, so no half-made account is left behind.

**Deploying the function (once, and after every change to it):**

```bash
npx supabase functions deploy create-member --project-ref zsmldveykmtmxuqqmddo
```

Supabase injects `SUPABASE_URL`, `SUPABASE_ANON_KEY` and
`SUPABASE_SERVICE_ROLE_KEY` into the function itself; nothing is added to
`.env.local` or Netlify/Vercel. Locally: `npx supabase functions serve create-member`.

The `members` row is what actually grants access. A person with a login but no
`members` row sees "Your account is not on the club roster" and no data — the
database returns nothing to them. The `members` table *is* the allowlist.

**A login that already exists** (made in **Supabase dashboard → Authentication →
Users → Add user**) is linked instead: open **Their login already exists? Link it
by UUID** under the same form, paste the user's UUID, name and job title, and
press **Link to roster**.

**Or do it in one query.** `supabase/scripts/new_member.sql` creates the login
and the roster row in a single transaction: paste it into the **SQL Editor**,
change the five values under `EDIT ME`, Run. It refuses an address that already
has a login, can grant privileged roles at the same time, and finishes by
printing the three newest people with what they may sign in with. This changes
nothing about the app: the SQL Editor runs *inside* the database, so no key is
ever shipped to a browser.

### Roles

Four privileged roles, stored one row per role in the `member_roles` table — a
person can hold several (treasurer *and* developer, say). The job title on the
roster ("Chassis lead") is only a label and grants nothing.

| | Read everything, incl. money | Roster, departments, rulebook, milestones, seasons | Change money | Give / take away roles |
|---|---|---|---|---|
| **President** | yes | yes | no | yes |
| **Vice President** | yes | yes | no | no |
| **Treasurer** | yes | no | yes | no |
| **Developer** | yes | **yes** | **yes** | **yes** |
| Everyone else on the roster | everything except money | no | no | no |

**Developer is full access**, on purpose: whoever maintains the app has to be
able to repair the club's data and undo a bad change without waiting for an
officer. It can do everything the President, Vice President and Treasurer can —
including giving itself any role — so give it only to the person doing that work,
and take it back when they are done (`20260107000000_developer_full_access.sql`).

Everyone on the roster keeps the day-to-day work: the register, tasks, meetings,
proposals, the spec sheet and handover notes.

### 7a. Departments and Heads — a second, separate kind of authority

A **Department** is a division of work (a row of `subteams` — the table
keeps its old name, but every screen and message says "Department"). Its
**Head** (`subteams.lead_id`) is a plain member the President/Vice
President/Developer appoints, with no privileged role required or implied.

This matters because Head authority is **scoped to that one department**,
and it is checked from the resource, not from a role:

- a Head may edit any task, and review/promote any proposal, **in their own
  department only**; a Head who also owns a task in another department may
  edit it as its owner, which is a different rule;
- a member may head several departments at once, or none;
- **holding President or Vice President grants no task-edit or
  proposal-promotion power by itself** — those two roles configure
  *departments* (create, rename, appoint Head, archive/restore, up to 10
  active at once), never a department's day-to-day work. A President who is
  not also a Head cannot approve a proposal.

Everything above is `can_manage_departments()` for configuration versus
`can_edit_task`/`can_review_proposal` for a specific task or proposal
(`20260115000000_department_lifecycle.sql`,
`20260116000000_task_lifecycle_and_authorization.sql`); see
`docs/redesign/adr/0003-permission-model.md` for the full reasoning.
`supabase/tests/department_lifecycle_test.sql` and
`task_authorization_test.sql` check both halves.

These rules are enforced by Postgres Row Level Security, not by the app. The app
hides controls you cannot use; a request made any other way — the browser
console, `curl`, a modified copy of the app — is refused by the database just
the same.

**The first president** has to be set in the Supabase **SQL Editor**, because
only a president can assign roles:

```sql
insert into member_roles (member_id, role)
select id, 'president' from members where full_name = 'Their Full Name';
```

The same insert grants any other role — the values are `president`,
`vicepresident`, `treasurer` and `developer`:

```sql
insert into member_roles (member_id, role)
select id, 'developer' from members where full_name = 'Their Full Name'
on conflict do nothing;
```

**Migrations never hand out roles.** `20260107` only changes what a Developer
may do; nobody becomes one until someone runs an insert like the one above, or
a President uses **Change roles**.

After that, the President assigns everything else in **Settings → Roster → Change
roles** (the button only the President and a Developer see). Vice President changes
save straight away; anything touching President, Treasurer or Developer shows what
it will mean and asks for confirmation first. Making someone Treasurer offers to take the
role from the current Treasurer (the new one is added before the old one is
removed), and giving President to someone else offers to hand over — again adding
the new President before removing yours. The club always keeps at least one
President: the dialog says so before you try, and the database refuses it anyway.

**Checking the rules.** Paste `supabase/tests/roles_rls_test.sql` into the SQL
Editor and run it. It acts as each role in turn, tries about 80 allowed and
forbidden actions, and always ends with an error that starts
`ROLE CHECKS PASSED` or `ROLE CHECKS FAILED` — raising that error is what rolls
every test row back. Run it after any change to a policy.
`supabase/tests/finance_rls_test.sql` does the same for the finance ledger
(28 checks), and `supabase/tests/proposals_meetings_rls_test.sql` for proposals,
board tasks and meetings (42 checks).

### 7b. Proposals, board tasks and meetings

Three separate things:

| | Member | The proposal's own department Head | Any other Head | President / VP (alone) | Developer |
|---|---:|---:|---:|---:|---:|
| Suggest a task proposal, for any active department | yes | yes | yes | yes | yes |
| Review / park / reject / reopen that proposal | no | yes | **no** | **no** | yes |
| Promote it to a board task | no | yes | **no** | **no** | yes |
| Move a task, set its owner, in that department | owner only | yes | **no** | **no** | yes |
| Archive / restore a task, in that department | **no** | yes | **no** | **no** | yes |
| Create, rename, archive a department; appoint its Head | no | no | no | yes | yes |
| Read meetings | yes | yes | yes | yes | yes |
| Call a meeting, write its agenda and minutes | no | — | — | yes | yes |
| Delete a meeting / edit the agenda template | no | — | — | President only | yes |

The key point this table makes on purpose: **holding President or Vice
President, by itself, grants no task or proposal power** — see §7a. Those two
roles configure departments; a department's day-to-day work is its Head's.

**Proposals** (`/proposals`) are suggested work. Any active member suggests
one, into exactly one active department — the database pins `raised_by` to
the caller, so nobody suggests in someone else's name, and requires a title,
deadline, milestone and at least one requirement link
(`submit_proposal`). Only that department's Head, or a Developer, may
review, park, reject, reopen or promote it (`review_proposal`,
`can_review_proposal`) — never the author of their own suggestion, and never
a Head of a *different* department. "My proposals" means proposals **you
suggested** (`raised_by`), not proposals you might end up owning. Stages
read Suggested → Under review → Decided (Approved/Rejected), with Parked as
a side exit; an old proposal missing required data is marked
`legacy_incomplete` and stays readable but cannot be promoted until a
Head/Developer repairs it.

**Promotion** (`promote_proposal(proposal_id, season_id)`) takes **no**
owner/due-date/state arguments — it copies the proposal's own department,
deadline, priority, milestone and requirement links onto the new task in one
transaction, and archives the proposal (`archive_reason = 'promoted'`). A
retry, sequential or two genuinely concurrent Heads both clicking Approve,
returns the same task the second time (`created: false`) — nothing is
duplicated. The task keeps `source_proposal`, so the Board can always answer
"where did this come from?".

**Nothing is deleted.** A finished or rejected task/proposal is *archived*,
never removed — the Archive screen (`/archive`) lists it, still readable,
still linked to its provenance, and a Head/Developer can restore it. A
finished (Done) task also archives itself automatically 24 hours after
completion, through a server-side scheduler — see §7d. There is no delete
control anywhere in this workflow; the "delete" behaviour described in older
docs no longer exists.

**Meetings** (`/meetings`) are unaffected by the redesign above: a required
date, optional start/end times, a place, an agenda and minutes. A new
meeting starts from the club's agenda template (`meeting_template`, one row).
Editing *that* template is President or Developer only; writing any single
meeting's agenda and minutes is ordinary administrator work, a Vice
President included. Deleting a meeting is the one thing a Vice President
still may not do.

### The Gantt

**Gantt** (`/gantt`) puts the season on one timeline: each submission as a bar
across the months, with today marked, a legend for every shape, and a
department lens that filters the tasks shown while keeping the whole
milestone → section structure visible. Open a submission for its sections
and its unsectioned work, and a section for its tasks.

The third level is the point. A subtask is **not** a new kind of row — it is
an ordinary board task with `milestone_key` and, optionally, `section_id`
pointing at a `milestone_sections` row, so status, owner and due date exist
once and the Board and the Gantt read the same task. Move a card on the
Board and the Gantt moves with it.

**The Gantt cannot create tasks — that would be a second way for a task to
come into existence, and there is only one: promotion (§7b).** The link
control adopts an *existing* Board task this viewer may edit (owner, that
department's Head, or a Developer); linking a task that already belongs to
another submission asks for confirmation first, since both its milestone and
section change together. Unlink detaches a task from its section (or from
its submission entirely, refused for a promoted task, which must always
keep a milestone) without deleting it or its history. Every link, unlink and
milestone/section change is audited (`milestone_changed`, `section_linked`,
`section_unlinked`, `section_changed`).

Percentages roll up from linked tasks under the one progress rule shared
everywhere (§4 of `docs/ARCHITECTURE.md`): distinct tasks, cancelled
excluded, archived Done still counted — and fall back to the drafted ticks
on Milestones where a section has no linked tasks yet. A section or
submission with no dated tasks borrows its submission's published window
rather than inventing dates, and a milestone with no published window still
reads TBC.

### 7c. Specifications and measurements

**Spec sheet** (`/specs`) is the measured engineering side of compliance —
mass, dimensions, anything with a number or a yes/no, checked against a
regulatory limit *and*, separately, the project's own internal target.

Two different rights, easy to conflate:

- **Recording a measurement** is any active member's right (Review, then
  Save measurement — nothing is written while typing or on blur).
- **Editing the rule itself** — the regulatory limit, the acceptable
  threshold, the project's goal/ideal, plausibility bounds — is President,
  Vice President or Developer only. A department Head has **no** special
  authority here just from heading a department; measuring and rule-editing
  are unrelated to department structure.

History is append-only: a wrong value is never edited or deleted, only
corrected (a new observation, the old one kept with the reason) or
withdrawn. Pass/fail (and the amber/green "meets project goal" status) is
never typed by a person or computed in the browser — it comes from the
`spec_verdicts` view, computed in SQL from the rule's own comparator and
target, so it can never go stale relative to a limit someone just changed.

### 7d. Automatic archival, audit history and realtime

A **Done** task that nobody reopens archives itself 24 hours after
completion — no one has to remember to tidy the Board. This runs as a
server-side scheduler, **never** a browser timer (an idle tab cannot be
trusted to run anything, and a client-supplied clock would let someone
archive work early by lying about the time).

Two deployment paths exist; pick the one your Supabase project supports:

1. **`pg_cron` (preferred).** Enable it in the Supabase dashboard
   (**Database → Extensions → pg_cron**), then run
   `supabase/scheduler/install_archive_job.sql` in the SQL Editor. It
   installs one job, named `paddock-control-archive-stale-done`, running
   every 5 minutes; running the file again updates the same job instead of
   creating a second one. It refuses to install if the archive function is
   ever exposed to `anon`/`authenticated` — that would mean anyone could
   trigger it directly, which the migration deliberately prevents.
   `supabase/scheduler/uninstall_archive_job.sql` removes the schedule
   without touching the function itself.
2. **Trusted-server fallback**, if `pg_cron` is not available. Run
   `npm run archive:sweep` (`scripts/run-archive-sweep.mjs`) every 5 minutes
   from a server you control, with `ARCHIVE_SCHEDULER_SUPABASE_URL` and
   `ARCHIVE_SCHEDULER_SERVICE_ROLE_KEY` (the `service_role` key — this
   script must run **only** on a server you trust, never in the browser)
   set in that server's own environment, never in `.env.local` or a hosting
   dashboard's client-side variables.

Neither path is active until you set it up — a fresh Supabase project
archives nothing automatically until you run one of the two above.

**Everything that changes gets a readable history.** Task and proposal
edits, department Head changes, milestone date changes and spec
measurements all write to the `activity` table through database triggers —
no member, and as of `20260123`, no API role at all, can write to it
directly, so it cannot be faked or tampered with from the outside. It shows
up as history on the Archive screen and on individual tasks/proposals; it is
never keystroke-level and never contains a password, phone number or
private roster note.

**Realtime.** Ten tables stay live across every open browser without a
reload: tasks, proposals, clause status, both requirement-link junctions,
milestones, milestone sections, specs, spec measurements and the department
list. `docs/ARCHITECTURE.md` §9 has the exact table.

### Finances

**Finances** in the menu is the season's income and expenses, in euros (MotoStudent's
economical plan is in euros too). The President and Vice President see
it read-only; the Treasurer and the Developer get **Add entry**, **Edit** and **Delete**;
ordinary members have no menu item, and typing the address just explains who can
see it. Amounts are stored as whole cents. Who recorded an entry is stamped by the
database, not sent by the browser.

Any future finance table must copy the same four policies from
`20260106000000_finance_ledger.sql` (`can_view_finances()` to read,
`can_manage_finances()` to write) — never the `member_read` / `member_write`
policies the other tables use, or every member would see and edit the money.

### Changing your own password

**Settings → Your account → Change your password.** Everyone can do this for
themselves: enter the current password, then the new one twice. The current
password is checked by signing in with it first, and every other device is
signed out once the change succeeds. A forgotten password is reset by whoever
manages the Supabase dashboard (Authentication → Users).

### Retiring someone

**Settings → Roster →** set their status to **Alumni**. Do not try to delete
them — the database has no delete policy for `members` at all, deliberately.
Old tasks and rules keep showing who owned them, forever.

---

## 8. Starting a new season

This is the feature that makes the app survive a graduating year.

1. **Settings → Seasons → Start a new season.** Give it a label (`2028/29`). It
   is created **not current** — nothing moves yet.
2. When you are ready, press **Make current** next to it.

What happens:

- the new season starts **completely empty** — no clause statuses, no tasks, no
  proposals carried over;
- the **rulebook is untouched** — all 1,146 clauses are still there, because they
  are reference data, not team data;
- last year's work **stays readable**: switch back and it is all still there.

The switch runs inside a single database transaction (`set_current_season()`), so
the club can never end up with two current seasons — or none. Only the
President, Vice President or a Developer can switch.

Every season-scoped screen shows a loading, error or "no current season"
state instead of empty lists while the season is not resolved — a failed
season lookup never looks like an empty season. Details: `docs/ARCHITECTURE.md` §2.

---

## 9. Importing a new regulations edition

When MotoStudent publishes a new edition, the clause data is regenerated
**outside this repository** by the parser, then imported.

1. Run the parser against the new PDF (it lives in the club's `site/build/`
   tooling, not in this repo):

   ```bash
   python parse_regs.py    <the new regulations PDF>
   python build_catalog.py
   ```

   That produces a new `seed_clauses.csv`.

2. **Add** the new edition; never replace the current one.
   - Register the edition first: a `regulation_documents` row whose `regs_ref`
     is the new edition's reference (Settings → Requirements Book does this for
     the current season; the clause rows below point at it).
   - Load the new clauses as NEW rows, each carrying that `regs_ref` and its own
     `clause_key`s (a forward migration, or **Table Editor → clauses → Insert →
     Import data from CSV**). Subteams must exist first — clauses reference them.
   - **Never truncate or bulk-replace `clauses`.** `clause_status`,
     `task_requirements` and `proposal_requirements` all point at `clause_key`;
     a replacement erases or orphans the team's work (the database now refuses
     to delete a clause that has status or links). An edition's pages are stored
     with the edition (`clauses.regs_ref`, `clauses.source_page`) and cannot be
     re-pointed at another one.
   - `source_page` is the PRINTED page number, and stays empty until it is read
     from the real book — never estimated. Locally, `npm run book:sync:local`
     derives it from the PDF text once the new edition is described in
     `supabase/book/editions.json` (its file, SHA-256, page count and running
     footer). Clauses it cannot match stay empty and are listed for review.

3. Create the new season (§8) and set the new milestone dates and points in
   **Settings → Milestone dates and points**. A milestone with no date is
   legitimate and shows as **TBC** — do not invent one.

The current edition's generated files are in `../handoff/`: `seed_clauses.csv`
(1,146 rows) and `seed_reference.json` (subteams, milestones, spec sheet).

> The parser is the only part of this system that needs code changes when the
> rules change. The app itself does not.

---

## 10. Database types

`src/lib/database.types.ts` is **generated**, never hand-edited. It is what makes
the compiler catch a renamed column instead of shipping it broken.

Regenerate it whenever the schema changes:

```bash
SUPABASE_PROJECT_ID=<your-project-ref> npm run types:gen
```

That runs `scripts/gen-types.mjs`, which calls the `supabase` CLI (a pinned
`devDependency` — no global install needed). It stages the output in a temp
file next to the target, checks the output is non-empty and contains
`export type Database`, and only then renames it over
`src/lib/database.types.ts`, an atomic replace on the same filesystem. A
failed, empty or malformed generation exits non-zero and leaves the existing
file byte-for-byte untouched. It needs a Supabase login with access to that
project (`npx supabase login`).

Then run `npm run build` — any code that used a column you removed will fail to
compile, which is the point.

**While the redesign is uncommitted and unapplied to the hosted project**
(`docs/redesign/STATUS.md`), generate types from the **local** schema
instead — `npm run types:gen:local` (`scripts/gen-types-local.sh`), which
spins up a disposable local Postgres, applies every migration, generates
types against it, and tears the container down. Never point `types:gen` at
production while local migrations haven't been deployed there yet; the two
would silently disagree.

---

## 11. Things a maintainer must not break

These were expensive to get right. Please read before changing them.

- **Row Level Security is the security.** A client-side `if (canAdminister)` is a
  suggestion — anyone can edit JavaScript in their browser. Every real rule is a
  database policy. Never disable RLS to make something work.
- **Views need `security_invoker = on`.** A Postgres view runs as its *owner*
  unless told otherwise, which silently bypasses RLS on the tables underneath. We
  hit this for real: signed-out visitors could read the team's data through
  `v_current_season`. Migration `20260102000000` fixes it. If you add a view, set
  the option — and note that `CREATE OR REPLACE VIEW` **resets** it.
- **Never ship the `service_role` key to the browser.**
- **Permissions live in `member_roles`, never on `members`.** Everyone may edit
  their own `members` row, so a permission stored there can be self-granted —
  that is exactly how the old `is_board` flag could be abused, which migration
  `20260105000000` removed. Only the President or a Developer may write `member_roles` (`can_manage_roles()`).
- **One place decides what the UI shows.** Components ask `usePermissions()`
  (`src/auth/permissions.ts`), which mirrors the SQL functions `is_admin()`,
  `can_manage_roles()`, `can_view_finances()` and `can_manage_finances()`.
  Change the SQL first, then the mirror, then rerun the role test (§7).
- **`clauses` is the rulebook, not a worksheet.** Team progress goes in
  `clause_status`. Never edit `clauses` to record what the team did.
- **Show `printed_ref`, join on `clause_key`.** The book prints two different
  clauses as `E.5.4.5`, and two more as `F.5.2.3`. That is an error in the
  Organization's PDF, not in our import. `clause_key` disambiguates them
  (`F.5.2.3` and `F.5.2.3#2`). Do not "fix" the duplicates.
- **Pass/fail is never stored.** The spec sheet reads `verdict` from the
  `spec_verdicts` view, which derives it in SQL from the rule's own comparator
  and target. Recomputing it in React would go stale the moment a limit changes.
- **A measurement is history, never an overwrite.** Save one with
  `record_spec_measurement` (the Save measurement button); it appends an
  observation, refreshes `specs.measured` and writes the audit event in one
  transaction. Never write `specs.measured` (or its actor/time) directly: the
  database refuses it for every signed-in role. Fix a wrong value with
  `correct_spec_measurement` or `invalidate_spec_measurement`; the old
  observation stays, with the reason. Editing limits and targets is a separate
  right (President, Vice President, Developer), not part of measuring.
- **Department Head authority is scoped to one department and is resource-aware,
  not a role.** It comes from `subteams.lead_id`, checked together with the
  task/proposal in question (`can_edit_task`, `can_review_proposal`).
  President/Vice President configure departments; they get **no** task-edit
  or proposal-promotion power from that role alone (ADR-0003). Never fold
  Head authority into `is_admin()` or any other blanket flag.
- **A task is created only by `promote_proposal()`.** There is no direct
  insert path anywhere, including the Gantt. A second path would need its
  own unique-per-proposal guard and audit event, and would break "where did
  this task come from" for every task created through it.
- **`task_requirements`/`proposal_requirements` derive their own `season_id`
  from a trigger — never accept one from the client.** It exists purely so
  Realtime can filter DELETE events on these junctions server-side, without
  a parent-row lookup that a deleted parent has already made impossible.
- **Never expose a timestamp-accepting archive function to any API role.**
  `archive_stale_done_tasks()` (the one `pg_cron`/the fallback script call)
  takes no arguments and reads the server clock; the deterministic seam,
  `archive_stale_done_tasks_at(timestamptz)`, is for database tests only and
  is revoked from `anon`, `authenticated` and `service_role`. Reintroducing
  a client-reachable clock argument lets someone archive work early by lying
  about the time.
- **Don't store derived values.** No cached `resolved_count` column. Progress and
  the attention list are views.
- **Read more than 1,000 rows by paging.** Supabase silently truncates a response
  at `max_rows` with no error. There are 1,146 clauses — a plain `.select()`
  loses 146 of them. See `fetchAllRows` in `src/data/errors.ts`.
- **Don't delete people.** Retire them (§7).
- **Don't invent regulation content.** If a date or a limit is not in the seed
  data, render "TBC" and say where it would come from.
- **Keep the dependency list small.** No component library, no state manager
  beyond TanStack Query, no drag-and-drop framework. The most common reason an
  inherited app will not build is a major-version churn in a UI library.

---

## 12. First-time repository setup

If you are looking at this as a plain folder rather than a Git checkout, it has
not been put under version control yet. Do that before anything else — the
deployment hosts in §4 all deploy from a Git repository:

```bash
git init
git add .
git commit -m "Reqon"
git remote add origin <the club's repository URL>
git push -u origin main
```

`.gitignore` already excludes `node_modules`, `dist`, `coverage` and
`.env.local`. Check `git status` before your first commit and confirm
`.env.local` is **not** listed.

---

## 13. How the code is laid out

```
src/
  auth/        sign-in (Login), the roster gate (RequireAuth), auth state, usePermissions,
               TaskActor-based resource checks (canEditTask, canReviewProposal, …)
  season/      current-season state (SeasonProvider) and the route gate (SeasonGate)
  data/        one hook module per entity; season scoping in seasonQuery.ts, keys in queryKeys.ts
  core/        application error contract (DataError, isPermissionError)
  departments/ tasks/ proposals/ specs/ book/ activity/ milestones/ clauses/ metrics/
               small domain modules: each owns its own types.ts (generated row aliases) and
               any pure presentation/validation logic (progress.ts, priority.ts, lifecycle.ts,
               scope.ts, presentation.ts, …) — never a data/ import or a use*() hook (ADR-0011)
  roles/       role dialog, role-plan logic, and the member_roles hooks
  pages/       one file per screen; bigger screens split into a folder (settings/, gantt/,
               specSheet/, archive/, …)
  proposals/ meetings/ finance/ account/ tutorial/
               feature components shared between screens (proposals/ and tutorial/ also hold
               the domain module above — components and pure logic side by side by design)
  ui/          app header, error boundary, dialog, shared loading/error/empty states
  lib/         the single Supabase client + generated types
docs/          ARCHITECTURE.md (layers, departments, tasks/proposals, specs, Book, scheduler,
               realtime, audit, export, CI); redesign/ (phase-by-phase design record, ADRs)
               now-metrics.sql — the SQL behind every number on the Now screen
supabase/      migrations/ and tests/ (the SQL authorization and integrity tests);
               scheduler/ (pg_cron install/uninstall, deployment-time, not migrations);
               reconciliation/ (the department-manifest test fixture)
scripts/       verify_db.sh (database tests), gen-types.mjs / gen-types-local.sh,
               check-bundle-budget.mjs, check-boundaries.mjs (the lint-time boundary check),
               run-archive-sweep.mjs (the trusted-server scheduler fallback)
```

Two rules that keep it navigable: **one Supabase client** (`src/lib/supabase.ts`
— never call `createClient` anywhere else), and **`season_id` only appears inside
`src/data/` and `src/season/`** — screens never handle it. The full layer map
and dependency diagram are in `docs/ARCHITECTURE.md`.
