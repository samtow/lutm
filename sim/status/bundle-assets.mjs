import {readFile, writeFile} from 'node:fs/promises'

const files = {'/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8']}
const assets = {}
for (const [route, [filename, type]] of Object.entries(files)) {
  assets[route] = {body: await readFile(new URL(`public/${filename}`, import.meta.url), 'utf8'), type}
}
const collector = await readFile(new URL('collect.py', import.meta.url), 'utf8')
await writeFile(new URL('convex/bundled.js', import.meta.url), `export const assets = ${JSON.stringify(assets)}\nexport const collector = ${JSON.stringify(collector)}\n`)
