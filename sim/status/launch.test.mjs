import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {fileURLToPath} from 'node:url'
import {launch} from './launch.mjs'

const bootstrapPath = fileURLToPath(new URL('./depot-build.sh', import.meta.url))

async function temporaryDirectory() {
  return mkdtemp(path.join(tmpdir(), 'lutm-depot-launch-'))
}

test('missing Depot credentials fail before archiving or allocating', async (t) => {
  const directory = await temporaryDirectory()
  t.after(() => rm(directory, {recursive: true, force: true}))
  let archiveCalls = 0
  let clientCalls = 0
  let allocationCalls = 0

  await assert.rejects(launch({
    env: {DEPOT_TOKEN_FILE: path.join(directory, 'missing-token')},
    sdk: {
      createClient() { clientCalls += 1 },
      Sandbox: {async create() { allocationCalls += 1 }},
    },
    readSource() { archiveCalls += 1 },
  }), /Depot credentials missing/)

  assert.equal(clientCalls, 0)
  assert.equal(archiveCalls, 0)
  assert.equal(allocationCalls, 0)
})

test('launch dispatches a detached build and persists only private non-secret state', async (t) => {
  const directory = await temporaryDirectory()
  t.after(() => rm(directory, {recursive: true, force: true}))
  const stateFile = path.join(directory, 'runtime', 'builder.json')
  const archive = Buffer.from('tracked sim archive')
  const commit = 'a'.repeat(40)
  const writes = []
  const output = []
  let clientOptions
  let createOptions
  let commandOptions
  const sandbox = {
    sandboxId: 'sandbox-test-123',
    fs() {
      return {async writeFile(file, data, options) { writes.push({file, data, options}) }}
    },
    async runCommand(options) { commandOptions = options },
    async stop() { throw new Error('not expected') },
  }

  const result = await launch({
    env: {
      DEPOT_TOKEN: 'local-test-token',
      DEPOT_ORG_ID: 'test-org',
      DEPOT_BUILD_VCPUS: '48',
      DEPOT_BUILD_MEMORY_MB: '196608',
      DEPOT_BUILD_DISK_GB: '1200',
      BUILD_STATUS_BUILDER_FILE: stateFile,
    },
    sdk: {
      createClient(options) { clientOptions = options; return {client: true} },
      Sandbox: {
        async create(_client, options) { createOptions = options; return sandbox },
      },
    },
    readSource: async () => ({commit, archive}),
    output: (line) => output.push(line),
  })

  assert.deepEqual(clientOptions, {token: 'local-test-token', orgID: 'test-org'})
  assert.deepEqual(createOptions.resources, {vcpus: 48, memoryMb: 196608, diskGb: 1200})
  assert.deepEqual(createOptions.runtime, {imageRef: 'ubuntu:24.04'})
  assert.deepEqual(createOptions.env, {HOME: '/home/runner'})
  assert.equal(createOptions.timeoutMinutes, 360)
  assert.equal(createOptions.disableTailnet, true)
  assert.equal(commandOptions.cmd, '/bin/bash')
  assert.equal(commandOptions.detached, true)
  assert.deepEqual(commandOptions.args, ['/tmp/depot-build.sh', '/home/runner', 'virtio_arm64only', commit, '/tmp/lutm-sim.tar'])
  assert.equal('env' in commandOptions, false)
  assert.deepEqual(writes.map(({file}) => file), ['/tmp/lutm-sim.tar', '/tmp/depot-build.sh'])
  assert.deepEqual(writes[0].data, archive)
  assert.deepEqual(writes[1].data, await readFile(bootstrapPath))
  assert.equal(writes[1].options.mode, 0o700)

  const state = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.deepEqual(state, {
    sandboxId: 'sandbox-test-123',
    root: '/home/runner',
    product: 'virtio_arm64only',
    commit,
  })
  assert.equal((await stat(path.dirname(stateFile))).mode & 0o777, 0o700)
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600)
  assert.deepEqual(result, state)
  assert.deepEqual(output, ['DEPOT_SANDBOX_ID=sandbox-test-123'])
  assert.doesNotMatch(JSON.stringify([createOptions, commandOptions, writes, state, output]), /local-test-token/)
})

test('failed dispatch attempts to stop the new builder and hides provider errors', async (t) => {
  const directory = await temporaryDirectory()
  t.after(() => rm(directory, {recursive: true, force: true}))
  const stateFile = path.join(directory, 'runtime', 'builder.json')
  let stopCalls = 0
  const sandbox = {
    sandboxId: 'sandbox-dispatch-failure',
    fs() { return {async writeFile() {}} },
    async runCommand() { throw new Error('private token and provider response') },
    async stop() { stopCalls += 1 },
  }

  await assert.rejects(launch({
    env: {DEPOT_TOKEN: 'local-test-token', BUILD_STATUS_BUILDER_FILE: stateFile},
    sdk: {
      createClient() { return {} },
      Sandbox: {async create() { return sandbox }},
    },
    readSource: async () => ({commit: 'b'.repeat(40), archive: Buffer.from('archive')}),
    output() { assert.fail('failed launch must not print a sandbox ID') },
  }), (error) => {
    assert.match(error.message, /stop was attempted/)
    assert.doesNotMatch(error.message, /private token|provider response/)
    return true
  })

  assert.equal(stopCalls, 1)
  await assert.rejects(stat(stateFile), {code: 'ENOENT'})
})

test('build root and product overrides are forwarded consistently', async (t) => {
  const directory = await temporaryDirectory()
  t.after(() => rm(directory, {recursive: true, force: true}))
  const stateFile = path.join(directory, 'runtime', 'builder.json')
  const root = '/mnt/lutm build'
  const product = 'virtio_x86_64'
  let createOptions
  let commandOptions
  const sandbox = {
    sandboxId: 'sandbox-config-override',
    fs() { return {async writeFile() {}} },
    async runCommand(options) { commandOptions = options },
  }

  await launch({
    env: {
      DEPOT_TOKEN: 'local-test-token',
      DEPOT_BUILD_ROOT: root,
      DEPOT_BUILD_PRODUCT: product,
      BUILD_STATUS_BUILDER_FILE: stateFile,
    },
    sdk: {
      createClient() { return {} },
      Sandbox: {async create(_client, options) { createOptions = options; return sandbox }},
    },
    readSource: async () => ({commit: 'c'.repeat(40), archive: Buffer.from('archive')}),
    output() {},
  })

  assert.deepEqual(createOptions.env, {HOME: root})
  assert.deepEqual(commandOptions.args, ['/tmp/depot-build.sh', root, product, 'c'.repeat(40), '/tmp/lutm-sim.tar'])
  assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')), {
    sandboxId: 'sandbox-config-override',
    root,
    product,
    commit: 'c'.repeat(40),
  })
})
