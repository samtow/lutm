import {createClient, Sandbox} from '@depot/sandbox'

export const refreshSeconds = 60
const terminal = new Set(['built', 'complete', 'failed', 'stopped'])
const snapshotKey = env => `snapshot:${env.DEPOT_SANDBOX_ID}`

function configurationError(env) {
  return !env.DEPOT_TOKEN || !env.DEPOT_SANDBOX_ID
    ? 'Set DEPOT_TOKEN and DEPOT_SANDBOX_ID in Cloudflare to connect the tracker.'
    : null
}

export function initialSnapshot(env) {
  const error = configurationError(env)
  return {
    status: error ? 'unconfigured' : 'connecting',
    stage: error ? 'Cloud tracker needs configuration' : 'Waiting for the first cloud sample',
    connection: error ? 'unconfigured' : 'connecting',
    product: env.DEPOT_BUILD_PRODUCT || 'virtio_arm64only',
    error,
    recent: [],
    layouts: ['non-ab', 'ab'].map(id => ({
      id, status: 'queued', progress: null, downloads: [],
      steps: ['Images', 'Policy', 'Image checks', 'Upload'].map(label => ({label, status: 'pending'})),
    })),
  }
}

export async function ensureSampling(storage) {
  if (await storage.getAlarm() === null) await storage.setAlarm(Date.now() + refreshSeconds * 1000)
}

export async function sampleOnAlarm(env, collector, storage, getBuilder = Sandbox.get) {
  try {
    return await refreshStatus(env, collector, getBuilder)
  } finally {
    const nextSampleAt = Date.now() + refreshSeconds * 1000
    await storage.setAlarm(nextSampleAt)
    await env.BUILD_STATUS.put('sampler', JSON.stringify({
      sampledAt: new Date().toISOString(), nextSampleAt: new Date(nextSampleAt).toISOString(),
    }))
  }
}

export async function refreshStatus(env, collector, getBuilder = Sandbox.get) {
  if (configurationError(env)) return initialSnapshot(env)
  const previous = await env.BUILD_STATUS.get(snapshotKey(env), 'json')
  let snapshot = previous || initialSnapshot(env)
  try {
    const builder = await getBuilder(createClient({token: env.DEPOT_TOKEN, orgID: env.DEPOT_ORG_ID}), env.DEPOT_SANDBOX_ID)
    const checkedAt = new Date().toISOString()
    if (builder.status === 'running') {
      // Inline collection avoids the SDK's client-streaming filesystem API.
      const command = await builder.runCommand({
        cmd: '/usr/bin/timeout',
        args: ['20', 'python3', '-c', collector, env.DEPOT_BUILD_ROOT || '/home/runner', env.DEPOT_BUILD_PRODUCT || 'virtio_arm64only'],
      })
      const finished = await command.wait()
      if (finished.exitCode !== 0) throw new Error('Collection failed')
      snapshot = JSON.parse(await command.stdout())
    } else if (['created', 'assigned', 'starting'].includes(builder.status)) {
      snapshot = {...initialSnapshot(env), status: 'preparing', stage: 'Preparing Depot builder', sampledAt: checkedAt}
    } else {
      const status = builder.status === 'failed' ? 'failed' : ['built', 'complete', 'failed'].includes(snapshot.status) ? snapshot.status : 'stopped'
      snapshot = {
        ...snapshot, status, sampledAt: checkedAt,
        stage: status === 'complete' ? 'Complete' : status === 'built' ? 'Images built · uploads not started' : status === 'failed' ? 'Build needs attention' : `Builder ${builder.status || 'stopped'}`,
        failure: status === 'failed' ? snapshot.failure || 'The Depot builder failed. Check its private log.' : snapshot.failure,
        layouts: snapshot.layouts.map(layout => ['complete', 'built', 'failed'].includes(layout.status) ? layout : {
          ...layout, status: 'stopped',
          steps: layout.steps.map(step => step.status === 'running' ? {...step, status: 'stopped'} : step),
        }),
      }
    }
    snapshot = {
      ...snapshot, checkedAt, createdAt: builder.createdAt || snapshot.createdAt, resources: builder.resources || snapshot.resources,
      connection: 'live', error: null,
      finishedAt: terminal.has(snapshot.status)
        ? (previous?.status === snapshot.status && previous.finishedAt) || builder.stoppedAt || snapshot.sampledAt
        : null,
    }
  } catch {
    snapshot = {...snapshot, connection: 'unavailable', error: 'A fresh Depot sample is unavailable. Showing the last successful sample; cloud polling will retry automatically.'}
  }
  await env.BUILD_STATUS.put(snapshotKey(env), JSON.stringify(snapshot))
  return snapshot
}

export async function serve(request, env) {
  let response
  const route = new URL(request.url).pathname
  if (request.method !== 'GET') {
    response = new Response('Method not allowed', {status: 405, headers: {Allow: 'GET'}})
  } else if (route === '/api/status') {
    const snapshot = configurationError(env) ? initialSnapshot(env) : await env.BUILD_STATUS.get(snapshotKey(env), 'json') || initialSnapshot(env)
    response = Response.json({...snapshot, sampler: await env.BUILD_STATUS.get('sampler', 'json'), refreshSeconds})
    response.headers.set('Cache-Control', 'no-store')
  } else if (route.startsWith('/api/')) {
    response = new Response('Not found', {status: 404})
  } else {
    response = await env.ASSETS.fetch(request)
  }
  const secured = new Response(response.body, response)
  secured.headers.set('X-Content-Type-Options', 'nosniff')
  secured.headers.set('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'")
  return secured
}
