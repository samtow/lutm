import assert from 'node:assert/strict'
import test from 'node:test'
import {refreshCIStatus} from './ci.mjs'
import {applyProgress} from './ci-progress.mjs'
import {initialSnapshot, snapshotKey} from './status.mjs'

function environment() {
  const entries = new Map()
  return {
    DEPOT_TOKEN: 'test-secret', DEPOT_CI_RUN_ID: 'run-one',
    BUILD_STATUS: {
      async get(key) { return entries.has(key) ? JSON.parse(entries.get(key)) : null },
      async put(key, value) { entries.set(key, value) },
    },
  }
}

function run(status = 'running', attempts = []) {
  return {status, workflows: [{jobs: [{jobKey: 'android.yml:build', jobId: 'build-job', status, attempts}]}]}
}

function api(state, batches = [], detail = {}) {
  return async (method, args) => {
    if (method === 'GetRunStatus') return state
    if (method === 'GetJob') {
      assert.deepEqual(args, {jobId: 'build-job'})
      return {runCreatedAt: '2026-10-06T00:25:30Z', ...detail}
    }
    if (method === 'GetJobAttemptLogs') return batches.shift() || {lines: []}
    assert.fail(`Unsupported CI method ${method}`)
  }
}

const attempt = {attempt: 1, attemptId: 'ci-attempt', sandboxId: 'not-a-standalone-sandbox'}

test('queued CI status requires no sandbox access or log collection', async () => {
  const env = environment()
  const value = await refreshCIStatus(env, api(run('queued')))
  assert.equal(value.stage, 'Queued in Depot CI')
  assert.equal(value.connection, 'live')
  assert.equal(value.resources, undefined)
  assert.equal(snapshotKey(env), 'ci:run-one')
})

test('native CI uses authenticated Connect status, job and bounded log methods', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const method = url.split('/').at(-1)
    calls.push(method)
    assert.equal(options.method, 'POST')
    assert.equal(options.headers.Authorization, 'Bearer test-secret')
    assert.equal(options.headers['Connect-Protocol-Version'], '1')
    if (method === 'GetRunStatus') {
      assert.deepEqual(JSON.parse(options.body), {runId: 'run-one'})
      return Response.json(run('running', [attempt]))
    }
    if (method === 'GetJob') return Response.json({runsOn: {cpus: 32, memoryGb: 128}})
    assert.equal(method, 'GetJobAttemptLogs')
    assert.deepEqual(JSON.parse(options.body), {attemptId: 'ci-attempt', pageToken: ''})
    return Response.json({lines: [{stepName: 'Build both partition layouts incrementally', body: 'repo initialized'}]})
  })
  const result = await refreshCIStatus(environment())
  assert.deepEqual(calls, ['GetRunStatus', 'GetJob', 'GetJobAttemptLogs'])
  assert.equal(result.stage, 'Syncing sources')
  assert.equal(result.resources.vcpus, 32)
  assert.equal(result.resources.memoryMb, 131072)
  assert.ok(!JSON.stringify(result).includes('test-secret'))
})

test('workflow-qualified keys resolve the newest native CI attempt', async () => {
  const attempts = [attempt, {...attempt, attempt: 2, attemptId: 'new-attempt'}]
  const read = api(run('running', attempts))
  const result = await refreshCIStatus(environment(), async (method, args) => {
    if (method === 'GetJobAttemptLogs') assert.equal(args.attemptId, 'new-attempt')
    return read(method, args)
  })
  assert.equal(result.ci.jobId, 'build-job')
  assert.equal(result.ci.attemptId, 'new-attempt')
})

test('native log pagination keeps its cursor private and resumes after empty polls', async () => {
  const env = environment()
  const first = api(run('running', [attempt]), [
    {lines: [{body: 'OUT_DIR=out/non-ab'}, {body: '[ 20% 20/100] private-command'}], nextPageToken: 'cursor-one'},
    {lines: []},
  ])
  const result = await refreshCIStatus(env, first)
  assert.equal(result.layouts[0].progress.percent, 20)
  assert.ok(!JSON.stringify(result).includes('cursor-one'))
  await refreshCIStatus(env, async (method, args) => {
    if (method === 'GetJobAttemptLogs') assert.equal(args.pageToken, 'cursor-one')
    return api(run('running', [attempt]))(method, args)
  })
})

test('quiet source sync retains its last observed phase between log polls', async () => {
  const env = environment()
  const first = api(run('running', [attempt]), [
    {lines: [{stepName: 'Build both partition layouts incrementally', body: 'repo initialized'}], nextPageToken: 'sync-cursor'},
    {lines: []},
  ])
  assert.equal((await refreshCIStatus(env, first)).stage, 'Syncing sources')
  assert.equal((await refreshCIStatus(env, api(run('running', [attempt])))).stage, 'Syncing sources')
})

test('each cloud sample reads at most three native log pages', async () => {
  let pages = 0
  const read = api(run('running', [attempt]))
  await refreshCIStatus(environment(), async (method, args) => {
    if (method !== 'GetJobAttemptLogs') return read(method, args)
    pages++
    return {lines: [{body: 'safe ignored line'}], nextPageToken: `cursor-${pages}`}
  })
  assert.equal(pages, 3)
})

test('a retry resets the old failure, progress and log cursor', async () => {
  const env = environment()
  await env.BUILD_STATUS.put(snapshotKey(env), JSON.stringify({...initialSnapshot(env), status: 'failed', failure: 'Old failure', ci: {attemptId: 'old'}}))
  const read = api(run('running', [attempt]))
  const result = await refreshCIStatus(env, async (method, args) => {
    if (method === 'GetJobAttemptLogs') assert.equal(args.pageToken, '')
    return read(method, args)
  })
  assert.equal(result.status, 'running')
  assert.equal(result.failure, undefined)
})

test('progress summaries never retain raw commands, credentials or target errors', () => {
  const env = environment()
  const snapshot = initialSnapshot(env)
  const cursor = {}
  applyProgress(snapshot, cursor, [
    {body: 'TARGET_BUILD_VARIANT=userdebug'}, {body: 'OUT_DIR=out/non-ab'},
    {body: '[ 28% 28/100] token=test-secret private-command'},
    {body: 'FAILED: target using test-secret'},
  ])
  assert.deepEqual(snapshot.recent, ['Build actions: 28% (28/100)'])
  assert.equal(snapshot.layouts[0].status, 'failed')
  assert.ok(!JSON.stringify({snapshot, cursor}).includes('test-secret'))
  assert.ok(!JSON.stringify(snapshot).includes('private-command'))
})

test('layout transitions reset progress and staged releases remain built', () => {
  const snapshot = initialSnapshot(environment())
  applyProgress(snapshot, {}, [
    {body: 'OUT_DIR=out/non-ab'}, {body: '[100% 100/100] done'},
    {body: 'build.sh: non-ab release staged in out/releases; runtime not tested'},
    {body: 'OUT_DIR=out/ab'}, {body: '[ 5% 5/100] compile'},
  ])
  assert.equal(snapshot.layouts[0].status, 'built')
  assert.equal(snapshot.layouts[0].progress, null)
  assert.equal(snapshot.layouts[1].progress.percent, 5)
  assert.deepEqual(snapshot.recent, ['Build actions: 5% (5/100)'])
})

test('local cache phases use known labels rather than raw transfer logs', () => {
  const snapshot = initialSnapshot(environment())
  const cursor = {}
  applyProgress(snapshot, cursor, [{body: 'ci-build.sh: restoring Android cache to local disk'}])
  assert.equal(snapshot.stage, 'Restoring Android cache')
  applyProgress(snapshot, cursor, [{body: 'ci-build.sh: saving Android cache from local disk'}])
  assert.equal(snapshot.stage, 'Saving Android cache')
  applyProgress(snapshot, cursor, [{body: 'ci-build.sh: Android cache checkpoint saved'}])
  assert.equal(snapshot.stage, 'Android cache saved')
})

test('successful native CI completion marks images built without public download claims', async () => {
  const result = await refreshCIStatus(environment(), api(run('finished')))
  assert.equal(result.status, 'built')
  assert.equal(result.stage, 'Images built · CI artifacts ready')
  assert.ok(result.layouts.every(layout => layout.status === 'built' && layout.downloads.length === 0))
})

test('terminal CI failures expose a safe summary and stop running steps', async () => {
  const env = environment()
  const saved = initialSnapshot(env)
  saved.layouts[0].steps[0].status = 'running'
  await env.BUILD_STATUS.put(snapshotKey(env), JSON.stringify(saved))
  const result = await refreshCIStatus(env, api({...run('failed'), errorMessage: 'private-auth-value'}))
  assert.equal(result.status, 'failed')
  assert.equal(result.layouts[0].steps[0].status, 'failed')
  assert.ok(!JSON.stringify(result).includes('private-auth-value'))
})

test('API outages preserve saved CI status without exposing provider errors', async () => {
  const env = environment()
  await env.BUILD_STATUS.put(snapshotKey(env), JSON.stringify({...initialSnapshot(env), stage: 'Building non-A/B'}))
  const result = await refreshCIStatus(env, async () => { throw new Error('private-token') })
  assert.equal(result.stage, 'Building non-A/B')
  assert.equal(result.connection, 'unavailable')
  assert.ok(!JSON.stringify(result).includes('private-token'))
})
