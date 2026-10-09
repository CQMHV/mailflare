# CQMHV installation fork

This fork preserves the Mailflare installation running at `https://mail.cqmhv.com`.
The original source is `hieunc229/mailflare`, initially based on commit
`83ade981e588bd7d693fe4a14850a844bcd8984a`.

## Configuration and data

The committed `wrangler.jsonc` identifies the existing `mailflare` Worker, D1
database, `mailflare-raw` bucket, queues and custom domain. Resource identifiers
are not credentials. Reuse these bindings when deploying this installation;
creating a new database or changing bucket names would disconnect existing data.
Cloudflare Access protects the custom domain, the workers.dev hostname and preview URLs.

`CF_TOKEN` remains a Cloudflare Worker secret. No API token, password, recovery
code, email backup, restored database, deployment log or generated build is part
of this repository. The `mailflare-backups` bucket is private and separate from
the application's main storage bucket. The tools in `scripts/r2-snapshot` run
locally; they are not a public production Worker.

## Installation changes

- Disable AI and its Worker binding for this installation.
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

For Cloudflare Workers Builds, connect this repository to the **existing**
`mailflare` Worker, choose production branch `main`, and use `npm run deploy:local`
as the deployment command. Preserve existing bindings and Worker secrets. GitHub
checks and the Cloudflare build log should both be reviewed after a deployment.

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
tracked tree with upstream. The dashboard updater still requires the upstream
documented GitHub update credentials; those credentials are not created or stored
by this fork setup.

## Backups

Mailflare's daily database backup runs at 02:00 UTC (10:00 Asia/Shanghai) when
enabled in the app and writes JSON into `mailflare-raw`. It does not back up the
R2 objects themselves. Separate R2 snapshots are currently manual. Follow
`scripts/r2-snapshot/README.md` for complete snapshots and isolated restoration.
Keep private backup files outside the source repository.
