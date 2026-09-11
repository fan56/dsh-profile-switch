/**
 * The optional contract between dsh-profile-switch and dsh-subagent-registry
 * (the profile-composition read side), kept in its own module so the probe
 * and its tests import one tiny surface.
 *
 * The registry exports `composeAgentRuntime` / `readModelProfilesDoc` /
 * `workspaceProfileName` as its stable consumption contract — dsh-tui-pi
 * probes the same members, and the registry's changelog documents that
 * older registries "degrade cleanly" when a consumer checks members
 * individually. This plugin only needs PRESENCE (the wizard skips per-agent
 * questions when the composer is not there to consume overrides), never the
 * functions themselves — the spawn path consumes the written store on its
 * own.
 */

/** The npm package name probed for the registry. */
export const REGISTRY_PACKAGE = '@aiwayds/dsh-subagent-registry'

/** The contract members a registry must expose for the wizard to trust it. */
export interface RegistryContract {
  composeAgentRuntime: unknown
  readModelProfilesDoc: unknown
  workspaceProfileName: unknown
}

/** Whether `mod` carries the full profile-composition contract. */
export function isRegistryModule(mod: unknown): mod is RegistryContract {
  if (mod === null || typeof mod !== 'object') return false
  const { composeAgentRuntime, readModelProfilesDoc, workspaceProfileName } = mod as Record<string, unknown>
  return (
    typeof composeAgentRuntime === 'function'
    && typeof readModelProfilesDoc === 'function'
    && typeof workspaceProfileName === 'function'
  )
}
