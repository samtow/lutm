import assert from 'node:assert/strict'
import test from 'node:test'
import {refreshCIStatus} from './ci.mjs'
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
  return {status, workflows: [{jobs: [{jobKey: 'build', jobId: 'build-job', status, attempts}]}]}
}

test('queued CI status does not allocate or contact a sandbox', async () => {
  const env = environment()
  const value = await refreshCIStatus(env, '', () => assert.fail('No active builder'), async () => run('queued'))
  assert.equal(value.stage, 'Queued in Depot CI')
  assert.equal(value.connection, 'live')
  assert.equal(value.resources, undefined)
  assert.equal(snapshotKey(env), 'ci:run-one')
})

test('native CI status uses the documented authenticated Connect request', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.depot.dev/depot.ci.v1.CIService/GetRunStatus')
    assert.equal(options.method, 'POST')
    assert.equal(options.headers.Authorization, 'Bearer test-secret')
    assert.equal(options.headers['Connect-Protocol-Version'], '1')
    assert.deepEqual(JSON.parse(options.body), {runId: 'run-one'})
    return Response.json(run('queued'))
  })
  const value = await refreshCIStatus(environment(), '', () => assert.fail('No active builder'))
  assert.equal(value.connection, 'live')
  assert.ok(!JSON.stringify(value).includes('test-secret'))
})

test('the latest CI attempt is sampled through its real sandbox ID', async () => {
  const env = environment()
  const attempts = [{attempt: 2, attemptId: 'attempt-two', sandboxId: 'builder-two'}, {attempt: 1, attemptId: 'attempt-one', sandboxId: 'builder-one'}]
  const result = await refreshCIStatus(env, 'collector', async (settings, source) => {
    assert.equal(settings.DEPOT_SANDBOX_ID, 'builder-two')
    assert.equal(settings.DEPOT_BUILD_ROOT, '/tmp/lutm-build')
    assert.equal(source, 'collector')
    return {...initialSnapshot(settings), connection: 'live', status: 'running', stage: 'Building A/B'}
  }, async () => run('running', attempts))
  assert.equal(result.stage, 'Building A/B')
  assert.equal(result.ci.attemptId, 'attempt-two')
})

test('a retry cannot inherit a failed attempt snapshot', async () => {
  const env = environment()
  await env.BUILD_STATUS.put(snapshotKey(env), JSON.stringify({...initialSnapshot(env), status: 'failed', failure: 'Old failure', ci: {attemptId: 'old'}}))
  const result = await refreshCIStatus(env, '', async settings => {
    const previous = await settings.BUILD_STATUS.get(snapshotKey(settings), 'json')
    assert.equal(previous.failure, undefined)
    return {...previous, status: 'running', connection: 'live'}
  }, async () => run('running', [{attempt: 2, attemptId: 'new', sandboxId: 'builder'}]))
  assert.equal(result.status, 'running')
  assert.equal(result.failure, undefined)
})

test('successful native CI completion records built images, not unverified uploads', async () => {
  const result = await refreshCIStatus(environment(), '', () => assert.fail('Job has ended'), async () => run('finished'))
  assert.equal(result.status, 'built')
  assert.equal(result.stage, 'Images built · CI artifacts ready')
  assert.ok(result.layouts.every(layout => layout.status === 'built' && layout.downloads.length === 0))
})

test('CI failures expose a safe summary and stop running steps', async () => {
  const env = environment()
  const saved = initialSnapshot(env)
  saved.layouts[0].steps[0].status = 'running'
  await env.BUILD_STATUS.put(snapshotKey(env), JSON.stringify(saved))
  const result = await refreshCIStatus(env, '', () => assert.fail('Job has ended'), async () => ({...run('failed'), errorMessage: 'private-auth-value'}))
  assert.equal(result.status, 'failed')
  assert.equal(result.layouts[0].steps[0].status, 'failed')
  assert.ok(!JSON.stringify(result).includes('private-auth-value'))
})

test('API outages preserve the saved CI snapshot without leaking errors', async () => {
  const env = environment()
  await env.BUILD_STATUS.put(snapshotKey(env), JSON.stringify({...initialSnapshot(env), stage: 'Building non-A/B'}))
  const result = await refreshCIStatus(env, '', () => assert.fail(), async () => { throw new Error('private-token') })
  assert.equal(result.stage, 'Building non-A/B')
  assert.equal(result.connection, 'unavailable')
  assert.ok(!JSON.stringify(result).includes('private-token'))
})
