import {configurationError, initialSnapshot, snapshotKey} from './status.mjs'
import {applyProgress} from './ci-progress.mjs'

async function request(env, method, args) {
  const response = await fetch(`https://api.depot.dev/depot.ci.v1.CIService/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.DEPOT_TOKEN}`,
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      ...(env.DEPOT_ORG_ID ? {'x-depot-org': env.DEPOT_ORG_ID} : {}),
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(20000),
  })
  if (!response.ok) throw new Error('Depot CI status unavailable')
  return response.json()
}

export async function refreshCIStatus(env, read = (method, args) => request(env, method, args)) {
  if (configurationError(env)) return initialSnapshot(env)
  const key = snapshotKey(env)
  let snapshot = await env.BUILD_STATUS.get(key, 'json') || initialSnapshot(env)
  try {
    const run = await read('GetRunStatus', {runId: env.DEPOT_CI_RUN_ID})
    const job = run.workflows?.flatMap(workflow => workflow.jobs || []).find(job => job.jobKey?.split(':').at(-1) === 'build')
    const attempt = [...(job?.attempts || [])].sort((a, b) => Number(b.attempt) - Number(a.attempt))[0]
    if (snapshot.ci?.attemptId && snapshot.ci.attemptId !== attempt?.attemptId) {
      snapshot = initialSnapshot(env)
      await env.BUILD_STATUS.put(key, JSON.stringify(snapshot))
    }
    const detail = job ? await read('GetJob', {jobId: job.jobId}) : null
    snapshot = {
      ...snapshot, status: attempt ? 'running' : 'preparing',
      stage: attempt ? 'Running Depot CI build' : job?.status === 'waiting' ? 'Waiting for the Android cache writer' : 'Queued in Depot CI',
      createdAt: detail?.runCreatedAt || snapshot.createdAt,
      ci: {runId: env.DEPOT_CI_RUN_ID, jobId: job?.jobId || null, attemptId: attempt?.attemptId || null, status: run.status},
    }
    if (detail?.runsOn?.cpus > 0 || detail?.runsOn?.memoryGb > 0) {
      snapshot.resources = {
        ...(detail.runsOn.cpus > 0 ? {vcpus: detail.runsOn.cpus} : {}),
        ...(detail.runsOn.memoryGb > 0 ? {memoryMb: detail.runsOn.memoryGb * 1024} : {}),
      }
    }
    if (attempt?.attemptId) {
      const cursorKey = `ci-log-cursor:${env.DEPOT_CI_RUN_ID}:${attempt.attemptId}`
      const cursor = await env.BUILD_STATUS.get(cursorKey, 'json') || {}
      // CI sandboxes are not available through the standalone Sandbox API.
      for (let page = 0; page < 3; page++) {
        const batch = await read('GetJobAttemptLogs', {attemptId: attempt.attemptId, pageToken: cursor.pageToken || ''})
        applyProgress(snapshot, cursor, batch.lines || [])
        const previous = cursor.pageToken
        if (batch.nextPageToken) cursor.pageToken = batch.nextPageToken
        if (!batch.lines?.length || !batch.nextPageToken || batch.nextPageToken === previous) break
      }
      await env.BUILD_STATUS.put(cursorKey, JSON.stringify(cursor))
      if (cursor.layout && snapshot.stage === 'Running Depot CI build') {
        snapshot.stage = cursor.layout === 'ab' ? 'Building A/B' : cursor.variant === 'userdebug' ? 'Building non-A/B recovery' : 'Building non-A/B'
      }
    }
    const terminal = ['finished', 'failed', 'cancelled'].includes(run.status)
    if (terminal) {
      const built = run.status === 'finished' && job?.status === 'finished'
      const failed = run.status === 'failed'
      snapshot = {
        ...snapshot, status: built ? 'built' : failed ? 'failed' : 'stopped',
        stage: built ? 'Images built · CI artifacts ready' : failed ? 'Depot CI build failed' : 'Depot CI build stopped',
        failure: failed ? snapshot.failure || 'Depot CI failed. See the private job logs.' : null,
        finishedAt: snapshot.finishedAt || detail?.jobFinishedAt || new Date().toISOString(),
        layouts: snapshot.layouts.map(layout => ({
          ...layout, status: built ? 'built' : layout.status === 'built' ? 'built' : failed ? 'failed' : 'stopped',
          progress: null,
          steps: layout.steps.map(step => built && step.label === 'Images' ? {...step, status: 'passed'}
            : step.status === 'running' ? {...step, status: failed ? 'failed' : 'stopped'} : step),
        })),
      }
    }
    snapshot = {
      ...snapshot, checkedAt: new Date().toISOString(), sampledAt: new Date().toISOString(),
      connection: 'live', error: null,
    }
  } catch {
    snapshot = {...snapshot, connection: 'unavailable', error: 'Depot CI could not be reached. Showing the last sample; cloud polling will retry.'}
  }
  await env.BUILD_STATUS.put(key, JSON.stringify(snapshot))
  return snapshot
}
