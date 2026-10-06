# Cached Android builds on native Depot CI

The workflow is `.depot/workflows/android.yml`, not a GitHub-hosted runner
workflow. It uses a native Depot CI 32-vCPU / 128-GiB sandbox. The active
Android checkout and both output trees are local under `/tmp/lutm-build`;
`depot/cache-mount` holds only a bulk archive checkpoint.

## Current storage constraint

The existing 32-vCPU native CI runner was measured at 150 GB provisioned local
disk (145.2 GiB filesystem), with about 94 GiB free after its image/tools/cache
client. The direct Sandbox build already occupied 254.4 GiB with A/B incomplete.
Local builds therefore use a conservative **400 GiB free** preflight, and a warm restore also
requires room for its archive contents plus headroom, before downloads begin.

Native CI's published `runs-on` options configure CPU/memory and optional
custom image, not disk size. This is not proof of a provider-wide hard cap;
there is no documented workflow disk override to apply here. The separate
Sandbox SDK supports `diskGb`, and the existing direct builder has a 1-TB disk.
Do not lower the guard to make the current native runner pass: it cannot hold
the measured build. A larger native local disk must be available before a
parallel local-I/O run can start. No known-insufficient run is launched.

## One-time repository approval

Install the [Depot Code Access app](https://depot.dev/orgs/_/github-actions/installation/create?codeAccess=true)
and grant it access to `samtow/lutm`. A Depot Sandbox API credential alone does
not grant repository access; the CI preflight verifies the separate approval.

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

- The `local-v2` cache and concurrency group are separate from the original
  live `v1` tree. The two modes may run in parallel without reading or modifying
  each other's cache. Each v2 product still has only one checkpoint writer.
- `android.tar` is streamed to local disk before source sync; Git checkout,
  compilation and packaging run locally at a stable path. Both layouts retain
  their separate `out/non-ab` and `out/ab` directories.
- After a successful build, GNU tar preserves links and sparse files while
  writing a temporary archive directly to the durable mount. Only a completed
  archive is renamed into place; failed builds or saves leave the prior good
  checkpoint intact. No second archive copy consumes local scratch space.
- Before sync, the wrapper resets only the five source projects modified by
  our overlay/host repair and removes managed generated overlay files. It does
  not clean the compiler output trees or unrelated untracked source files.
- Sources are synced every run; `SKIP_SYNC` cannot bypass sync in this workflow.
  Compiler output is reusable, but old release staging is removed first and
  release artifacts are excluded from checkpoints.
- Only a successful complete build uploads release artifacts. Failed runs retain
  diagnostics, not stale releases. Archives use zero additional compression.
- The overlay also fixes the observed non-A/B OTA ZIP failure by preserving
  guest symlinks instead of traversing the build host's debug filesystem.

Cache disks are organization-wide, not repository-private: never store
credentials or untrusted output on them. The workflow only permits manual
trusted runs, not fork-PR triggers. Depot's default cache retention is 14 days;
after expiration the next run is cold. Local-I/O speedups and warm-cache
savings have not been benchmarked yet,
because the measured native runner does not have enough local storage.

## Permanent tracker

Convex can follow a native CI run without manual job-sandbox IDs. Set
`DEPOT_CI_RUN_ID` to the returned run ID in the tracker deployment, and ensure
`DEPOT_BUILD_PRODUCT` matches the workflow input. The existing protected
`DEPOT_TOKEN` is reused. Polling resolves the latest `build` job attempt and
reads progress from native CI logs; retries reset old progress, and CI terminal
status remains visible after that sandbox exits. CI output files are available
through Depot's artifact commands, not falsely labeled as public GoFile uploads.
Log cursors stay private and only numerical progress or known stage labels are
published. Native CI sandboxes are not accessed through the standalone Sandbox API.

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
