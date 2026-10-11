import test from 'node:test'
import assert from 'node:assert/strict'
import {convexEnvironment, redactCredentials} from './convex-cli.mjs'

test('deployment-qualified keys retain normal Convex CLI authentication', () => {
  const env = {CONVEX_DEPLOY_KEY: 'prod:example|deployment-secret'}
  assert.deepEqual(convexEnvironment(env), env)
})

test('an unqualified account token is not mistaken for a deployment key', () => {
  const env = {CONVEX_DEPLOY_KEY: 'account-secret', OTHER: 'value'}
  assert.deepEqual(convexEnvironment(env), {
    CONVEX_OVERRIDE_ACCESS_TOKEN: 'account-secret', OTHER: 'value',
  })
  assert.equal(env.CONVEX_DEPLOY_KEY, 'account-secret')
})

test('explicit account tokens override deployment-key authentication', () => {
  assert.deepEqual(convexEnvironment({
    CONVEX_ACCESS_TOKEN: 'account-secret',
    CONVEX_DEPLOY_KEY: 'prod:example|deployment-secret',
  }), {
    CONVEX_ACCESS_TOKEN: 'account-secret',
    CONVEX_OVERRIDE_ACCESS_TOKEN: 'account-secret',
  })
})

test('missing credentials do not invent an authentication fallback', () => {
  assert.deepEqual(convexEnvironment({OTHER: 'value'}), {OTHER: 'value'})
})

test('CLI output redacts credentials but leaves public configuration visible', () => {
  const env = {DEPOT_TOKEN: 'depot-secret', CONVEX_DEPLOY_KEY: 'account-secret'}
  assert.equal(redactCredentials('depot-secret account-secret public-deployment', env),
    '[REDACTED] [REDACTED] public-deployment')
})
