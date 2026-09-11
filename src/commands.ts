/**
 * Host wiring: builds the flow services from the live cordis context and
 * registers `/profile-switch` + `/profile-cfg` into the host command
 * registry, so the commands exist on EVERY surface (the TUI's autocomplete
 * and the web composer both read that registry) instead of being re-implemented
 * per surface.
 *
 * Host services are consumed through narrow structural types and SOFT
 * probes (`ctx.get`) — never hard `inject` — because most of them are
 * surface-dependent conveniences, not requirements:
 * - `llm` powers the provider → model → effort option lists; absent (or a
 *   failing listing) the chain degrades to free text or skips the step.
 * - the live-selection channels are tried in order — the `dshTuiModelSelection`
 *   bridge (provided by dsh-tui-pi, the TUI's live selection ref) and the
 *   `sessionController` (the web plane's per-session selection) — and when
 *   neither exists the route still lands through the `.dsh-profile` pin on
 *   the next session; the summary says which.
 * - `agentDefaultModel` backs "save-current" when no live selection exists.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { agentsDir, listAgentFiles } from './agents-dir.ts'
import { probeRegistry } from './registry-probe.ts'
import {
  bindWorkspaceProfile,
  boundProfileName,
  loadModelProfiles,
  modelProfilesPath,
  removeProfilePin,
  saveModelProfiles,
  type ProfileModelRoute,
} from './model-profiles.ts'
import {
  runProfileConfig,
  runProfileSwitch,
  type EffortEntry,
  type ModelEntry,
  type ProfileFlowServices,
  type ProviderEntry,
} from './flows.ts'

/** The llm catalog surface this plugin reads, structurally narrowed. */
interface LlmCatalog {
  listProviders(): readonly ProviderEntry[]
  listModels(provider: string): Promise<readonly ModelEntry[]>
  resolveModelInfo(provider: string, model: string): Promise<{
    reasoning?: { efforts?: readonly EffortEntry[] }
  } | undefined>
}

/** The web plane's session-controller surface (live selection per agent). */
interface SessionControllerLike {
  selectForNextRequest(agent: Agent, selection: ModelSelection): void
  selectionFor(agent: Agent): { current: ModelSelection }
}

/** The TUI bridge dsh-tui-pi provides (its live selection ref, per session). */
interface TuiSelectionBridge {
  apply(route: ProfileModelRoute): void
  current(): ProfileModelRoute | undefined
}

/** The persistent global default (dsh-base), the last "save-current" fallback. */
interface AgentDefaultModelLike {
  currentSelection(): ModelSelection
}

/** A host `ModelSelection` narrowed to the storable route shape. */
function selectionToRoute(selection: ModelSelection): ProfileModelRoute {
  return selection.reasoningEffort === undefined
    ? { provider: selection.provider, model: selection.model }
    : {
        provider: selection.provider,
        model: selection.model,
        reasoningEffort: selection.reasoningEffort,
      }
}

/** A stored route widened to the host selection shape. */
function routeToSelection(route: ProfileModelRoute): ModelSelection {
  return {
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort !== undefined
      ? { reasoningEffort: route.reasoningEffort as ReasoningEffortId }
      : {}),
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Build the flow services against one command invocation's agent + signal.
 * Everything that CAN be absent is soft-probed; only `userQuestions` (an
 * inject dependency) and `commands` are assumed present.
 */
export function makeServices(ctx: Context, agent: Agent | undefined, signal: AbortSignal): ProfileFlowServices {
  const llm = ctx.get('llm') as LlmCatalog | undefined
  const userQuestions = ctx.get('userQuestions') as {
    ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
  }
  const tuiBridge = () => ctx.get('dshTuiModelSelection') as TuiSelectionBridge | undefined
  const sessionController = () => ctx.get('sessionController') as SessionControllerLike | undefined
  const agentDefaultModel = () => ctx.get('agentDefaultModel') as AgentDefaultModelLike | undefined

  return {
    askUser: request => userQuestions.ask({ ...request, ...(agent !== undefined ? { agent } : {}), signal }),

    loadDoc: () => loadModelProfiles(modelProfilesPath()),
    saveDoc: doc => saveModelProfiles(modelProfilesPath(), doc),

    cwd: () => process.cwd(),
    bindTree: profileName => bindWorkspaceProfile(process.cwd(), profileName),
    unbindTree: boundName => removeProfilePin(process.cwd(), boundName),

    providers: () => {
      try {
        return llm?.listProviders() ?? []
      } catch {
        return []
      }
    },
    models: async provider => {
      if (llm === undefined) return []
      try {
        return await llm.listModels(provider)
      } catch {
        // One provider's listing failure must not kill the chain (the same
        // per-provider catch the TUI's /model picker applies).
        return []
      }
    },
    efforts: async (provider, model) => {
      if (llm === undefined) return undefined
      try {
        return (await llm.resolveModelInfo(provider, model))?.reasoning?.efforts
      } catch {
        return undefined
      }
    },

    currentRoute: () => {
      try {
        const fromTui = tuiBridge()?.current()
        if (fromTui !== undefined) return fromTui
      } catch { /* fall through to the next channel */ }
      if (agent !== undefined) {
        try {
          const installed = sessionController()?.selectionFor(agent)
          if (installed !== undefined) return selectionToRoute(installed.current)
        } catch { /* fall through */ }
      }
      try {
        const saved = agentDefaultModel()?.currentSelection()
        if (saved !== undefined && saved.provider !== '' && saved.model !== '') return selectionToRoute(saved)
      } catch { /* no fallback either */ }
      return undefined
    },

    applyLive: route => {
      try {
        const bridge = tuiBridge()
        if (bridge !== undefined) {
          bridge.apply(route)
          return { live: true }
        }
      } catch (error) {
        return { live: false, note: `live switch failed: ${messageOf(error)}` }
      }
      if (agent !== undefined) {
        try {
          const controller = sessionController()
          if (controller !== undefined) {
            controller.selectForNextRequest(agent, routeToSelection(route))
            return { live: true }
          }
        } catch (error) {
          return { live: false, note: `live switch failed: ${messageOf(error)}` }
        }
      }
      return {
        live: false,
        note: 'no live-selection channel on this surface — the default model applies from the next session in this tree',
      }
    },

    registryDetected: () => probeRegistry(),

    listAgents: () => {
      try {
        return listAgentFiles(agentsDir()).agents.map(agent => ({
          name: agent.meta.name,
          ...(agent.meta.description !== undefined ? { description: agent.meta.description } : {}),
          ...(agent.meta.model !== undefined ? { model: agent.meta.model } : {}),
          ...(agent.meta.thinking !== undefined ? { thinking: agent.meta.thinking } : {}),
        }))
      } catch {
        return []
      }
    },
  }
}

/**
 * Register both commands. The host command registry is surface-agnostic:
 * in the TUI a submission with no live session warms one first (tui-pi's
 * dispatcher), then executes here with that agent — so the very first
 * `/profile-switch` on a fresh TUI works and lands on the session it
 * created.
 */
export function registerProfileCommands(ctx: Context): void {
  ctx.effect(() => ctx.commands.register({
    name: 'profile-switch',
    description: 'Switch the model profile for this workspace (default model, think level, subagent models) via interactive questions',
    handler: async invocation => runProfileSwitch(makeServices(ctx, invocation.agent, invocation.signal)) as Promise<CommandResult>,
  }), 'dsh-profile-switch: /profile-switch')

  ctx.effect(() => ctx.commands.register({
    name: 'profile-cfg',
    description: 'Configure model profiles (new, edit, save-current, rename, delete) via interactive questions',
    handler: async invocation => runProfileConfig(makeServices(ctx, invocation.agent, invocation.signal)) as Promise<CommandResult>,
  }), 'dsh-profile-switch: /profile-cfg')
}
