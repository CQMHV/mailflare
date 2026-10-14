# CQMHV installation fork

This fork preserves the Mailflare installation running at `https://mail.cqmhv.com`.
The original source is `hieunc229/mailflare`, initially based on commit
`83ade981e588bd7d693fe4a14850a844bcd8984a`.

The 2026-10-14 update merges upstream through
`92f8eec` (Mailflare 0.5.2), including the OpenRouter tool-schema and Workers AI
streaming fixes. The production database migrations `0061` and `0062` add only
columns to existing tables; apply them before deploying this version.

## Configuration and data

The committed `wrangler.jsonc` identifies the existing `mailflare` Worker, D1
database, `mailflare-raw` bucket, queues and custom domain. Resource identifiers
are not credentials. Reuse these bindings when deploying this installation;
creating a new database or changing bucket names would disconnect existing data.
The custom domain and workers.dev hostname use Mailflare's own authentication.
Cloudflare's account-level Access protection remains enabled for preview URLs.

`CF_TOKEN` remains a Cloudflare Worker secret. No API token, password, recovery
code, email backup, restored database, deployment log or generated build is part
of this repository. The `mailflare-backups` bucket is private and separate from
the application's main storage bucket. The tools in `scripts/r2-snapshot` run
locally; they are not a public production Worker.

## Installation changes

- Enable the native Workers AI `AI` binding. Select the assistant provider and
  supported models in Admin → Agent; these settings are stored in the database.
- Opt out of automatic catch-all binding with `MAILFLARE_CATCH_ALL=false`.
  Existing per-address rules still deliver to the Worker.
- Keep the selected Cloudflare sender and recipients when replying between
  addresses owned by the same mailbox.
- Preserve drafts and recover the composer after failed send requests.
- Avoid retrying outbound jobs whose successful delivery is already recorded.
  This does not guarantee exactly-once delivery after a crash before persistence.
- Include push subscriptions and Drive tables in complete database backups.
- Keep custom domain, workers.dev, preview URL and dashboard secret settings
  explicit across deployments.
- Remove commercial purchase/activation pages, upgrade prompts, Paymug runtime
  integration and license-based account seat or feature restrictions. Existing
  branding, account administration, shared mailboxes, forwarding and booking
  host management use their existing role and ownership permissions.

No commercial activation is required by this fork. The AGPL license and upstream
copyright notices still apply. Historical `license_settings` schema, migrations
and backup entries remain only to keep older full backups restorable; runtime
features never query license state. No data migration or new cloud resource is
needed. An upstream merge can reintroduce purchase UI or license conditions, so
review those changes before updating this installation.

## Verify and deploy

On a new computer, clone the fork and add the upstream remote once:

```sh
git clone https://github.com/CQMHV/mailflare.git
cd mailflare
git remote add upstream https://github.com/hieunc229/mailflare.git
```

Use Node 24 and the committed npm lockfile:

```sh
npm ci
npm run test:fork
npm run deploy:local
```

The deploy command builds and publishes the complete Worker, including email,
queue, cron and Durable Object handlers. Use an authorized Wrangler login or a
scoped deployment token supplied through secure environment configuration.
Never copy the runtime `CF_TOKEN` into Git or use it as a deployment credential.

`Fork Checks` runs the installation regression tests and complete build on pushes
and pull requests. It does not deploy or receive production credentials. This
targeted suite is distinct from the full upstream test suite, which has known
fixture failures and Windows SQLite teardown issues in the initial checkout.
It now also covers the upstream AI tool-schema and streaming fixes. The
fork-specific Worker bootstrap/backup tests live in
`tests/fork-setup-bootstrap-schema.test.mjs`; the original bootstrap test filename
tracks upstream's Node runtime coverage.

For Cloudflare Workers Builds, connect this repository to the **existing**
`mailflare` Worker. The configured production connection uses:

- Production branch: `main`; root directory: `/`.
- Build command: `npm run test:fork && npm run build`.
- Deploy command: `npx wrangler deploy`.
- Build environment: `NODE_VERSION=24`; preview builds disabled.
- Dedicated deployment token: `Mailflare Builds — CQMHV/mailflare`, stored only
  in Cloudflare Builds and separate from the runtime `CF_TOKEN`.

The deployment token has account-scoped Workers Scripts Edit, Queues Edit and
Account Settings Read; Workers Routes Edit and Zone Read for `cqmhv.com`; and
User Details Read and Memberships Read. It has no expiration. Temporary Workers
CI Edit permission was removed after token registration. Preserve existing
bindings and Worker secrets. This deploy command does not run remote database
migrations or modify Email Routing rules.

Cloudflare's generic token warning lists optional product permissions. Deploying
with existing D1 and R2 bindings does not require direct database or bucket access
under the [Workers permissions model](https://developers.cloudflare.com/workers/authorization/workers/#bindings).
Provisioning or accessing those resources directly would need separate permissions.
GitHub checks and the Cloudflare build log should both be reviewed after a deployment.

## Update upstream without dropping fork changes

Do not discard fork commits through GitHub's destructive sync option. Fetch and
merge upstream into a review branch, resolve conflicts, and run the verification
commands before merging the review into `main`:

```sh
git fetch upstream
git switch -c review-upstream-update
git merge upstream/main
npm ci
npm run test:fork
npm run build
```

The inherited `deploy-update.yml` workflow has been changed to perform a normal
Git merge, verify the fork tests and build, then push without force. A conflict or
failed check stops the workflow before pushing. It no longer replaces the entire
tracked tree with upstream.

The admin dashboard's Application update card describes this installation's
GitHub → Cloudflare Workers Builds deployment, links to `CQMHV/mailflare`'s
production `main` branch, GitHub checks and the existing Worker's build history,
and shows the running package version. It does not query or dispatch the
upstream one-click updater, so `GITHUB_UPDATE_TOKEN` and `GITHUB_UPDATE_REPO`
are not needed for this dashboard. Deployment success is checked in the linked
build history. The card also retrieves Cloudflare's public GitHub check runs via
the primary-admin-only `/api/admin/deployment` endpoint. It reads the five most
recent `main` commits, accepts only `Workers Builds: mailflare` results from the
Cloudflare GitHub app with a matching production build URL, and shows the newest
check run's status, reported timestamp and commit. Ordering uses check-run IDs,
because Cloudflare can report the completion time as `started_at` as well. A
newer head without a reported result is labelled separately, rather than inheriting an earlier deployment's
success. Retries of commits outside this recent window and manual deployments
without GitHub check runs remain available only in Cloudflare's build history.

This read-only lookup uses the public repository and no runtime/deployment token,
additional permissions, database tables or resources. Successful public GitHub
responses are eligible for five-minute Cloudflare fetch caching; errors are not
cached. The dashboard queries on opening and manual refresh, without background
polling. GitHub reporting and caching may delay the status; this is not a direct
live feed of Cloudflare's internal build stages. Rate limits and lookup errors
are shown without claiming a successful deployment or removing migration checks.
Database migration checks and actions remain independent and require the primary
admin. Keep the installation metadata in `src/lib/fork-deployment-config.ts` in
sync with the existing Worker and repository connection.

## Backups

Mailflare's daily database backup runs at 02:00 UTC (10:00 Asia/Shanghai) when
enabled in the app and writes JSON into `mailflare-raw`. It does not back up the
R2 objects themselves. Separate R2 snapshots are currently manual. Follow
`scripts/r2-snapshot/README.md` for complete snapshots and isolated restoration.
Keep private backup files outside the source repository.
