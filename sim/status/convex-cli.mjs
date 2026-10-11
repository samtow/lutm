import {spawn} from 'node:child_process'
import {fileURLToPath, pathToFileURL} from 'node:url'
import path from 'node:path'

export function convexEnvironment(env = process.env) {
  const result = {...env}
  const accountToken = env.CONVEX_ACCESS_TOKEN ||
    (env.CONVEX_DEPLOY_KEY && !env.CONVEX_DEPLOY_KEY.includes('|') ? env.CONVEX_DEPLOY_KEY : null)
  if (accountToken) {
    result.CONVEX_OVERRIDE_ACCESS_TOKEN = accountToken
    delete result.CONVEX_DEPLOY_KEY
  }
  return result
}

export function redactCredentials(text, env = process.env) {
  for (const key of ['DEPOT_TOKEN', 'CONVEX_DEPLOY_KEY', 'CONVEX_ACCESS_TOKEN', 'CONVEX_OVERRIDE_ACCESS_TOKEN']) {
    if (env[key]) text = text.split(env[key]).join('[REDACTED]')
  }
  return text
}

export async function runConvex(args, {env = process.env, input} = {}) {
  const normalized = convexEnvironment(env)
  const directory = fileURLToPath(new URL('.', import.meta.url))
  const cli = fileURLToPath(new URL('node_modules/convex/bin/main.js', import.meta.url))
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: directory,
    env: normalized,
    stdio: [input === undefined ? 'inherit' : 'pipe', 'pipe', 'pipe'],
  })
  // Collect each stream before printing so even credentials split across
  // output chunks cannot be exposed.
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  if (input !== undefined) {
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  }
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)))
  })
  process.stdout.write(redactCredentials(stdout, normalized))
  process.stderr.write(redactCredentials(stderr, normalized))
  return code
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.exitCode = await runConvex(process.argv.slice(2))
  } catch {
    console.error('Unable to run the Convex CLI.')
    process.exitCode = 1
  }
}
