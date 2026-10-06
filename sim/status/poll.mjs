import {createClient, Sandbox} from '@depot/sandbox'
import {configurationError, initialSnapshot, refreshSeconds, snapshotKey} from './status.mjs'
import {refreshCIStatus} from './ci.mjs'

export {initialSnapshot, refreshSeconds, serve} from './status.mjs'
const terminal = new Set(['built', 'complete', 'failed', 'stopped'])

export async function sampleStatus(env, collector, getBuilder = Sandbox.get) {
  try {
    return env.DEPOT_CI_RUN_ID
      ? await refreshCIStatus(env)
      : await refreshStatus(env, collector, getBuilder)
  } finally {
    const nextSampleAt = Date.now() + refreshSeconds * 1000
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
        cwd: '/tmp',
        sudo: true,
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
