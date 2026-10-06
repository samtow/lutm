import assert from 'node:assert/strict'
import test from 'node:test'
import {initialSnapshot, refreshStatus, sampleStatus, serve} from './poll.mjs'
import {trackerEnvironment} from './status.mjs'

function environment(overrides = {}) {
  const entries = new Map()
  return {
    DEPOT_TOKEN: 'test-secret', DEPOT_SANDBOX_ID: 'builder-one', DEPOT_ORG_ID: 'test-org',
    BUILD_STATUS: {
      async get(key) { return entries.has(key) ? JSON.parse(entries.get(key)) : null },
      async put(key, value) { entries.set(key, value) },
    },
    ASSETS: {async fetch() { return new Response('<html>Tracker</html>', {headers: {'Content-Type': 'text/html'}}) }},
    ...overrides,
  }
}

function runningBuilder(snapshot, runCommand = async () => ({
  wait: async () => ({exitCode: 0}), stdout: async () => JSON.stringify(snapshot),
})) {
  return {status: 'running', resources: {vcpus: 32, memoryMb: 131072}, createdAt: '2026-10-05T12:00:00Z', runCommand}
}

test('unconfigured polling does not contact Depot or invent resources', async () => {
  const env = environment({DEPOT_TOKEN: ''})
  const result = await refreshStatus(env, 'collector', () => assert.fail('Depot must not be called'))
  assert.equal(result.status, 'unconfigured')
  assert.equal(result.resources, undefined)
  assert.equal(result.layouts.length, 2)
  assert.equal((await serve(new Request('https://tracker.test/api/status'), env)).status, 200)
})

test('the HTTP runtime can read configuration from non-enumerable environment variables', async () => {
  const source = new Proxy({}, {get: (target, key) => ({DEPOT_TOKEN: 'test-secret', DEPOT_SANDBOX_ID: 'builder-one'})[key]})
  assert.deepEqual({...source}, {})
  const env = environment(trackerEnvironment(source))
  const sample = {...initialSnapshot(env), status: 'running', stage: 'Syncing sources', connection: 'live'}
  await env.BUILD_STATUS.put('snapshot:builder-one', JSON.stringify(sample))
  const result = await (await serve(new Request('https://tracker.test/api/status'), env)).json()
  assert.equal(result.status, 'running')
  assert.equal(result.connection, 'live')
  assert.ok(!JSON.stringify(result).includes('test-secret'))
})

test('a scheduled sample is persisted and public reads only use storage', async () => {
  const env = environment()
  const sample = {...initialSnapshot(env), status: 'running', stage: 'Building non-A/B', sampledAt: new Date().toISOString()}
  let commands = 0
  const builder = runningBuilder(sample, async options => {
    commands++
    assert.deepEqual(options.args, ['20', 'python3', '-c', 'collector-source', '/home/runner', 'virtio_arm64only'])
    assert.equal(options.cwd, '/tmp')
    assert.equal(options.sudo, true)
    return {wait: async () => ({exitCode: 0}), stdout: async () => JSON.stringify(sample)}
  })
  await refreshStatus(env, 'collector-source', async (client, id) => {
    assert.equal(id, 'builder-one')
    return builder
  })
  const response = await serve(new Request('https://tracker.test/api/status'), env)
  const result = await response.json()
  assert.equal(result.stage, sample.stage)
  assert.equal(result.connection, 'live')
  assert.equal(result.refreshSeconds, 60)
  assert.equal(result.resources.vcpus, 32)
  assert.equal(commands, 1)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.ok(!JSON.stringify(result).includes(env.DEPOT_TOKEN))
})

test('Depot errors preserve the saved sample without exposing error contents', async () => {
  const env = environment()
  const sample = {...initialSnapshot(env), status: 'failed', stage: 'Build needs attention', sampledAt: '2026-10-05T12:00:00Z', failure: 'Build failed (exit 1).'}
  await refreshStatus(env, '', async () => runningBuilder(sample))
  const result = await refreshStatus(env, '', async () => { throw new Error('private-token or private response body') })
  assert.equal(result.status, 'failed')
  assert.equal(result.failure, sample.failure)
  assert.equal(result.sampledAt, sample.sampledAt)
  assert.equal(result.connection, 'unavailable')
  assert.ok(!JSON.stringify(result).includes('private-token'))
  assert.equal((await (await serve(new Request('https://tracker.test/api/status'), env)).json()).connection, 'unavailable')
})

test('a new builder never reuses the previous builder completion', async () => {
  const env = environment()
  await refreshStatus(env, '', async () => runningBuilder({...initialSnapshot(env), status: 'complete', stage: 'Complete'}))
  env.DEPOT_SANDBOX_ID = 'builder-two'
  const result = await (await serve(new Request('https://tracker.test/api/status'), env)).json()
  assert.equal(result.status, 'connecting')
  assert.equal(result.layouts[0].status, 'queued')
})

test('a stopped builder does not leave images or checks running', async () => {
  const env = environment()
  const sample = initialSnapshot(env)
  sample.status = 'running'
  sample.layouts[0].status = 'building'
  sample.layouts[0].steps[0].status = 'running'
  await refreshStatus(env, '', async () => runningBuilder(sample))
  const result = await refreshStatus(env, '', async () => ({status: 'cancelled', stoppedAt: '2026-10-05T13:00:00Z'}))
  assert.equal(result.status, 'stopped')
  assert.equal(result.layouts[0].status, 'stopped')
  assert.equal(result.layouts[0].steps[0].status, 'stopped')
  assert.equal(result.finishedAt, '2026-10-05T13:00:00Z')
  assert.equal(result.resources.vcpus, 32)
})

test('terminal builders retain confirmed build-only results and failures', async () => {
  for (const status of ['built', 'complete', 'failed']) {
    const env = environment()
    const sample = {...initialSnapshot(env), status, sampledAt: '2026-10-05T12:00:00Z'}
    sample.layouts.forEach(layout => { layout.status = status })
    await refreshStatus(env, '', async () => runningBuilder(sample))
    const result = await refreshStatus(env, '', async () => ({status: 'finished'}))
    assert.equal(result.status, status)
    assert.equal(result.layouts[0].status, status)
    assert.equal(result.finishedAt, sample.sampledAt)
  }
})

test('a starting builder is preparing, not stopped', async () => {
  const result = await refreshStatus(environment(), '', async () => ({status: 'starting'}))
  assert.equal(result.status, 'preparing')
  assert.equal(result.stage, 'Preparing Depot builder')
})

test('a failed builder is reported even after its images were built', async () => {
  const env = environment()
  const sample = {...initialSnapshot(env), status: 'built', sampledAt: '2026-10-05T12:00:00Z'}
  sample.layouts.forEach(layout => { layout.status = 'built' })
  await refreshStatus(env, '', async () => runningBuilder(sample))
  const result = await refreshStatus(env, '', async () => ({status: 'failed'}))
  assert.equal(result.status, 'failed')
  assert.equal(result.layouts[0].status, 'built')
  assert.ok(result.failure)
})

test('collector failures are not treated as successful live samples', async () => {
  const result = await refreshStatus(environment(), '', async () => runningBuilder({}, async () => ({wait: async () => ({exitCode: 124})})))
  assert.equal(result.connection, 'unavailable')
  assert.equal(result.status, 'connecting')
})

test('asset responses retain security headers and API methods are read-only', async () => {
  const env = environment()
  const response = await serve(new Request('https://tracker.test/'), env)
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff')
  assert.ok(response.headers.get('Content-Security-Policy').includes("script-src 'self'"))
  assert.equal(await response.text(), '<html>Tracker</html>')
  assert.equal((await serve(new Request('https://tracker.test/api/status', {method: 'POST'}), env)).status, 405)
  assert.equal((await serve(new Request('https://tracker.test/api/unknown'), env)).status, 404)
})

test('scheduled sampling persists a heartbeat without viewers or Depot credentials', async () => {
  const env = environment({DEPOT_TOKEN: ''})
  await sampleStatus(env, '', () => assert.fail('No authorized Depot call'))
  const result = await (await serve(new Request('https://tracker.test/api/status'), env)).json()
  assert.equal(result.status, 'unconfigured')
  assert.ok(result.sampler.sampledAt)
  assert.ok(Date.parse(result.sampler.nextSampleAt) > Date.now())
})

test('cloud sampling failures still persist the heartbeat', async () => {
  const env = environment()
  await sampleStatus(env, '', async () => { throw new Error('private provider error') })
  const result = await (await serve(new Request('https://tracker.test/api/status'), env)).json()
  assert.equal(result.connection, 'unavailable')
  assert.ok(Date.parse(result.sampler.nextSampleAt) > Date.now())
  assert.ok(result.sampler.sampledAt)
})
