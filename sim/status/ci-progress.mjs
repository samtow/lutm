const layouts = ['non-ab', 'ab']
const stages = {
  'Check local Android workspace capacity': 'Checking local build storage',
  'Install Android prerequisites': 'Installing Android prerequisites',
  'Mount Android source and output cache': 'Mounting Android cache',
  'Mount Android archive checkpoint cache': 'Mounting Android cache',
  'Build both partition layouts incrementally': 'Syncing sources',
  'Restore cache, build on local disk, save checkpoint': 'Preparing local Android workspace',
  'Publish checked release artifacts': 'Uploading CI artifacts',
}

function buildStage(cursor) {
  return cursor.layout === 'ab' ? 'Building A/B' : cursor.variant === 'userdebug' ? 'Building non-A/B recovery' : 'Building non-A/B'
}

export function applyProgress(snapshot, cursor, lines) {
  for (const entry of lines) {
    const timestamp = Number(entry.timestampMs)
    if (Number.isFinite(timestamp) && timestamp > 0) snapshot.logUpdatedAt = new Date(timestamp).toISOString()
    const line = String(entry.body || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim()
    if (stages[entry.stepName]) {
      cursor.stage = ['Build both partition layouts incrementally', 'Restore cache, build on local disk, save checkpoint'].includes(entry.stepName) && cursor.layout
        ? buildStage(cursor)
        : stages[entry.stepName]
    }
    if (line === 'ci-build.sh: restoring Android cache to local disk') cursor.stage = 'Restoring Android cache'
    if (line === 'ci-build.sh: saving Android cache from local disk') cursor.stage = 'Saving Android cache'
    if (line === 'ci-build.sh: Android cache checkpoint saved') cursor.stage = 'Android cache saved'
    if (line === 'ci-build.sh: no archive checkpoint; starting a cold local build' || line.startsWith('repo has been initialized in ')) cursor.stage = 'Syncing sources'
    if (line.startsWith('TARGET_BUILD_VARIANT=')) {
      const variant = line.slice('TARGET_BUILD_VARIANT='.length)
      if (['user', 'userdebug'].includes(variant)) cursor.variant = variant
    }
    if (line.startsWith('OUT_DIR=')) {
      const layout = line.slice('OUT_DIR='.length).replace(/\/$/, '').split('/').at(-1)
      if (layouts.includes(layout)) {
        cursor.layout = layout
        cursor.stage = buildStage(cursor)
        const current = snapshot.layouts.find(item => item.id === layout)
        current.status = 'building'
        current.progress = null
        current.steps[0].status = 'running'
        snapshot.recent = []
        snapshot.failure = null
      }
    }
    const progress = line.match(/\[\s*(\d+)%\s+(\d+)\/(\d+)/)
    if (progress && cursor.layout) {
      const [percent, done, total] = progress.slice(1).map(Number)
      if (Number.isSafeInteger(total) && percent <= 100 && done <= total) {
        snapshot.layouts.find(item => item.id === cursor.layout).progress = {percent, done, total}
        snapshot.recent = [...snapshot.recent, `Build actions: ${percent}% (${done}/${total})`].slice(-6)
      }
    }
    const release = line.match(/^build\.sh: (non-ab|ab) release staged in /)
    if (release) {
      const current = snapshot.layouts.find(item => item.id === release[1])
      current.status = 'built'
      current.progress = null
      current.steps[0].status = 'passed'
    }
    if (line.startsWith('FAILED:')) {
      snapshot.failure = 'Compiler reported a failure. See the private CI logs for details.'
      if (cursor.layout) {
        const current = snapshot.layouts.find(item => item.id === cursor.layout)
        current.status = 'failed'
        current.steps[0].status = 'failed'
      }
    }
  }
  if (cursor.stage) snapshot.stage = cursor.stage
  return snapshot
}
