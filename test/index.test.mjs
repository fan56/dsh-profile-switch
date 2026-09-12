/**
 * index.ts tests — the apply() idempotence guard.
 *
 * Contract: dsh-tui-pi's bundle patch mounts this plugin itself, and a
 * profile may ALSO list it in bundles — two tree entries, one plugin. The
 * second apply MUST NOT register the commands again (the host rejects a
 * duplicate `profile-switch` command and tears down the boot). The guard
 * claims a root-scope marker synchronously at apply entry, so parallel
 * loader fibers cannot interleave between the check and the claim.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, name, MOUNTED_KEY } from '../lib/index.js'

/** A minimal fake cordis root/plugin context pair. */
function fakeContext() {
  const rootValues = new Map()
  const root = {
    provide: (key, value) => rootValues.set(key, value),
    get: key => rootValues.get(key),
  }
  const effects = []
  const registered = []
  const ctx = {
    root,
    effect: fn => effects.push(fn),
    commands: { register: definition => registered.push(definition.name) },
  }
  return { ctx, rootValues, effects, registered }
}

test('plugin identity exports stay stable', async () => {
  assert.equal(name, 'dsh-profile-switch')
  const mod = await import('../lib/index.js')
  assert.deepEqual([...mod.inject], ['commands', 'userQuestions'])
})

test('first apply registers both commands and claims the root marker', async () => {
  const { ctx, rootValues, effects, registered } = fakeContext()
  apply(ctx)
  // Effects run on settle — flush them like the loader would.
  for (const effect of effects) await effect()
  assert.deepEqual(registered.sort(), ['profile-cfg', 'profile-switch'])
  assert.equal(rootValues.get(MOUNTED_KEY), true)
})

test('second apply on the same tree is a no-op (the tui-pi auto-mount + bundles shape)', () => {
  const first = fakeContext()
  apply(first.ctx)
  const second = fakeContext()
  // Both plugin instances share the same app root.
  Object.assign(second.ctx, { root: first.ctx.root })
  const before = second.registered.length
  apply(second.ctx)
  assert.equal(second.registered.length, before, 'no commands registered by the second mount')
  assert.equal(second.effects.length, 0, 'no effects scheduled by the second mount')
})

test('the guard check and claim happen before any registration', () => {
  const { ctx, rootValues, effects } = fakeContext()
  apply(ctx)
  // The marker is already claimed even though effects have not settled.
  assert.equal(rootValues.get(MOUNTED_KEY), true)
  assert.equal(effects.length, 2, 'both command effects scheduled')
})
