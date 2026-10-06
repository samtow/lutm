# Cached Android builds on native Depot CI

The workflow is `.depot/workflows/android.yml`, not a GitHub-hosted runner
workflow. It uses a native Depot CI 32-vCPU / 128-GiB sandbox and
`depot/cache-mount` to persist `/mnt/lutm-cache` between runs.

## One-time repository approval

Install the [Depot Code Access app](https://depot.dev/orgs/_/github-actions/installation/create?codeAccess=true)
and grant it access to `samtow/lutm`. The authorized preflight currently reports
that this app is missing. No CI build can be started until that approval is
complete; a Depot Sandbox API credential alone does not grant repository access.

The repository setup installs the official Depot CLI. Configure `DEPOT_TOKEN`
securely in its environment, then check access:

```sh
depot ci migrate preflight --yes
```

Do not put the token in arguments, workflows, cache disks, Git, or chat. No
Depot or Convex credential is required inside the Android job.

## Start and monitor a run

After publishing the workflow, manually dispatch it on the desired branch:

```sh
depot ci dispatch --repo samtow/lutm --workflow android.yml --ref main \
  --input product=virtio_arm64only --output json
depot ci status <run-id>
depot ci logs <run-id>
depot ci metrics --run <run-id>
depot ci artifacts list <run-id>
```

Use `virtio_x86_64` for x86_64. During development, `depot ci run --workflow
.depot/workflows/android.yml` submits the local workflow and tracked changes.
Neither command should be used to duplicate an already running cold build.
The current detached build is deliberately left running while CI is prepared.

## Cache boundaries

- Cache names include repository, Lineage branch, product and a version. Keep
  the mount path stable; bump `v1` when intentionally invalidating the cache.
- Each product has its own checkout and outputs. Both partition layouts retain
  their separate `out/non-ab` and `out/ab` directories.
- A product-wide concurrency group permits only one writer across branches,
  with `cancel-in-progress: false`; sync and compilation never race on a cache.
- Before sync, the wrapper resets only the five source projects modified by
  our overlay/host repair and removes managed generated overlay files. It does
  not clean the compiler output trees or unrelated untracked source files.
- Sources are synced every run; `SKIP_SYNC` cannot bypass sync in this workflow.
  Compiler output is reusable, but old release staging is removed first.
- Only a successful complete build uploads release artifacts. Failed runs retain
  diagnostics, not stale releases. Archives use zero additional compression.
- The overlay also fixes the observed non-A/B OTA ZIP failure by preserving
  guest symlinks instead of traversing the build host's debug filesystem.

Cache disks are organization-wide, not repository-private: never store
credentials or untrusted output on them. The workflow only permits manual
trusted runs, not fork-PR triggers. Depot's default cache retention is 14 days;
after expiration the next run is cold. Cold-run speedups or warm-cache savings
have not been benchmarked yet, because CI access is not approved.

## Permanent tracker

Convex can follow a native CI run without manual job-sandbox IDs. Set
`DEPOT_CI_RUN_ID` to the returned run ID in the tracker deployment, and ensure
`DEPOT_BUILD_PRODUCT` matches the workflow input. The existing protected
`DEPOT_TOKEN` is reused. Polling resolves the latest `build` job attempt and
collects progress from its sandbox; retries reset old progress, and CI terminal
status remains visible after that sandbox exits. CI output files are available
through Depot's artifact commands, not falsely labeled as public GoFile uploads.

Leave `DEPOT_CI_RUN_ID` unset while tracking the current detached build. Clearing
it restores `DEPOT_SANDBOX_ID` mode. Convex remains cloud-hosted in either mode.

## Local checks

```sh
actionlint -config-file .depot/actionlint.yaml .depot/workflows/android.yml
bash sim/run-host-tests.sh
npm test --prefix sim/status
```

References: [durable cache disks](https://depot.dev/docs/ci/how-to-guides/cache-disks),
[CI CLI](https://depot.dev/docs/cli/reference/depot-ci),
[CI API](https://depot.dev/docs/api/ci/reference), and
[native sandbox sizes](https://depot.dev/docs/ci/overview#depot-ci-sandboxes).
