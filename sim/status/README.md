# Cloud build tracker

The production tracker is a Cloudflare Worker with static assets, a one-minute
Durable Object alarm and persistent SQLite-backed storage. It has no
always-running server, no thread-local builder dependency and no sandbox
polling process. Closing chat or stopping the local Preview does not stop
cloud sampling.

## Launch the Depot build

Use Node.js 22 or newer and authorized Depot sandbox access:

```sh
npm ci --prefix sim/status
npm test --prefix sim/status
npm run check --prefix sim/status
npm run launch --prefix sim/status
```

Authentication uses `DEPOT_TOKEN` or a private `DEPOT_TOKEN_FILE` (default
`~/.config/hoplite-depot/token`). Set `DEPOT_ORG_ID` when the token requires an
organization. Never put credentials in Git, command-line arguments or chat.

The launcher uses Depot's default base image, transfers the tracked `sim/`
sources at local `HEAD`, installs Ubuntu build prerequisites as root, and
starts `sim/build.sh` detached in Depot. Public-registry images such as
`ubuntu:24.04` are not supported by Depot sandboxes. It
prints `DEPOT_SANDBOX_ID` and saves nonsecret recovery information under
`.hoplite/runtime/`. The default product is `virtio_arm64only`; set
`DEPOT_BUILD_PRODUCT=virtio_x86_64` for x86_64. Builds are billable and have a
finite six-hour default lifetime, including provisioning and source sync.
The launcher does not upload archives or assert that they were boot-tested.

## Deploy the tracker

Use a permanent Cloudflare account for ongoing production tracking. Configure
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` securely in the deployment
environment, then deploy with the builder ID from the launcher:

```sh
cd sim/status
npm run deploy -- --var DEPOT_SANDBOX_ID:<builder-id> --var DEPOT_ORG_ID:<org-id>
npx wrangler secret put DEPOT_TOKEN
```

Omit `DEPOT_ORG_ID` only when it is not required by your Depot token. For
x86_64, also pass `--var DEPOT_BUILD_PRODUCT:virtio_x86_64`. Existing dashboard
variables and secrets are preserved on redeploy. The Durable Object is provisioned
automatically; no account-specific resource ID needs to be committed.

The page reports **setup required** until both `DEPOT_TOKEN` and
`DEPOT_SANDBOX_ID` are present. Open `/api/status` once after deployment to arm
the sampler; its alarm then reschedules itself without viewers. Each sample
schedules the next one a minute later. `/api/status` only reads saved progress
and initializes the alarm once, never running a Depot command. Snapshots are
isolated by builder ID; changing builders cannot inherit an older completion.
The response's `sampler` timestamps confirm the cloud alarm is running even
when Depot has not been configured yet.

Wrangler also supports `npm run deploy -- --temporary` without an account
login. This is a **60-minute preview**, not a permanent deployment. Claim the
temporary account using Wrangler's private claim link before it expires to
retain the Worker and supported resources. Do not publish the claim link in
Git or a pull request. After claiming, configure Depot credentials in the
Worker's settings and use permanent account authentication for later deploys.

## Status guarantees

- Cloud samples are retained across requests, cold starts and redeploys.
- Depot outages retain the last sample, explicitly mark it unavailable, and
  retry on the next scheduled invocation. The page labels old samples stale.
- Finished or cancelled builders cannot leave an image/check step running.
- Only confirmed build, policy, image-inspection and upload evidence earns a
  complete release. A successful build without uploads is labeled **built**.
- Public activity excludes raw commands and error output. Detailed diagnostic
  logs remain on Depot. Only verified `gofile.io/d/` links are rendered.

## Optional local development

```sh
npm run dev --prefix sim/status
```

Wrangler serves the same Worker and assets on port 3000 using local durable
storage. To exercise collection, place local values in the ignored
`sim/status/.dev.vars` file and open the page to arm its local alarm. The
managed Preview is disabled by default: automatic sandbox startup exits
without a server. For an explicit managed development preview, temporarily
set the project's run command to `LUTM_LOCAL_PREVIEW=1 bash .hoplite/run.sh`,
then restore it afterwards. Production does not depend on local Preview.

References: [static assets](https://developers.cloudflare.com/workers/static-assets/),
[Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/),
[temporary accounts](https://developers.cloudflare.com/workers/platform/claim-deployments/),
and the [Depot SDK](https://depot.dev/docs/api/sandbox-sdk-reference).
