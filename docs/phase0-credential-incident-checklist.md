# Phase 0 credential-exposure incident checklist

Context: the demo-account password documented in `accounts.md` and
`supabase/accounts.md` (used by the seven `*@sdumotorbike.test` logins on the
hosted Supabase project `zsmldveykmtmxuqqmddo`) has been pasted into AI
chat/agent sessions multiple times (see `claude.txt`). Those files are
git-ignored and were never committed — `git log --all --full-history` on
`accounts.md`, `supabase/accounts.md`, `mock-data.sql`, `claude.txt` and
`.env.local` returns nothing — but git-ignored is not the same as unexposed:
content pasted into an AI session leaves the machine over the network the
same as a commit would. Treat the password as compromised regardless of its
git status. This checklist is a manual to-do list for a human with access to
the Supabase project; nothing here was run automatically.

## 1. Credential rotation

- [ ] In the Supabase dashboard → Authentication → Users, set a new password
      for each of the seven `*@sdumotorbike.test` demo accounts (or delete
      and recreate them), so the leaked password no longer authenticates.
- [ ] Regenerate `mock-data.sql` locally for any future fresh-project seed
      with `python3 scripts/make_mock_data_sql.py` (now generates a new
      random password every run — it no longer reuses whatever password was
      already on disk) or supply your own via
      `MOCK_DATA_PASSWORD=... python3 scripts/make_mock_data_sql.py`.
- [ ] Confirm the anon key and project URL in `.env.local` are still the
      intended values (they are safe-to-expose by design — RLS is the real
      boundary — but rotate them too if there is any doubt).
- [ ] If the Supabase **database password** or **service_role key** was ever
      typed into a chat/AI session (not found in this repo, but check other
      channels — Slack, docs, screenshots), rotate those in the Supabase
      dashboard as well; unlike the anon key they bypass RLS entirely.

## 2. Session revocation

- [ ] Supabase dashboard → Authentication → Users → for each demo account,
      revoke/sign-out all active sessions (or use the "Sign out everywhere"
      action) so a session token issued under the old password stops working
      immediately, independent of the password change above.
- [ ] If any real (non-demo) member's account was ever signed in with a
      shared/demo password by mistake, revoke that session too.

## 3. Authentication-log inspection

- [ ] Supabase dashboard → Logs → Auth logs: filter for sign-ins to the seven
      `*@sdumotorbike.test` accounts and look for any sign-in from an IP or
      user agent nobody on the team recognizes, especially outside times the
      team was actively demoing the app.
- [ ] Cross-check sign-in timestamps against known team demo sessions
      (`supabase/accounts.md` "Status" line records when it was last verified
      working) — anything unexplained is a candidate for further review.
- [ ] Check Supabase → Logs → Postgres logs / API logs for unusual query
      volume or write activity from the anon/authenticated role around the
      same window, since RLS (not the password) is what actually limits what
      a signed-in demo account can do.

## 4. Git-history evaluation

- [ ] Already checked in this pass: `git log --all --full-history --
      accounts.md supabase/accounts.md mock-data.sql claude.txt .env.local`
      returns no commits — none of these files were ever tracked, on any
      branch, in this repository's history. No `git filter-repo` /
      history-rewrite is needed here.
- [ ] If this checklist is reused on another repo, don't assume the same:
      run the same `git log --all --full-history -- <file>` check per
      sensitive file before concluding it's clean, and also check forks/mirrors
      (e.g. GitHub's own cache of a force-pushed history) since a local
      history rewrite doesn't reach those.
- [ ] `git ls-files -z | xargs -0 grep -il <pattern>` (bypassing
      `.gitignore`) is how this pass confirmed no tracked file contains the
      account emails, the password, or the project ref — rerun this after
      any future change to confirm it still holds.

## Not covered here (explicitly out of scope for this pass)

- `claude.txt` (a raw historical AI-conversation log, ~363 KB) still
  contains the old plaintext password in at least two places. It was left
  untouched rather than silently rewritten, since it's a personal log, not
  an active credential store. Decide whether to redact it, delete it, or
  keep it as-is now that the password behind it is being rotated.
- No external system (Supabase, GitHub, Vercel) was modified by this pass.
  Everything in sections 1–3 is a manual action for whoever holds Supabase
  dashboard access.
