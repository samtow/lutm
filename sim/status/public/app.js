const $ = selector => document.querySelector(selector)
let current

function render(data) {
  current = data
  $('#stage').textContent = data.stage
  $('#product').textContent = `${data.product === 'virtio_x86_64' ? 'X86_64' : 'ARM64'} RELEASE · TWO PARTITION LAYOUTS`
  document.body.classList.toggle('failed', data.status === 'failed')
  $('#cores').textContent = data.resources?.vcpus ?? '—'
  $('#memory').textContent = data.resources?.memoryMb ? Math.round(data.resources.memoryMb / 1024) : '—'
  $('#layouts').replaceChildren()
  for (const layout of data.layouts) {
    const card = document.createElement('article')
    card.className = `card${layout.status === 'building' ? ' active' : ''}`
    card.dataset.layout = layout.id
    card.innerHTML = `<div class="card-head"><div><h2>${layout.id === 'ab' ? 'A/B' : 'Non-A/B'}</h2><p>${layout.id === 'ab' ? 'Slotted updates · recovery in vendor_boot' : 'Upstream-compatible · standalone recovery'}</p></div><span class="badge"></span></div><div class="progress-label"><span class="phase"></span><strong></strong></div><div class="bar" role="progressbar"><span></span></div><div class="steps"></div><div class="downloads"></div>`
    card.querySelector('.badge').textContent = layout.status.toUpperCase()
    card.querySelector('.badge').classList.add(layout.status)
    const progress = layout.progress
    const phases = {
      queued: 'Waiting for its build turn', building: 'Waiting for build progress',
      checking: 'Build complete · release checks in progress', complete: 'Verified files are ready',
      built: 'Images built · upload not started', failed: 'Build or release checks failed',
      stopped: 'Builder stopped · last known progress', blocked: 'Not started · builder setup failed',
    }
    card.querySelector('.phase').textContent = ['failed', 'stopped', 'blocked'].includes(layout.status)
      ? phases[layout.status] : progress ? `${progress.done.toLocaleString()} / ${progress.total.toLocaleString()} build actions` : phases[layout.status] || 'Waiting for a build sample'
    const percent = progress ? Math.max(0, Math.min(100, progress.percent)) : ['complete', 'checking', 'built'].includes(layout.status) ? 100 : 0
    card.querySelector('strong').textContent = progress || percent ? `${percent}%` : '—'
    const bar = card.querySelector('.bar')
    bar.setAttribute('aria-label', `${layout.id} build actions`)
    bar.setAttribute('aria-valuenow', percent)
    bar.setAttribute('aria-valuemin', 0)
    bar.setAttribute('aria-valuemax', 100)
    bar.firstElementChild.style.width = `${percent}%`
    for (const step of layout.steps) {
      const element = document.createElement('span')
      element.className = `step ${step.status}`
      const icon = document.createElement('i')
      icon.textContent = step.status === 'passed' ? '✓' : step.status === 'failed' ? '!' : '·'
      element.append(icon, document.createTextNode(step.label))
      card.querySelector('.steps').append(element)
    }
    for (const file of layout.downloads) {
      if (!/^https:\/\/gofile\.io\/d\/[A-Za-z0-9-]+$/.test(file.url)) continue
      const link = document.createElement('a')
      link.href = file.url
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      link.textContent = `↓ ${file.name}`
      card.querySelector('.downloads').append(link)
    }
    $('#layouts').append(card)
  }
  $('#recent').textContent = data.recent.length ? data.recent.join('\n') : 'No compiler progress has been sampled yet. Detailed logs stay private in Depot.'
  $('#failure').hidden = !data.failure
  $('#failure').textContent = data.failure || ''
  updateTimes()
}

function updateTimes() {
  if (!current) return
  const sampled = Date.parse(current.checkedAt || current.sampledAt)
  const fresh = Number.isFinite(sampled) && Date.now() - sampled < 150000
  const live = current.connection === 'live' && fresh
  const labels = {complete: 'COMPLETE', built: 'BUILT', failed: 'FAILED', stopped: 'STOPPED', preparing: 'PREPARING'}
  $('#connection').textContent = current.connection === 'unconfigured' ? 'SETUP REQUIRED' : live ? labels[current.status] || 'LIVE' : current.connection === 'live' ? 'STALE' : 'RECONNECTING'
  $('#connection').className = `pill${live ? ' live' : ''}`
  $('#warning').hidden = live
  $('#warning').textContent = current.error || 'Waiting for a fresh cloud sample. Scheduled polling will retry automatically.'
  const end = current.finishedAt ? Date.parse(current.finishedAt) : Date.now()
  const elapsed = current.createdAt ? Math.max(0, Math.floor((end - Date.parse(current.createdAt)) / 60000)) : 0
  $('#elapsed').textContent = current.createdAt ? `${Math.floor(elapsed / 60)}h ${elapsed % 60}m` : '—'
  const age = current.sampledAt ? Math.max(0, Math.floor((Date.now() - Date.parse(current.sampledAt)) / 1000)) : null
  $('#updated').textContent = age === null ? '—' : age < 5 ? 'just now' : `${age}s ago`
}

async function poll() {
  try {
    const response = await fetch('/api/status', {cache: 'no-store'})
    if (!response.ok) throw new Error()
    render(await response.json())
  } catch {
    if (current) current = {...current, connection: 'unavailable', error: 'The page could not refresh. Retrying automatically; displayed progress may be stale.'}
    $('#connection').textContent = 'RECONNECTING'
    $('#connection').className = 'pill'
    $('#warning').hidden = false
    $('#warning').textContent = 'The page could not refresh. Retrying automatically; displayed progress may be stale.'
  }
}
poll()
setInterval(poll, 15000)
setInterval(updateTimes, 1000)
