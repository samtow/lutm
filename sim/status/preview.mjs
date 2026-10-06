import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'

const localEnv = await readFile(new URL('.env.local', import.meta.url), 'utf8').catch(() => '')
const site = process.env.CONVEX_SITE_URL || localEnv.match(/^CONVEX_SITE_URL=(\S+)$/m)?.[1]
const files = {'/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css']}

createServer(async (request, response) => {
  if (request.method !== 'GET') { response.writeHead(405).end(); return }
  const route = new URL(request.url, 'http://localhost').pathname
  response.setHeader('Cache-Control', 'no-store')
  try {
    if (route === '/api/status') {
      if (!site) { response.writeHead(503).end('Set CONVEX_SITE_URL for local development.'); return }
      const remote = await fetch(`${site}/api/status`, {signal: AbortSignal.timeout(10000)})
      response.writeHead(remote.status, {'Content-Type': 'application/json'})
      response.end(await remote.text())
    } else if (files[route]) {
      const [filename, type] = files[route]
      response.writeHead(200, {'Content-Type': `${type}; charset=utf-8`})
      response.end(await readFile(new URL(`public/${filename}`, import.meta.url)))
    } else response.writeHead(404).end('Not found')
  } catch { response.writeHead(502).end('Cloud tracker unavailable') }
}).listen(Number(process.env.PORT || 3000), '0.0.0.0')
