# Paddock Control

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
| Node.js | 22 or newer | `node --version` |
| npm | comes with Node | `npm --version` |
| A Supabase project | free tier is enough | see §6 |

Nothing else. No Docker, no database on your laptop.

---

## 2. Run it locally

```bash
git clone <the club's repository URL>
cd paddock-control
npm install
cp .env.example .env.local     # then edit .env.local — see §3
npm run dev
```

Open the URL it prints (usually <http://localhost:5173>) and sign in with your
club account.

Other commands:

```bash
npm run build     # production build into dist/
npm run preview   # serve the built dist/ locally, to check it before deploying
npm test          # run the test suite
npm run lint      # oxlint
```

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

The database schema is in `supabase/migrations/`. Run the migrations in order
against a new project (SQL Editor → paste → Run), then load the reference data.

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
| `20260106000000_finance_ledger.sql` | the finance ledger (`finance_entries`): readable by the four roles, writable by the Treasurer only — see §7 |

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

---

## 7. Adding someone to the club

**Two steps, and the first one cannot happen inside the app.** Creating a login
requires the `service_role` key, which must never reach a browser (§3).

1. **Supabase dashboard → Authentication → Users → Add user.** Give them an
   email and a password, and tick "Auto Confirm User".
2. Copy that user's **UUID** from the user list.
3. In Paddock Control: **Settings → Roster → Add someone to the roster.** Paste
   the UUID, enter their name and role, press **Link to roster**.

Step 3 is what actually grants access. A person with a login but no `members`
row sees "Your account is not on the club roster" and no data — the database
returns nothing to them. The `members` table *is* the allowlist.

Only the President or Vice President can do step 3. Linking someone gives them
no privileged role.

### Roles

Four privileged roles, stored one row per role in the `member_roles` table — a
person can hold several (treasurer *and* developer, say). The job title on the
roster ("Chassis lead") is only a label and grants nothing.

| | Read everything, incl. money | Roster, subsystems, rulebook, milestones, seasons | Change money | Give / take away roles |
|---|---|---|---|---|
| **President** | yes | yes | no | **yes — the only one** |
| **Vice President** | yes | yes | no | no |
| **Treasurer** | yes | no | **yes — the only one** | no |
| **Developer** | yes | no | no | no |
| Everyone else on the roster | everything except money | no | no | no |

Everyone on the roster keeps the day-to-day work: the register, tasks, meetings,
topics, the spec sheet and handover notes.

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

After that, the President assigns everything else in **Settings → Roster → Change
roles** (the button only the President sees). Developer and Vice President changes
save straight away; anything touching President or Treasurer shows what it will
mean and asks for confirmation first. Making someone Treasurer offers to take the
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
(28 checks).

### Finances

**Finances** in the menu is the season's income and expenses, in euros (MotoStudent's
economical plan is in euros too). The President, Vice President and Developer see
it read-only; only the Treasurer gets **Add entry**, **Edit** and **Delete**;
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
  topics carried over;
- the **rulebook is untouched** — all 1,146 clauses are still there, because they
  are reference data, not team data;
- last year's work **stays readable**: switch back and it is all still there.

The switch runs inside a single database transaction (`set_current_season()`), so
the club can never end up with two current seasons — or none. Only the
President or Vice President can switch.

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

2. Regenerate the reference-data migration and apply it, or import the CSV
   directly: **Table Editor → clauses → Insert → Import data from CSV**.
   Subteams must exist first — clauses reference them.

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

(That runs `supabase gen types typescript --project-id ... > src/lib/database.types.ts`.)

Then run `npm run build` — any code that used a column you removed will fail to
compile, which is the point.

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
  `20260105000000` removed. Only the president may write `member_roles`.
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
git commit -m "Paddock Control"
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
  auth/     sign-in, the roster gate (RequireAuth), auth state
  data/     one hook per entity; season scoping lives in seasonQuery.ts
  pages/    one file per screen
  topics/   the topic workspace, shared by Now and Meetings
  ui/       error boundary and the shared loading/error/empty states
  lib/      the single Supabase client + generated types
docs/       now-metrics.sql — the SQL behind every number on the Now screen
supabase/   migrations
```

Two rules that keep it navigable: **one Supabase client** (`src/lib/supabase.ts`
— never call `createClient` anywhere else), and **`season_id` only appears inside
`src/data/`** — screens never handle it.
