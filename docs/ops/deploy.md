# Production deploy (T1.6)

Production is the `inkly` Worker on workers.dev, with its own D1 database, R2 bucket
and KV namespace, all named `inkly`. `.github/workflows/deploy.yml` deploys `main`
after every merge (or on demand), but each run waits for a human to approve it on
the GitHub `production` environment.

## What a run does
`scripts/deploy-production.sh`:
1. Creates or reuses the `inkly` D1, R2 and KV, then writes
   `workers/api/wrangler.production.json` from `wrangler.jsonc` with their IDs.
2. Fails if that config mentions `TEST_HOOKS` (Q11).
3. Builds the web app, applies D1 migrations, then deploys. Migrations run before
   the new code, so every migration must work with the code that is already live.
4. Creates `BETTER_AUTH_SECRET` once if it is missing, and copies
   `RESEND_API_KEY`, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from GitHub
   secrets when they are set.
5. Waits for five healthy `/health` responses in a row, then checks that
   `POST /__test/seed` returns 404.

After that, the workflow runs `verify-app J-000` against the production URL.

## One-time setup (human)
1. Go to Settings, then Environments, then New environment, and create `production`.
   Add yourself under "Required reviewers". Under "Deployment branches", allow
   `main` only.
2. Add the repository secrets you want in production: `RESEND_API_KEY`,
   `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. The Cloudflare secrets already
   exist.
3. The Cloudflare API token needs Workers Scripts, D1, Workers R2 Storage and
   Workers KV Storage edit permissions. These are the same permissions previews use.

## Rollback
- **Code:** run `pnpm --filter @inkly/api exec wrangler rollback --name inkly`. It
  returns the Worker to the previous version. You can also pick a version in the
  dashboard under Workers, then `inkly`, then Deployments.
- **Data:** D1 Time Travel restores the database to any minute in the last 30
  days. Run
  `pnpm --filter @inkly/api exec wrangler d1 time-travel restore inkly --timestamp <unix-seconds>`.
  This overwrites production data, so a human decides and runs it.
- **Bad migration:** write a new forward migration that undoes it and merge it.
  Never edit a migration that has already been applied.
