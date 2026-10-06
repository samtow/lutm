import {createClient, Sandbox} from '@depot/sandbox'
import {execFileSync} from 'node:child_process'
import {chmod, mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const bootstrapPath = fileURLToPath(new URL('./depot-build.sh', import.meta.url))
const defaultStateFile = path.join(repositoryRoot, '.hoplite/runtime/depot-arm64-dual/builder.json')
const defaultBuildRoot = '/home/runner'
const buildTimeoutMinutes = 360
const archivePath = '/tmp/lutm-sim.tar'
const remoteBootstrapPath = '/tmp/depot-build.sh'
const defaultResources = {vcpus: 32, memoryMb: 131072, diskGb: 1000}

async function readToken(env) {
  const token = env.DEPOT_TOKEN?.trim()
  if (token) return token

  const tokenFile = env.DEPOT_TOKEN_FILE || path.join(homedir(), '.config/hoplite-depot/token')
  try {
    const fileToken = (await readFile(tokenFile, 'utf8')).trim()
    if (fileToken) return fileToken
  } catch {}
  throw new Error('Depot credentials missing: set DEPOT_TOKEN or provide a readable DEPOT_TOKEN_FILE (default ~/.config/hoplite-depot/token).')
}

function positiveInteger(env, name, fallback) {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} must be a positive integer.`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`)
  return value
}

function buildConfiguration(env) {
  const product = env.DEPOT_BUILD_PRODUCT?.trim() || 'virtio_arm64only'
  if (!['virtio_arm64only', 'virtio_x86_64'].includes(product)) {
    throw new Error('DEPOT_BUILD_PRODUCT must be virtio_arm64only or virtio_x86_64.')
  }
  const root = env.DEPOT_BUILD_ROOT?.trim() || defaultBuildRoot
  if (!path.posix.isAbsolute(root) || root === '/' || /[\r\n]/.test(root)) {
    throw new Error('DEPOT_BUILD_ROOT must be an absolute non-root directory path.')
  }
  return {
    product,
    root,
    resources: {
      vcpus: positiveInteger(env, 'DEPOT_BUILD_VCPUS', defaultResources.vcpus),
      memoryMb: positiveInteger(env, 'DEPOT_BUILD_MEMORY_MB', defaultResources.memoryMb),
      diskGb: positiveInteger(env, 'DEPOT_BUILD_DISK_GB', defaultResources.diskGb),
    },
  }
}

function archiveTrackedSim(root) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim()
  const archive = execFileSync('git', ['archive', '--format=tar', commit, 'sim'], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (!commit || !archive.length) throw new Error('empty tracked source archive')
  return {commit, archive}
}

async function persistBuilderState(filename, state) {
  const directory = path.dirname(filename)
  const temporaryFile = `${filename}.${process.pid}.${randomUUID()}.tmp`
  await mkdir(directory, {recursive: true, mode: 0o700})
  await chmod(directory, 0o700)
  try {
    await writeFile(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, {mode: 0o600})
    await chmod(temporaryFile, 0o600)
    await rename(temporaryFile, filename)
    await chmod(filename, 0o600)
  } finally {
    await rm(temporaryFile, {force: true}).catch(() => {})
  }
}

export async function launch({
  env = process.env,
  sdk = {createClient, Sandbox},
  sourceRoot = repositoryRoot,
  readSource = archiveTrackedSim,
  stateFile = env.BUILD_STATUS_BUILDER_FILE || defaultStateFile,
  output = (line) => console.log(line),
} = {}) {
  const token = await readToken(env)
  const config = buildConfiguration(env)
  const orgID = env.DEPOT_ORG_ID?.trim()

  let client
  try {
    client = await sdk.createClient({token, ...(orgID ? {orgID} : {})})
  } catch {
    throw new Error('Unable to initialize the Depot client; check the token and organization configuration.')
  }

  let source
  let bootstrap
  try {
    source = await readSource(sourceRoot)
    bootstrap = await readFile(bootstrapPath)
  } catch {
    throw new Error('Unable to prepare the tracked sim/ source at local HEAD; no builder was allocated.')
  }

  const resolvedStateFile = path.resolve(stateFile)
  let sandbox
  try {
    sandbox = await sdk.Sandbox.create(client, {
      resources: config.resources,
      env: {HOME: config.root},
      timeoutMinutes: buildTimeoutMinutes,
      disableTailnet: true,
    })

    const remoteFs = sandbox.fs()
    await remoteFs.writeFile(archivePath, source.archive, {mode: 0o600})
    await remoteFs.writeFile(remoteBootstrapPath, bootstrap, {mode: 0o700})
    await sandbox.runCommand({
      cmd: '/bin/bash',
      args: [remoteBootstrapPath, config.root, config.product, source.commit, archivePath],
      sudo: true,
      detached: true,
    })

    const state = {
      sandboxId: sandbox.sandboxId,
      root: config.root,
      product: config.product,
      commit: source.commit,
    }
    await persistBuilderState(resolvedStateFile, state)
    output(`DEPOT_SANDBOX_ID=${sandbox.sandboxId}`)
    return state
  } catch {
    if (sandbox) {
      try { await sandbox.stop() } catch {}
    }
    throw new Error(sandbox
      ? 'Depot builder setup or dispatch failed after creation; a stop was attempted to avoid idle charges.'
      : 'Depot could not create the build sandbox; check token access, organization access, and requested resources.')
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    await launch()
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Depot launch failed.')
    process.exitCode = 1
  }
}
