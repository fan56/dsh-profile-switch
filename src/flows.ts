/**
 * The interactive flows behind `/profile-switch` and `/profile-cfg`, built
 * entirely on the host's native ask-user seam (`ctx.userQuestions.ask`) —
 * zero UI code of its own. The TUI renders the questions through its
 * ask-user dock panel, the web surface through the composer takeover, and a
 * surface with no answerer fails fast (NO_PROVIDER) into the guidance text
 * below — one flow, three surfaces, no per-surface code.
 *
 * Question shape (the 2026-09-11 design): every model choice is a THREE-STEP
 * NARROWING CHAIN of separate `ask()` calls — provider → that provider's
 * models → that model's think levels — because each step's options depend on
 * the previous answer, which one multi-question form cannot express. The
 * chain reuses the same seams the TUI's /model picker reads
 * (`llm.listProviders` / `llm.listModels` / `llm.resolveModelInfo`), so the
 * option lists are always exactly what the installed adapters serve: no
 * hardcoded think levels (the llm-deepseek route rejects `medium`, a value
 * only the adapter knows), no stale model ids.
 *
 * Wizard semantics: a decline (or any ask error) aborts the whole flow with
 * NOTHING saved — mutations land on the in-memory doc only, and the store
 * write happens once at the very end. Per-question skips are forgiving and
 * mean "leave unset / inherit".
 */

import type {
  AskUserQuestionAnswer,
  AskUserQuestionItem,
  AskUserQuestionOption,
  AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import { join } from 'node:path'
import {
  captureAgentsSnapshot,
  createProfile,
  deleteProfile,
  findProfile,
  formatProfileRoute,
  PROFILE_PIN_FILE,
  readNearestProfilePin,
  renameProfile,
  type ModelProfile,
  type ModelProfilesDoc,
  type ProfileAgentEntry,
  type ProfileModelRoute,
} from './model-profiles.ts'
import { THINKING_LEVELS } from './agents-dir.ts'
import { DECLINE_MESSAGE, errorCode, isDeclinedEnvelope, multiPick, singlePick } from './ask.ts'
import type { AgentBaseline } from './model-profiles.ts'

/**
 * Everything the flows need from the host, injected — the same
 * dependencies-as-parameters pattern the TUI's ProfileDeps used, so unit
 * tests fake the whole host without a cordis context.
 */
export interface ProfileFlowServices {
  /** One native ask-user round trip (adds the live agent + signal). */
  askUser(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
  /** Read the store (fresh per flow — a wizard must not edit stale state). */
  loadDoc(): ModelProfilesDoc
  /** Persist the store; resolves an error message on failure. */
  saveDoc(doc: ModelProfilesDoc): string | undefined
  /** The process cwd — the tree a switch binds. */
  cwd(): string
  /** Bind the cwd tree to a profile (write `.dsh-profile`). */
  bindTree(profileName: string): string | undefined
  /** Remove the cwd tree's pin (guarded against hand-decorated files). */
  unbindTree(boundName: string): string | undefined
  /** Installed providers (`llm.listProviders`), empty when no llm service. */
  providers(): readonly ProviderEntry[]
  /** One provider's models; a listing failure is that provider's empty list. */
  models(provider: string): Promise<readonly ModelEntry[]>
  /** One model's selectable think levels; `undefined` = adapter offers none. */
  efforts(provider: string, model: string): Promise<readonly EffortEntry[] | undefined>
  /** The current configuration for "save-current" (live selection first). */
  currentRoute(): ProfileModelRoute | undefined
  /**
   * Apply the default route to the LIVE session when a channel exists:
   * `live` says whether it took; `note` carries a warning (failed apply or
   * no channel — the route still lands via the pin on the next session).
   */
  applyLive(route: ProfileModelRoute): { live: boolean; note?: string }
  /** Whether dsh-subagent-registry (the override consumer) is installed. */
  registryDetected(): Promise<boolean>
  /** Discovered agents (`~/.dsh/agents/*.md` frontmatter baselines). */
  listAgents(): readonly AgentInfo[]
}

/** One `llm.listProviders()` entry, structurally narrowed. */
export interface ProviderEntry {
  id: string
  name?: string
}

/** One discovered agent, as the wizard sees it (frontmatter baseline). */
export interface AgentInfo {
  name: string
  description?: string
  model?: string
  thinking?: string
}

/** One `llm.listModels(provider)` entry, structurally narrowed. */
export interface ModelEntry {
  id: string
  name?: string
}

/** One reasoning-effort option from the adapter, structurally narrowed. */
export interface EffortEntry {
  id: string
  name?: string
  description?: string
}

/** What a flow returns to the command layer (a host CommandResult shape). */
export type FlowResult = { kind: 'success'; text: string } | { kind: 'error'; text: string }

/** Sentinel option labels — distinct enough that no real name collides. */
export const NO_ROUTE_LABEL = '(no default model)'
export const PROVIDER_DEFAULT_EFFORT_LABEL = '(provider default)'
export const INHERIT_LABEL = '(inherit)'
export const UNBIND_LABEL = '(unbind this tree)'

/** Guidance when no surface answered the ask (headless, no live panel). */
export const NO_SURFACE_GUIDANCE =
  'no ask-user surface answered the request — profile switching is interactive (TUI or web). '
  + `Non-interactive alternative: write <workspace>/${PROFILE_PIN_FILE} (the profile name) `
  + 'and edit ~/.dsh/model-profiles.json directly.'

/** Internal: the user backed out of the wizard. Never escapes a flow. */
class WizardCancelled extends Error {
  constructor() {
    super('wizard cancelled')
  }
}

/** Internal: no ask-user surface accepted the request. */
class NoAnswererError extends Error {
  constructor() {
    super(NO_SURFACE_GUIDANCE)
  }
}

function success(text: string): FlowResult {
  return { kind: 'success', text }
}

function failure(text: string): FlowResult {
  return { kind: 'error', text }
}

/** Map a flow error to its result: guidance for no-answerer, message otherwise. */
function flowFailure(error: unknown): FlowResult {
  if (error instanceof WizardCancelled) return success('Cancelled — nothing was saved.')
  if (error instanceof NoAnswererError) return failure(NO_SURFACE_GUIDANCE)
  return failure(error instanceof Error ? error.message : String(error))
}

/**
 * One native ask round: adds no per-surface knowledge, translates a
 * NO_PROVIDER rejection into the flow-level NoAnswererError, and turns the
 * canonical whole-request decline into a wizard cancellation.
 */
async function askOnce(
  svc: ProfileFlowServices,
  questions: readonly AskUserQuestionItem[],
): Promise<AskUserQuestionAnswer> {
  let answer: AskUserQuestionAnswer
  try {
    answer = await svc.askUser({ questions: [...questions] })
  } catch (error) {
    if (errorCode(error) === 'NO_PROVIDER') throw new NoAnswererError()
    throw error
  }
  if (isDeclinedEnvelope(questions, answer)) throw new WizardCancelled()
  return answer
}

/** Ask one single-select question and resolve its pick (`undefined` = skipped). */
async function askPick(
  svc: ProfileFlowServices,
  question: AskUserQuestionItem,
): Promise<string | undefined> {
  const answer = await askOnce(svc, [question])
  return singlePick(answer, question.id)
}

/** Ask a free-text question (no options); a skipped name aborts the wizard. */
async function askName(svc: ProfileFlowServices, question: string, detail?: string): Promise<string> {
  const picked = await askPick(svc, { id: 'name', header: 'Name', question, detail })
  if (picked === undefined) throw new WizardCancelled()
  return picked
}

/** Option list for provider ids, display name as the description. */
function providerOptions(providers: readonly ProviderEntry[]): AskUserQuestionOption[] {
  return providers.map(provider => ({
    label: provider.id,
    description: provider.name !== undefined && provider.name !== provider.id ? provider.name : undefined,
  }))
}

/**
 * The three-step narrowing chain: provider → model → think level. Returns
 * `undefined` when the user picked the none-option or skipped anywhere on
 * the way — the caller leaves the route unset. `none` adds the leading
 * "no route" option (the main-agent chain); the subagent chain passes
 * `inherit` instead and treats the pick as "no model override".
 */
async function askRouteChain(
  svc: ProfileFlowServices,
  opts: {
    firstOption?: { label: string; description?: string }
    providerQuestion: string
  },
): Promise<ProfileModelRoute | undefined> {
  const providers = svc.providers()
  if (providers.length === 0) return undefined

  const options: AskUserQuestionOption[] = opts.firstOption !== undefined ? [opts.firstOption] : []
  options.push(...providerOptions(providers))
  const provider = await askPick(svc, {
    id: 'provider',
    header: 'Provider',
    question: opts.providerQuestion,
    options,
  })
  if (provider === undefined || provider === opts.firstOption?.label) return undefined

  const model = await askModel(svc, provider)
  if (model === undefined) return undefined

  const reasoningEffort = await askEffort(svc, {
    provider,
    model,
    noneOption: { label: PROVIDER_DEFAULT_EFFORT_LABEL, description: 'no think-level override' },
    question: `Think level for ${provider}/${model}?`,
  })
  return {
    provider,
    model,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  }
}

/** The model step: the provider's listed models, or free text when none list. */
async function askModel(svc: ProfileFlowServices, provider: string): Promise<string | undefined> {
  const models = await svc.models(provider)
  if (models.length === 0) {
    // The adapter lists nothing for this provider — fall back to free text
    // instead of dead-ending the chain.
    return askPick(svc, {
      id: 'model',
      header: 'Model',
      question: `Type the ${provider} model id:`,
    })
  }
  return askPick(svc, {
    id: 'model',
    header: 'Model',
    question: `Which ${provider} model?`,
    options: models.map(model => ({
      label: model.id,
      description: model.name !== undefined && model.name !== model.id ? model.name : undefined,
    })),
  })
}

/**
 * The think-level step: options come from the adapter's own effort list —
 * never hardcoded. With no model context (an inherited subagent model) the
 * registry's THINKING_LEVELS whitelist stands in: it is exactly the set the
 * spawn-time composer accepts, so a written value can never be silently
 * dropped. `undefined`/skip = leave unset.
 */
async function askEffort(
  svc: ProfileFlowServices,
  opts: {
    provider?: string
    model?: string
    noneOption?: { label: string; description?: string }
    question: string
  },
): Promise<string | undefined> {
  let efforts: readonly EffortEntry[] | undefined
  if (opts.provider !== undefined && opts.model !== undefined) {
    efforts = await svc.efforts(opts.provider, opts.model)
  }
  const levels: AskUserQuestionOption[] = efforts !== undefined && efforts.length > 0
    ? efforts.map(effort => ({
        label: effort.id,
        description: effort.description ?? (effort.name !== undefined && effort.name !== effort.id ? effort.name : undefined),
      }))
    : THINKING_LEVELS.map(level => ({ label: level }))
  const options: AskUserQuestionOption[] = opts.noneOption !== undefined ? [opts.noneOption] : []
  options.push(...levels)
  const picked = await askPick(svc, {
    id: 'effort',
    header: 'Think level',
    question: opts.question,
    options,
  })
  if (picked === undefined) return undefined
  if (opts.noneOption !== undefined && picked === opts.noneOption.label) return undefined
  if (picked === INHERIT_LABEL) return undefined
  return picked
}

/**
 * One agent's override entry through the same narrowing chain, with
 * "(inherit)" leading every step: skipping or inheriting both steps records
 * an explicit-inherit EMPTY entry (the compose falls back to the agent
 * file's frontmatter baseline).
 */
async function askAgentEntry(svc: ProfileFlowServices, agent: AgentInfo): Promise<ProfileAgentEntry> {
  const baseline = agent.model !== undefined
    ? `${agent.model} · think ${agent.thinking ?? 'default'}`
    : 'inherits the default model'
  const provider = await askPick(svc, {
    id: 'provider',
    header: agent.name,
    question: `Model provider for "${agent.name}"? (baseline: ${baseline})`,
    options: [
      { label: INHERIT_LABEL, description: 'no model override — the agent file frontmatter wins' },
      ...providerOptions(svc.providers()),
    ],
  })

  let model: string | undefined
  if (provider !== undefined && provider !== INHERIT_LABEL) {
    model = await askModel(svc, provider)
  }

  const thinking = await askEffort(svc, {
    ...(provider !== undefined && provider !== INHERIT_LABEL && model !== undefined
      ? { provider, model }
      : {}),
    noneOption: { label: INHERIT_LABEL, description: 'no think override — the agent file frontmatter wins' },
    question: `Think level for "${agent.name}"?`,
  })

  const entry: ProfileAgentEntry = {}
  if (provider !== undefined && provider !== INHERIT_LABEL && model !== undefined) {
    entry.model = `${provider}/${model}`
  }
  if (thinking !== undefined) entry.thinking = thinking
  return entry
}

/** The multi-select over discovered agents (skip = every agent inherits). */
async function askAgentMultiSelect(svc: ProfileFlowServices, agents: readonly AgentInfo[]): Promise<string[]> {
  const answer = await askOnce(svc, [{
    id: 'agents',
    header: 'Subagents',
    multiSelect: true,
    question: 'Which subagents should this profile override? (skip = every agent inherits its file baseline)',
    options: agents.map(agent => {
      const parts = [agent.description, agent.model].filter(part => part !== undefined)
      return { label: agent.name, description: parts.length > 0 ? parts.join(' — ') : undefined }
    }),
  }])
  return multiPick(answer, 'agents')
}

/** One-row description of a profile for picker options. */
function profileDescription(profile: ModelProfile, bound: string | undefined): string {
  const agents = Object.keys(profile.agents).length
  const parts = [formatProfileRoute(profile.defaultModel)]
  if (agents > 0) parts.push(`${agents} agent${agents === 1 ? '' : 's'}`)
  if (bound !== undefined && bound.toLowerCase() === profile.name.toLowerCase()) parts.push('● bound in this tree')
  return parts.join(' · ')
}

/** Ask which profile to operate on (`undefined` = skipped). */
async function askProfilePick(
  svc: ProfileFlowServices,
  doc: ModelProfilesDoc,
  question: string,
): Promise<ModelProfile | undefined> {
  const picked = await askPick(svc, {
    id: 'profile',
    header: 'Profile',
    question,
    options: doc.profiles.map(profile => ({
      label: profile.name,
      description: profileDescription(profile, boundNameOf(svc, doc)),
    })),
  })
  if (picked === undefined) return undefined
  const profile = findProfile(doc, picked)
  if (profile === undefined) throw new Error(`no profile named "${picked}" — the store changed under the wizard`)
  return profile
}

function boundNameOf(svc: ProfileFlowServices, doc: ModelProfilesDoc): string | undefined {
  const pin = readNearestProfilePin(svc.cwd())
  return pin === undefined ? undefined : findProfile(doc, pin.name)?.name
}

// ------------------------------------------------------------- /profile-switch --

/**
 * `/profile-switch`: one question — which profile this tree binds to — then
 * the apply: live default-model switch when a channel exists, the
 * `.dsh-profile` tree binding (the workspace-scoped persistence), and the
 * informational store pointer. Agent model/think values are written
 * NOWHERE: each agent composes its runtime values at spawn from the
 * frontmatter baseline ⊕ this pinned profile (the registry's composer),
 * which is what makes a switch workspace-scoped. Deliberately does NOT
 * touch the global agent-default-model: that is /model's write, and
 * crossing tree boundaries is exactly what a profile switch must not do.
 */
export async function runProfileSwitch(svc: ProfileFlowServices): Promise<FlowResult> {
  try {
    const doc = svc.loadDoc()
    const bound = boundNameOf(svc, doc)

    const options: AskUserQuestionOption[] = doc.profiles.map(profile => ({
      label: profile.name,
      description: profileDescription(profile, bound),
    }))
    if (bound !== undefined) {
      options.push({
        label: UNBIND_LABEL,
        description: `remove ${PROFILE_PIN_FILE} — new sessions here fall back to the global default`,
      })
    }

    const picked = await askPick(svc, {
      id: 'profile',
      header: 'Profile',
      question: bound === undefined
        ? 'Bind this tree to which model profile?'
        : `Switch this tree (● ${bound}) to which model profile?`,
      options,
    })
    if (picked === undefined) return success('Profile unchanged.')

    if (bound !== undefined && picked === UNBIND_LABEL) {
      const unbindError = svc.unbindTree(bound)
      return unbindError === undefined
        ? success(`Unbound this tree — removed ${PROFILE_PIN_FILE} ("${bound}").`)
        : failure(unbindError)
    }

    const profile = findProfile(doc, picked)
    if (profile === undefined) return failure(`no profile named "${picked}" — the store changed under the wizard`)

    const parts: string[] = []
    let modelText = 'model unchanged'
    if (profile.defaultModel !== undefined) {
      const live = svc.applyLive(profile.defaultModel)
      modelText = live.live
        ? formatProfileRoute(profile.defaultModel)
        : `next session: ${formatProfileRoute(profile.defaultModel)}`
      if (live.note !== undefined) parts.push(`⚠ ${live.note}`)
    }

    // Bind the tree BEFORE reporting: an ancestor pin would otherwise keep
    // winning at assembly while the summary claims the switch took. A
    // hand-decorated pin file is refused by bindTree — surfaced, never
    // clobbered.
    const ancestor = readNearestProfilePin(svc.cwd())
    const pinError = svc.bindTree(profile.name)
    if (pinError !== undefined) {
      parts.push(`⚠ ${pinError}`)
    } else if (
      ancestor !== undefined
      && ancestor.path !== join(svc.cwd(), PROFILE_PIN_FILE)
      && ancestor.name.toLowerCase() !== profile.name.toLowerCase()
    ) {
      parts.push(`overrides ancestor pin "${ancestor.name}"`)
    }

    doc.current = profile.name
    const saveError = svc.saveDoc(doc)
    if (saveError !== undefined) parts.push(`⚠ profile not saved: ${saveError}`)

    parts.unshift(
      `Profile → ${profile.name} · ${modelText} · agent values compose per-workspace at spawn`,
      pinError === undefined ? `pinned this tree (${PROFILE_PIN_FILE})` : '',
    )
    return success(parts.filter(part => part !== '').join(' · '))
  } catch (error) {
    return flowFailure(error)
  }
}

// -------------------------------------------------------------- /profile-cfg --

/**
 * `/profile-cfg`: an operation menu, then the matching wizard — new / edit
 * (the full chain), save-current (capture the live configuration), rename,
 * delete. Every branch persists exactly once, at the end.
 */
export async function runProfileConfig(svc: ProfileFlowServices): Promise<FlowResult> {
  try {
    const op = await askPick(svc, {
      id: 'op',
      header: 'Profiles',
      question: 'What do you want to do with the model profiles?',
      options: [
        { label: 'new', description: 'create a profile: name, default model, per-subagent overrides' },
        { label: 'edit', description: 're-answer the default model and subagent overrides of one profile' },
        { label: 'save-current', description: 'capture the current configuration as a new profile' },
        { label: 'rename', description: 'rename a profile' },
        { label: 'delete', description: 'delete a profile' },
      ],
    })
    if (op === undefined) return success('Profiles unchanged.')
    switch (op) {
      case 'new': return await flowNew(svc)
      case 'edit': return await flowEdit(svc)
      case 'save-current': return await flowSaveCurrent(svc)
      case 'rename': return await flowRename(svc)
      case 'delete': return await flowDelete(svc)
      default: return failure(`unknown operation "${op}"`)
    }
  } catch (error) {
    return flowFailure(error)
  }
}

/** The "new" wizard: name → default-model chain → per-agent overrides. */
async function flowNew(svc: ProfileFlowServices): Promise<FlowResult> {
  const doc = svc.loadDoc()
  const name = await askName(svc, 'New profile name?')
  const { profile, error } = createProfile(doc, name)
  if (profile === undefined || error !== undefined) return failure(error ?? 'could not create the profile')

  const route = await askRouteChain(svc, {
    firstOption: { label: NO_ROUTE_LABEL, description: 'inherit the deployment default (agent-default-model)' },
    providerQuestion: 'Which provider hosts this profile\'s default model?',
  })
  if (route !== undefined) profile.defaultModel = route

  const agentNote = await applyAgentOverrides(svc, profile)
  const saveError = svc.saveDoc(doc)
  return success([
    `Profile "${profile.name}" created · ${formatProfileRoute(profile.defaultModel)}${agentNote}`,
    ...(saveError !== undefined ? [`⚠ profile not saved: ${saveError}`] : []),
  ].join(' · '))
}

/** The "edit" wizard: pick a profile, re-answer both halves, keep the rest. */
async function flowEdit(svc: ProfileFlowServices): Promise<FlowResult> {
  const doc = svc.loadDoc()
  const profile = await askProfilePick(svc, doc, 'Which profile do you want to edit?')
  if (profile === undefined) return success('Profiles unchanged.')

  const route = await askRouteChain(svc, {
    firstOption: { label: NO_ROUTE_LABEL, description: 'clear the default model (inherit the deployment default)' },
    providerQuestion: `Which provider hosts "${profile.name}"'s default model? (current: ${formatProfileRoute(profile.defaultModel)})`,
  })
  profile.defaultModel = route

  const agentNote = await applyAgentOverrides(svc, profile)
  const saveError = svc.saveDoc(doc)
  return success([
    `Profile "${profile.name}" updated · ${formatProfileRoute(profile.defaultModel)}${agentNote}`,
    ...(saveError !== undefined ? [`⚠ profile not saved: ${saveError}`] : []),
  ].join(' · '))
}

/**
 * The per-agent half of new/edit: with the registry present, a multi-select
 * over discovered agents, then the inherit-first chain per selected agent.
 * Unselected agents' existing entries are kept; re-answering an agent with
 * inherit on both steps records the explicit-inherit empty entry. Without
 * the registry the overrides would have no consumer, so the section is
 * skipped with a note.
 */
async function applyAgentOverrides(svc: ProfileFlowServices, profile: ModelProfile): Promise<string> {
  if (!(await svc.registryDetected())) {
    return ' · dsh-subagent-registry not detected — per-agent overrides skipped'
  }
  const agents = svc.listAgents()
  if (agents.length === 0) return ' · no agent files discovered in ~/.dsh/agents'

  const selected = await askAgentMultiSelect(svc, agents)
  for (const name of selected) {
    const agent = agents.find(candidate => candidate.name === name)
    if (agent === undefined) continue
    profile.agents[name] = await askAgentEntry(svc, agent)
  }
  const overridden = Object.keys(profile.agents).length
  return overridden > 0 ? ` · ${overridden} agent override${overridden === 1 ? '' : 's'}` : ''
}

/** The "save-current" wizard: capture the live configuration under a new name. */
async function flowSaveCurrent(svc: ProfileFlowServices): Promise<FlowResult> {
  const doc = svc.loadDoc()
  const name = await askName(svc, 'Save the current configuration as?')
  const { profile, error } = createProfile(doc, name)
  if (profile === undefined || error !== undefined) return failure(error ?? 'could not create the profile')

  const route = svc.currentRoute()
  if (route !== undefined) profile.defaultModel = route

  const include = await askPick(svc, {
    id: 'include',
    header: 'Agents',
    question: 'Record the discovered agents\' baselines into the snapshot?',
    options: [
      { label: 'snapshot', description: 'record every discovered agent (inherit ones as empty entries)' },
      { label: 'fresh', description: 'main model only — no agent entries' },
    ],
  })
  if (include === 'snapshot') {
    profile.agents = captureAgentsSnapshot(svc.listAgents() as readonly AgentBaseline[])
  }

  const saveError = svc.saveDoc(doc)
  return success([
    `Profile "${profile.name}" saved from the current configuration · ${formatProfileRoute(profile.defaultModel)}`,
    ...(saveError !== undefined ? [`⚠ profile not saved: ${saveError}`] : []),
  ].join(' · '))
}

/** The "rename" wizard: pick, retype, persist. */
async function flowRename(svc: ProfileFlowServices): Promise<FlowResult> {
  const doc = svc.loadDoc()
  const profile = await askProfilePick(svc, doc, 'Which profile do you want to rename?')
  if (profile === undefined) return success('Profiles unchanged.')

  const to = await askName(svc, `Rename "${profile.name}" to?`)
  const renameError = renameProfile(doc, profile.name, to)
  if (renameError !== undefined) return failure(renameError)
  const saveError = svc.saveDoc(doc)
  return saveError === undefined
    ? success(`Profile "${profile.name}" renamed to "${to}".`)
    : failure(`rename not saved: ${saveError}`)
}

/** The "delete" wizard: pick, confirm, persist (the last profile is refused). */
async function flowDelete(svc: ProfileFlowServices): Promise<FlowResult> {
  const doc = svc.loadDoc()
  const profile = await askProfilePick(svc, doc, 'Which profile do you want to delete?')
  if (profile === undefined) return success('Profiles unchanged.')

  const confirmed = await askPick(svc, {
    id: 'confirm',
    header: 'Confirm',
    question: `Delete the profile "${profile.name}"?`,
    options: [
      { label: 'delete', description: `remove "${profile.name}" permanently` },
      { label: 'keep', description: 'keep it — nothing changes' },
    ],
  })
  if (confirmed !== 'delete') return success('Profiles unchanged.')

  const deleteError = deleteProfile(doc, profile.name)
  if (deleteError !== undefined) return failure(deleteError)
  const saveError = svc.saveDoc(doc)
  return saveError === undefined
    ? success(`Profile "${profile.name}" deleted.`)
    : failure(`delete not saved: ${saveError}`)
}

// Re-exported for the decline-marker test contract.
export { DECLINE_MESSAGE }
