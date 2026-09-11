#!/usr/bin/env node
// Triple-contract check: dsh-profile-switch (write side) ↔ dsh-subagent-registry
// (read side) over the real shared files, in the DEPLOYED shape.
//
//   1. Probe — import @aiwayds/dsh-subagent-registry from a real profile's
//      node_modules and validate the contract members, i.e. exactly what the
//      plugin's registryDetected() sees in a deployed tui profile (sibling
//      resolution through the profile root, no declared dependency).
//   2. Handshake — in a scratch $DSH_HOME: write a `.dsh-profile` pin and a
//      model-profiles.json with one per-agent override through THIS plugin's
//      own store functions (the same code /profile-switch and /profile-cfg
//      run), then read it back through the REGISTRY's composeAgentRuntime
//      and assert effective = profile override ⊕ frontmatter baseline —
//      both fields, plus the baseline fallback for an unlisted agent.
//
// The registry side is optional: where the package is not resolvable (CI on
// this repo, which installs no @aiwayds/*), the script says so and exits 0 —
// the handshake leg simply needs a registry-bearing environment (a real
// profile, or an e2e container with the registry installed).
//
//   node scripts/contract-check.mjs [--registry-from <node_modules dir>]
//
// Exit 0 = contract holds (or registry absent and skipped); exit 1 = the
// deployed contract broke — a write the read side would silently ignore.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const REGISTRY_PACKAGE = '@aiwayds/dsh-subagent-registry'

/** Resolve the registry from --registry-from, else probe the real profile. */
function registryCandidates() {
  const fromArg = process.argv[process.argv.indexOf('--registry-from') + 1]
  const candidates = []
  if (fromArg !== undefined && !fromArg.startsWith('--')) candidates.push(fromArg)
  candidates.push(join(homedir(), '.dsh', 'profiles', 'tui', 'node_modules'))
  return candidates
}

async function importRegistry() {
  for (const root of registryCandidates()) {
    try {
      const req = createRequire(join(root, 'noop.js'))
      const resolved = req.resolve(REGISTRY_PACKAGE)
      const mod = await import(pathToFileURL(resolved).href)
      return { mod, from: resolved }
    } catch {
      /* next candidate */
    }
  }
  return undefined
}

function fail(message) {
  console.error(`contract-check: FAIL — ${message}`)
  process.exit(1)
}

// ---------------------------------------------------------------- probe ----

const registry = await importRegistry()
if (registry === undefined) {
  console.log('contract-check: SKIP — @aiwayds/dsh-subagent-registry not resolvable '
    + '(pass --registry-from <profile>/node_modules to check a deployed profile)')
  process.exit(0)
}
console.log(`contract-check: registry resolved from ${registry.from}`)

const { composeAgentRuntime, readModelProfilesDoc, workspaceProfileName } = registry.mod
for (const [name, value] of Object.entries({ composeAgentRuntime, readModelProfilesDoc, workspaceProfileName })) {
  if (typeof value !== 'function') fail(`contract member ${name} is not a function — the probe would treat the registry as absent`)
}
console.log('contract-check: probe leg PASS — all three contract members present (registryDetected() → true in this shape)')

// ------------------------------------------------------------ handshake ----

const pluginLib = join(repoRoot, 'lib')
const store = await import(pathToFileURL(join(pluginLib, 'model-profiles.js')).href)

const scratch = mkdtempSync(join(repoRoot, '.contract-check-'))
const home = join(scratch, 'dsh-home')
const worktree = join(scratch, 'worktree')
mkdirSync(join(home, 'agents'), { recursive: true })
mkdirSync(worktree, { recursive: true })
process.env.DSH_HOME = home

try {
  // Write side — THIS plugin's own store functions, the exact /profile-switch
  // + /profile-cfg code path: bind the tree, record the default route and a
  // per-agent override.
  const doc = store.seedModelProfilesDoc()
  const work = store.findProfile(doc, 'work')
  work.defaultModel = { provider: 'zai', model: 'glm-5.3', reasoningEffort: 'high' }
  work.agents['workhorse'] = { model: 'zai/glm-4.5-air', thinking: 'max' }
  work.agents['duck'] = {} // explicit inherit
  doc.current = 'work'
  const bindError = store.bindWorkspaceProfile(worktree, 'work')
  if (bindError !== undefined) fail(`pin bind failed: ${bindError}`)
  const saveError = store.saveModelProfiles(store.modelProfilesPath(), doc)
  if (saveError !== undefined) fail(`store save failed: ${saveError}`)
  console.log('contract-check: write leg done — pin + store written via the plugin lib')

  // Read side — the REGISTRY's composer, re-reading the same files per dispatch.
  const composed = composeAgentRuntime('workhorse', { model: 'baseline/m1', thinking: 'high' }, { startDir: worktree })
  const expected = { model: 'zai/glm-4.5-air', thinking: 'max' }
  if (composed.model !== expected.model || composed.thinking !== expected.thinking) {
    fail(`override not composed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(composed)}`)
  }

  const inherited = composeAgentRuntime('duck', { model: 'baseline/m1', thinking: 'high' }, { startDir: worktree })
  if (inherited.model !== 'baseline/m1' || inherited.thinking !== 'high') {
    fail(`explicit inherit fell back wrong: ${JSON.stringify(inherited)}`)
  }

  const unlisted = composeAgentRuntime('stranger', { model: 'baseline/m2' }, { startDir: worktree })
  if (unlisted.model !== 'baseline/m2') {
    fail(`unlisted agent baseline broken: ${JSON.stringify(unlisted)}`)
  }

  // The pin resolves through the registry's own reader too.
  const pin = workspaceProfileName(worktree)
  if (pin !== 'work') fail(`registry read the pin as ${JSON.stringify(pin)}, expected "work"`)
  if (!Array.isArray(readModelProfilesDoc()?.profiles)) fail('registry could not read back the store document')

  console.log('contract-check: handshake leg PASS — override wins, explicit-inherit and baseline fallback compose, pin + store readable by the registry')
  console.log('contract-check: PASS — the deployed three-repo contract holds')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
