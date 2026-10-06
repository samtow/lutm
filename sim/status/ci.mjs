import {configurationError, initialSnapshot, snapshotKey} from './status.mjs'

async function getRunStatus(env) {
  const response = await fetch('https://api.depot.dev/depot.ci.v1.CIService/GetRunStatus', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.DEPOT_TOKEN}`,
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      ...(env.DEPOT_ORG_ID ? {'x-depot-org': env.DEPOT_ORG_ID} : {}),
    },
    body: JSON.stringify({runId: env.DEPOT_CI_RUN_ID}),
    signal: AbortSignal.timeout(20000),
  })
  if (!response.ok) throw new Error('Depot CI status unavailable')
  return response.json()
}

export async function refreshCIStatus(env, collector, sampleBuilder, readRun = getRunStatus) {
  if (configurationError(env)) return initialSnapshot(env)
  const key = snapshotKey(env)
  let snapshot = await env.BUILD_STATUS.get(key, 'json') || initialSnapshot(env)
  try {
    const run = await readRun(env)
    const job = run.workflows?.flatMap(workflow => workflow.jobs || []).find(job => job.jobKey === 'build')
    const attempt = [...(job?.attempts || [])].sort((a, b) => Number(b.attempt) - Number(a.attempt))[0]
    if (snapshot.ci?.attemptId && snapshot.ci.attemptId !== attempt?.attemptId) {
      snapshot = initialSnapshot(env)
      await env.BUILD_STATUS.put(key, JSON.stringify(snapshot))
    }
    if (run.status === 'running' && attempt?.sandboxId) {
      snapshot = await sampleBuilder({
        ...env, DEPOT_SANDBOX_ID: attempt.sandboxId,
        DEPOT_BUILD_ROOT: '/tmp/lutm-build',
      }, collector)
    }
    const terminal = ['finished', 'failed', 'cancelled'].includes(run.status)
    if (terminal) {
      const built = run.status === 'finished' && job?.status === 'finished'
      const failed = run.status === 'failed'
      snapshot = {
        ...snapshot, status: built ? 'built' : failed ? 'failed' : 'stopped',
        stage: built ? 'Images built · CI artifacts ready' : failed ? 'Depot CI build failed' : 'Depot CI build stopped',
        failure: failed ? snapshot.failure || 'Depot CI failed. See the private job logs.' : null,
        finishedAt: snapshot.finishedAt || new Date().toISOString(),
        layouts: snapshot.layouts.map(layout => ({
          ...layout, status: built ? 'built' : layout.status === 'built' ? 'built' : failed ? 'failed' : 'stopped',
          progress: null,
          steps: layout.steps.map(step => built && step.label === 'Images' ? {...step, status: 'passed'}
            : step.status === 'running' ? {...step, status: failed ? 'failed' : 'stopped'} : step),
        })),
      }
    } else if (!attempt?.sandboxId) {
      snapshot = {...snapshot, status: 'preparing', stage: job?.status === 'waiting' ? 'Waiting for the Android cache writer' : 'Queued in Depot CI'}
    }
    snapshot = {
      ...snapshot, checkedAt: new Date().toISOString(),
      connection: snapshot.connection === 'unavailable' && !terminal && attempt?.sandboxId ? 'unavailable' : 'live',
      error: terminal || !attempt?.sandboxId ? null : snapshot.error,
      ci: {runId: env.DEPOT_CI_RUN_ID, jobId: job?.jobId || null, attemptId: attempt?.attemptId || null, status: run.status},
    }
  } catch {
    snapshot = {...snapshot, connection: 'unavailable', error: 'Depot CI could not be reached. Showing the last sample; cloud polling will retry.'}
  }
  await env.BUILD_STATUS.put(key, JSON.stringify(snapshot))
  return snapshot
}
