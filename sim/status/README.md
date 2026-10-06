# Permanent cloud build tracker

The tracker runs on a **Convex production deployment**, not a temporary
preview account. Convex hosts the page, stores builder-isolated snapshots in
its database, and runs a one-minute cron job. There is no 60-minute account
claim deadline or sandbox polling server. Normal Convex plan limits apply.

Production tracker: <https://tacit-cod-390.convex.site/>

## Launch the Depot build

For repeat builds, prefer the [native cached Depot CI workflow](../ci/README.md).
The detached launcher below remains available for direct sandbox builds.

Use Node.js 20 or newer and authorized Depot sandbox access:

```sh
npm ci --prefix sim/status
npm test --prefix sim/status
npm run launch --prefix sim/status
```

Authentication uses `DEPOT_TOKEN` or a private `DEPOT_TOKEN_FILE` (default
`~/.config/hoplite-depot/token`). Set `DEPOT_ORG_ID` when the token requires an
organization. Never put credentials in Git, command-line arguments or chat.

The launcher transfers tracked `sim/` sources at local `HEAD`, uses Depot's
supported default Ubuntu runtime, and starts `sim/build.sh` detached with
sudo for prerequisite installation. It prints `DEPOT_SANDBOX_ID` and saves
nonsecret recovery information under `.hoplite/runtime/`. The default product
is `virtio_arm64only`; set `DEPOT_BUILD_PRODUCT=virtio_x86_64` for x86_64.
Builds are billable and have a finite six-hour lifetime, including source
sync. The launcher does not upload archives or assert they were boot-tested.
Reconnect to an existing builder rather than allocating a duplicate.

## Deploy the tracker

Create a Convex project and its default **production** deployment using the
official CLI or dashboard. Production deployments do not accept a temporary
expiration time. Configure a production deploy key in the deployment
environment as `CONVEX_DEPLOY_KEY`; keep it out of the repository.

Set these environment variables on that deployment:

| Variable | Purpose |
|---|---|
| `DEPOT_TOKEN` | Server-side Depot credential |
| `DEPOT_SANDBOX_ID` | Actual running builder from the launcher |
| `DEPOT_CI_RUN_ID` | Native CI run ID; when set, it takes precedence over the sandbox ID |
| `DEPOT_ORG_ID` | Optional organization required by some tokens |
| `DEPOT_BUILD_ROOT` | Builder root, normally `/home/runner` |
| `DEPOT_BUILD_PRODUCT` | `virtio_arm64only` or `virtio_x86_64` |

Use the dashboard or `convex env set --from-file` with a private file so secret
values do not enter shell history. Then run:

```sh
npm run check --prefix sim/status
npm run deploy --prefix sim/status
```

The check generates Convex bindings and validates a deployment dry run. Asset
bundling reads only `public/` and `collect.py`, never local credentials or
environment files. Generated bindings and bundled assets are ignored by Git.

The page and `/api/status` are served from the deployment's `convex.site`
hostname. The cron starts on deployment and continues without viewers or
chat activity. Its `sampler` timestamps show scheduled refreshes. Public
requests only read stored status; they cannot run Depot commands or write
snapshots. Only internal functions update the database and collect telemetry.

## Status guarantees

- Snapshots survive requests, cold starts and redeploys.
- Depot outages retain the last sample, mark it unavailable, and retry on the
  next cron run. The page labels old samples stale.
- Finished or cancelled builders cannot leave an image/check step running.
- Only confirmed build, policy, image-check and upload evidence earns a
  complete release. A build without uploads is labeled **built**.
- Public activity excludes raw commands and error output. Detailed logs stay
  on Depot; only verified `gofile.io/d/` links are rendered.
- Convex reads environment values explicitly, including in its HTTP runtime.
  Credentials are never included in public snapshots or browser assets.

## Optional local UI verification

Set the public `CONVEX_SITE_URL` in the environment or the ignored
`sim/status/.env.local`, then run `npm run dev --prefix sim/status`. This
development server serves local assets and proxies read-only status requests
to Convex. It does not poll Depot or store credentials.

Managed Preview remains disabled by default. For explicit UI verification,
temporarily use `LUTM_LOCAL_PREVIEW=1 bash .hoplite/run.sh` as the project's
run command, then restore it afterwards. Production does not depend on it.

References: [Convex HTTP actions](https://docs.convex.dev/functions/http-actions),
[cron jobs](https://docs.convex.dev/scheduling/cron-jobs),
[environment variables](https://docs.convex.dev/production/environment-variables),
and the [Depot SDK](https://depot.dev/docs/api/sandbox-sdk-reference).
