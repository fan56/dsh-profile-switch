/**
 * Flow tests (src/flows.ts) — the ask-user wizards behind /profile-switch
 * and /profile-cfg, exercised against a fully faked host.
 *
 * Contracts under test:
 * - Switch applies in layers: live route through the injected channel, tree
 *   binding via the REAL pin functions on a temp cwd, store save — and
 *   NEVER an agent-file write (the values compose at spawn, read side).
 * - Decline / cancel mid-wizard saves nothing; NO_PROVIDER becomes the
 *   guidance text; a skipped pick means "leave unset".
 * - The config wizard's operations persist exactly once, at the end; the
 *   per-agent section only appears when the registry is detected, and an
 *   inherit-both answer records the explicit-inherit empty entry.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  bindWorkspaceProfile,
  findProfile,
  PROFILE_PIN_FILE,
  removeProfilePin,
  seedModelProfilesDoc,
} from '../lib/model-profiles.js'
import {
  DECLINE_MESSAGE,
  INHERIT_LABEL,
  NO_ROUTE_LABEL,
  NO_SURFACE_GUIDANCE,
  PROVIDER_DEFAULT_EFFORT_LABEL,
  UNBIND_LABEL,
  runProfileConfig,
  runProfileSwitch,
} from '../lib/flows.js'

// ------------------------------------------------------------------ harness --

/** One queued ask-user answer. */
function answered(picks) {
  return {
    answers: Object.entries(picks).map(([id, value]) => ({
      id,
      ...(Array.isArray(value) ? { selected: value } : { selected: [], custom: value }),
    })),
  }
}

/** The canonical whole-request decline envelope for the given questions. */
function declined(questions) {
  return {
    answers: questions.map(question => ({ id: question.id, selected: [], custom: DECLINE_MESSAGE })),
  }
}

/**
 * Fake host services. `answers` is a queue consumed by askUser — each entry
 * is either an envelope factory (receiving the asked questions) or a static
 * envelope. The pin functions are the REAL implementations against a temp
 * cwd; the store is a plain in-memory doc with a save log.
 */
function fakeServices(answers, overrides = {}, stateOverrides = {}) {
  const doc = seedModelProfilesDoc()
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-profile-switch-flow-'))
  const state = {
    doc,
    saved: [],
    liveApplied: [],
    unbound: [],
    registry: false,
    agents: [],
    currentRoute: undefined,
    liveChannel: true,
    tmp,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
    ...stateOverrides,
  }

  let cursor = 0
  const svc = {
    askUser: async request => {
      const next = answers[cursor++]
      if (next === undefined) {
        throw new Error(`unexpected ask: ${JSON.stringify(request.questions.map(q => q.id))}`)
      }
      return typeof next === 'function' ? next(request.questions) : next
    },
    loadDoc: () => state.doc,
    saveDoc: incoming => {
      state.saved.push(JSON.parse(JSON.stringify(incoming)))
      return undefined
    },
    cwd: () => tmp,
    bindTree: profileName => bindWorkspaceProfile(tmp, profileName),
    unbindTree: boundName => {
      state.unbound.push(boundName)
      return removeProfilePin(tmp, boundName)
    },
    providers: () => [
      { id: 'zai', name: 'Z.ai' },
      { id: 'volc', name: 'Volc Ark' },
    ],
    models: async provider => provider === 'zai'
      ? [{ id: 'glm-5.3', name: 'GLM 5.3' }, { id: 'glm-4.5' }]
      : [{ id: 'deepseek-v4' }],
    efforts: async (provider, model) => provider === 'zai' && model === 'glm-5.3'
      ? [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }]
      : undefined,
    currentRoute: () => state.currentRoute,
    applyLive: route => {
      state.liveApplied.push({ ...route })
      if (!state.liveChannel) return { live: false, note: 'no live-selection channel on this surface' }
      return { live: true }
    },
    registryDetected: async () => state.registry,
    listAgents: () => state.agents,
    ...overrides,
  }
  return { svc, state, cleanup: () => state.cleanup() }
}

/** A work profile carrying a default route, so switch tests have a target. */
function withWorkProfile(state) {
  const profile = findProfile(state.doc, 'work')
  profile.defaultModel = { provider: 'zai', model: 'glm-5.3', reasoningEffort: 'high' }
  return profile
}

// ------------------------------------------------------------ /profile-switch --

test('switch: live route + tree pin + store save, and no agent file is ever written', async () => {
  const { svc, state, cleanup } = fakeServices([answered({ profile: 'work' })])
  try {
    withWorkProfile(state)
    const summary = (await runProfileSwitch(svc)).text

    assert.deepEqual(state.liveApplied, [{ provider: 'zai', model: 'glm-5.3', reasoningEffort: 'high' }])
    assert.ok(existsSync(join(state.tmp, PROFILE_PIN_FILE)), 'the tree pin is written by the REAL binder')
    assert.equal(readFileSync(join(state.tmp, PROFILE_PIN_FILE), 'utf8').trim(), 'work')
    assert.equal(state.saved.at(-1)?.current, 'work')
    assert.ok(summary.includes('Profile → work'), summary)
    assert.ok(summary.includes('pinned this tree'), summary)
    assert.ok(summary.includes('per-workspace'), summary)
  } finally {
    cleanup()
  }
})

test('switch: without a live channel the route degrades to "next session" and says so', async () => {
  const { svc, state, cleanup } = fakeServices([answered({ profile: 'work' })], {}, { liveChannel: false })
  try {
    withWorkProfile(state)
    const summary = (await runProfileSwitch(svc)).text
    assert.equal(state.liveApplied.length, 1) // attempted, reported as not live
    assert.ok(summary.includes('next session:'), summary)
    assert.ok(summary.includes('no live-selection channel'), summary)
    // The pin and the store save still happen.
    assert.ok(existsSync(join(state.tmp, PROFILE_PIN_FILE)))
    assert.equal(state.saved.length, 1)
  } finally {
    cleanup()
  }
})

test('switch: a profile without a default model leaves the live channel alone', async () => {
  const { svc, state, cleanup } = fakeServices([answered({ profile: 'personal' })])
  try {
    const summary = (await runProfileSwitch(svc)).text
    assert.deepEqual(state.liveApplied, [])
    assert.ok(summary.includes('model unchanged'), summary)
    assert.ok(summary.includes('pinned this tree'), summary)
  } finally {
    cleanup()
  }
})

test('switch: decline cancels the wizard and saves nothing', async () => {
  const { svc, state, cleanup } = fakeServices([questions => declined(questions)])
  try {
    withWorkProfile(state)
    const result = await runProfileSwitch(svc)
    assert.equal(result.kind, 'success')
    assert.match(result.text, /Cancelled — nothing was saved\./)
    assert.deepEqual(state.liveApplied, [])
    assert.equal(state.saved.length, 0)
    assert.ok(!existsSync(join(state.tmp, PROFILE_PIN_FILE)), 'no pin written')
  } finally {
    cleanup()
  }
})

test('switch: NO_PROVIDER becomes the non-interactive guidance, not a crash', async () => {
  const { svc, state, cleanup } = fakeServices([], {
    askUser: async () => {
      throw Object.assign(new Error('no user-questions answerer accepted the request'), { code: 'NO_PROVIDER' })
    },
  })
  try {
    const result = await runProfileSwitch(svc)
    assert.equal(result.kind, 'error')
    assert.equal(result.text, NO_SURFACE_GUIDANCE)
    assert.equal(state.saved.length, 0)
  } finally {
    cleanup()
  }
})

test('switch: unbind removes the tree binding through the guarded remover', async () => {
  const { svc, state, cleanup } = fakeServices([answered({ profile: UNBIND_LABEL })])
  try {
    withWorkProfile(state)
    writeFileSync(join(state.tmp, PROFILE_PIN_FILE), 'work\n')
    const summary = (await runProfileSwitch(svc)).text
    assert.deepEqual(state.unbound, ['work'])
    assert.ok(summary.includes('Unbound this tree'), summary)
    assert.ok(!existsSync(join(state.tmp, PROFILE_PIN_FILE)), 'the pin is gone')
  } finally {
    cleanup()
  }
})

test('switch: a pick the store no longer knows is an error, not a crash', async () => {
  const { svc, state, cleanup } = fakeServices([answered({ profile: 'ghost' })])
  try {
    const result = await runProfileSwitch(svc)
    assert.equal(result.kind, 'error')
    assert.match(result.text, /no profile named "ghost"/)
  } finally {
    cleanup()
  }
})

// -------------------------------------------------------------- /profile-cfg --

test('cfg new: name → default-model chain → store, registry absent skips the agent section', async () => {
  const { svc, state, cleanup } = fakeServices([
    answered({ op: 'new' }),
    answered({ name: 'lab' }),
    answered({ provider: 'zai' }),
    answered({ model: 'glm-5.3' }),
    answered({ effort: 'high' }),
  ])
  try {
    const result = await runProfileConfig(svc)
    assert.equal(result.kind, 'success')
    assert.match(result.text, /Profile "lab" created/)
    assert.match(result.text, /zai\/glm-5\.3 · think high/)
    assert.match(result.text, /not detected/)
    const saved = state.saved.at(-1)
    const lab = saved.profiles.find(profile => profile.name === 'lab')
    assert.deepEqual(lab.defaultModel, { provider: 'zai', model: 'glm-5.3', reasoningEffort: 'high' })
    assert.deepEqual(lab.agents, {})
  } finally {
    cleanup()
  }
})

test('cfg new: the "(no default model)" option leaves the route unset', async () => {
  const { svc, state, cleanup } = fakeServices([
    answered({ op: 'new' }),
    answered({ name: 'lab' }),
    answered({ provider: NO_ROUTE_LABEL }),
  ])
  try {
    const result = await runProfileConfig(svc)
    assert.match(result.text, /\(not set\)/)
    const lab = state.saved.at(-1).profiles.find(profile => profile.name === 'lab')
    assert.equal(lab.defaultModel, undefined)
  } finally {
    cleanup()
  }
})

test('cfg new with registry: multi-select agents then the inherit-first chain', async () => {
  const { svc, state, cleanup } = fakeServices([
    answered({ op: 'new' }),
    answered({ name: 'lab' }),
    answered({ provider: 'zai' }),
    answered({ model: 'glm-5.3' }),
    answered({ effort: 'low' }),
    answered({ agents: ['workhorse', 'oldfox'] }),
    // workhorse: provider zai → model glm-5.3 → effort high (a full override)
    answered({ provider: 'zai' }),
    answered({ model: 'glm-5.3' }),
    answered({ effort: 'high' }),
    // oldfox: inherit the model, override only the thinking
    answered({ provider: INHERIT_LABEL }),
    answered({ effort: 'max' }),
  ], {}, { registry: true, agents: [{ name: 'workhorse', description: 'the horse' }, { name: 'oldfox' }] })
  try {
    const result = await runProfileConfig(svc)
    assert.equal(result.kind, 'success')
    assert.match(result.text, /2 agent overrides/)
    const lab = state.saved.at(-1).profiles.find(profile => profile.name === 'lab')
    assert.deepEqual(lab.agents, {
      workhorse: { model: 'zai/glm-5.3', thinking: 'high' },
      oldfox: { thinking: 'max' },
    })
  } finally {
    cleanup()
  }
})

test('cfg new with registry: inherit on both steps records the explicit-inherit empty entry', async () => {
  const { svc, state, cleanup } = fakeServices([
    answered({ op: 'new' }),
    answered({ name: 'lab' }),
    answered({ provider: NO_ROUTE_LABEL }),
    answered({ agents: ['workhorse'] }),
    answered({ provider: INHERIT_LABEL }),
    answered({ effort: INHERIT_LABEL }),
  ], {}, { registry: true, agents: [{ name: 'workhorse' }] })
  try {
    await runProfileConfig(svc)
    const lab = state.saved.at(-1).profiles.find(profile => profile.name === 'lab')
    assert.deepEqual(lab.agents, { workhorse: {} })
  } finally {
    cleanup()
  }
})

test('cfg: a mid-wizard decline persists nothing', async () => {
  const { svc, state, cleanup } = fakeServices([
    answered({ op: 'new' }),
    answered({ name: 'lab' }),
    questions => declined(questions), // decline inside the provider step
  ])
  try {
    const result = await runProfileConfig(svc)
    assert.match(result.text, /Cancelled — nothing was saved\./)
    assert.equal(state.saved.length, 0)
  } finally {
    cleanup()
  }
})

test('cfg edit: re-answers both halves and can clear the route', async () => {
  const { svc, state, cleanup } = fakeServices([
    answered({ op: 'edit' }),
    answered({ profile: 'work' }),
    answered({ provider: NO_ROUTE_LABEL }),
  ], {}, { registry: true, agents: [] })
  try {
    withWorkProfile(state)
    findProfile(state.doc, 'work').agents = { workhorse: { model: 'zai/glm-5.3' } }
    const result = await runProfileConfig(svc)
    assert.equal(result.kind, 'success')
    assert.match(result.text, /Profile "work" updated/)
    const work = state.saved.at(-1).profiles.find(profile => profile.name === 'work')
    assert.equal(work.defaultModel, undefined)
    // Unselected agents' existing entries are kept.
    assert.deepEqual(work.agents, { workhorse: { model: 'zai/glm-5.3' } })
  } finally {
    cleanup()
  }
})

test('cfg save-current: captures the current route and optionally the agent baselines', async () => {
  const { svc, state, cleanup } = fakeServices([
    answered({ op: 'save-current' }),
    answered({ name: 'snapshot-of-now' }),
    answered({ include: 'snapshot' }),
  ], {}, {
    currentRoute: { provider: 'volc', model: 'deepseek-v4' },
    agents: [
      { name: 'workhorse', model: 'zai/glm-5.3', thinking: 'high' },
      { name: 'duck' },
    ],
  })
  try {
    const result = await runProfileConfig(svc)
    assert.match(result.text, /saved from the current configuration/)
    assert.match(result.text, /volc\/deepseek-v4/)
    const saved = state.saved.at(-1).profiles.find(profile => profile.name === 'snapshot-of-now')
    assert.deepEqual(saved.defaultModel, { provider: 'volc', model: 'deepseek-v4' })
    assert.deepEqual(saved.agents, {
      workhorse: { model: 'zai/glm-5.3', thinking: 'high' },
      duck: {},
    })
  } finally {
    cleanup()
  }
})

test('cfg rename: renames, keeps current consistent, refuses collisions', async () => {
  const { svc, state, cleanup } = fakeServices([
    answered({ op: 'rename' }),
    answered({ profile: 'work' }),
    answered({ name: 'job' }),
  ])
  try {
    state.doc.current = 'work'
    const result = await runProfileConfig(svc)
    assert.match(result.text, /renamed to "job"/)
    assert.equal(state.saved.at(-1).current, 'job')

    const colliding = fakeServices([
      answered({ op: 'rename' }),
      answered({ profile: 'work' }),
      answered({ name: 'personal' }),
    ])
    try {
      const failed = await runProfileConfig(colliding.svc)
      assert.equal(failed.kind, 'error')
      assert.match(failed.text, /already exists/)
    } finally {
      colliding.state.cleanup()
    }
  } finally {
    cleanup()
  }
})

test('cfg delete: confirms first, refuses the last profile', async () => {
  const { svc, state, cleanup } = fakeServices([
    answered({ op: 'delete' }),
    answered({ profile: 'personal' }),
    answered({ confirm: 'delete' }),
  ])
  try {
    const result = await runProfileConfig(svc)
    assert.match(result.text, /deleted/)
    assert.equal(state.saved.at(-1).profiles.length, 2)

    const last = seedModelProfilesDoc()
    const lone = fakeServices([
      answered({ op: 'delete' }),
      answered({ profile: 'work' }),
      answered({ confirm: 'delete' }),
    ])
    lone.state.doc.profiles = last.profiles.slice(0, 1)
    try {
      const refused = await runProfileConfig(lone.svc)
      assert.equal(refused.kind, 'error')
      assert.match(refused.text, /last profile/)
    } finally {
      lone.state.cleanup()
    }
  } finally {
    cleanup()
  }
})

test('cfg delete: answering anything but "delete" keeps everything', async () => {
  const { svc, state, cleanup } = fakeServices([
    answered({ op: 'delete' }),
    answered({ profile: 'personal' }),
    answered({ confirm: 'keep' }),
  ])
  try {
    const result = await runProfileConfig(svc)
    assert.match(result.text, /Profiles unchanged\./)
    assert.equal(state.saved.length, 0)
  } finally {
    cleanup()
  }
})

test('cfg new: a taken name is an error before any question is wasted', async () => {
  const { svc, state, cleanup } = fakeServices([
    answered({ op: 'new' }),
    answered({ name: 'PERSONAL' }),
  ])
  try {
    const result = await runProfileConfig(svc)
    assert.equal(result.kind, 'error')
    assert.match(result.text, /already exists/)
    assert.equal(state.saved.length, 0)
  } finally {
    cleanup()
  }
})

test('cfg: a provider that lists no models falls back to a free-text model id', async () => {
  const { svc, state, cleanup } = fakeServices([
    answered({ op: 'new' }),
    answered({ name: 'lab' }),
    answered({ provider: 'volc' }),
    answered({ model: 'deepseek-v4-custom' }),
    answered({ effort: PROVIDER_DEFAULT_EFFORT_LABEL }),
  ])
  try {
    // volc normally lists one model, so stub it to list none.
    svc.models = async () => []
    const result = await runProfileConfig(svc)
    assert.equal(result.kind, 'success')
    const lab = state.saved.at(-1).profiles.find(profile => profile.name === 'lab')
    assert.deepEqual(lab.defaultModel, { provider: 'volc', model: 'deepseek-v4-custom' })
  } finally {
    cleanup()
  }
})
