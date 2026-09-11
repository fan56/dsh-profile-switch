/**
 * agents-dir tests — the agent-file discovery contract (frontmatter parse,
 * fail-loud broken files, sorted listing) and the registry probe's module
 * validation. The probe's dynamic-import path is exercised implicitly: in
 * this repo the registry package is absent, so probeRegistry() must resolve
 * false without throwing.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  THINKING_LEVELS,
  agentsDir,
  dshHome,
  listAgentFiles,
  parseAgentMarkdown,
} from '../lib/agents-dir.js'
import { isRegistryModule, REGISTRY_PACKAGE } from '../lib/contract.js'
import { probeRegistry } from '../lib/registry-probe.js'

// ------------------------------------------------------------------- home --

test('dshHome honors $DSH_HOME and agentsDir appends agents', () => {
  const previous = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = '/tmp/custom-home'
    assert.equal(dshHome(), '/tmp/custom-home')
    assert.equal(agentsDir(), '/tmp/custom-home/agents')
    delete process.env.DSH_HOME
    assert.equal(dshHome(), join(process.env.HOME ?? '', '.dsh'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

// ------------------------------------------------------------------- parse --

function agentText(overrides = {}) {
  const lines = ['---']
  for (const [key, value] of Object.entries({ name: 'workhorse', ...overrides })) {
    if (value !== undefined) lines.push(`${key}: ${value}`)
  }
  lines.push('---', '', 'You are the horse.')
  return lines.join('\n')
}

test('parseAgentMarkdown: happy path carries name, model, thinking and body', () => {
  const result = parseAgentMarkdown(
    agentText({ name: 'workhorse', display_name: '牛马狗', description: '"the horse"', model: 'zai/glm-5.3', thinking: 'high', deep: '2' }),
    '/agents/workhorse.md',
  )
  assert.equal(result.ok, true)
  assert.equal(result.agent.meta.name, 'workhorse')
  assert.equal(result.agent.meta.displayName, '牛马狗')
  assert.equal(result.agent.meta.description, 'the horse') // quotes stripped
  assert.equal(result.agent.meta.model, 'zai/glm-5.3')
  assert.equal(result.agent.meta.thinking, 'high')
  assert.equal(result.agent.meta.deep, 2)
  assert.equal(result.agent.body, 'You are the horse.')
})

test('parseAgentMarkdown: defaults and fail-loud breakage', () => {
  // Missing name → broken.
  assert.match(parseAgentMarkdown('---\ndisplay_name: x\n---\nbody', 'p').error ?? '', /required frontmatter key `name`/)
  // No frontmatter → broken.
  assert.match(parseAgentMarkdown('just text', 'p').error ?? '', /missing frontmatter/)
  // Invalid thinking / background / deep / maxRounds each mark the file broken.
  for (const overrides of [
    { thinking: 'extreme' },
    { background: 'ture' },
    { deep: '-1' },
    { maxRounds: '0' },
  ]) {
    const result = parseAgentMarkdown(agentText(overrides), 'p')
    assert.equal(result.ok, false, JSON.stringify(overrides))
  }
  // Valid booleans/caps pass.
  assert.equal(parseAgentMarkdown(agentText({ background: 'true', maxRounds: '60' }), 'p').ok, true)
  // deep defaults to 1.
  assert.equal(parseAgentMarkdown(agentText(), 'p').agent.meta.deep, 1)
  // The thinking whitelist is the registry's canonical order.
  assert.deepEqual([...THINKING_LEVELS], ['off', 'low', 'medium', 'high', 'max'])
})

test('listAgentFiles: sorted usable agents, broken files reported aside, missing dir tolerated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-profile-switch-agents-'))
  try {
    assert.deepEqual(listAgentFiles(join(dir, 'missing')), { agents: [], broken: [] })
    writeFileSync(join(dir, 'b-second.md'), agentText({ name: 'zeta' }))
    writeFileSync(join(dir, 'a-first.md'), agentText({ name: 'alpha' }))
    writeFileSync(join(dir, 'broken.md'), 'no frontmatter here')
    writeFileSync(join(dir, 'notes.txt'), 'not an agent')
    const { agents, broken } = listAgentFiles(dir)
    assert.deepEqual(agents.map(agent => agent.meta.name), ['alpha', 'zeta'])
    assert.equal(broken.length, 1)
    assert.match(broken[0].error, /missing frontmatter/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------- probe --

test('isRegistryModule: only the full contract members count', () => {
  const full = {
    composeAgentRuntime: () => ({}),
    readModelProfilesDoc: () => null,
    workspaceProfileName: () => null,
  }
  assert.equal(isRegistryModule(full), true)
  assert.equal(isRegistryModule({ ...full, workspaceProfileName: 'not-a-function' }), false)
  assert.equal(isRegistryModule({ composeAgentRuntime: () => ({}) }), false)
  assert.equal(isRegistryModule(null), false)
  assert.equal(isRegistryModule('registry'), false)
})

test('probeRegistry resolves false when the registry package is absent (this repo)', async () => {
  assert.equal(REGISTRY_PACKAGE, '@aiwayds/dsh-subagent-registry')
  // No @aiwayds/* dependency is installed here — the probe must degrade.
  assert.equal(await probeRegistry(), false)
})
