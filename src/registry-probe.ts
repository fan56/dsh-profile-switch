/**
 * Detect whether dsh-subagent-registry is installed in this deployment.
 *
 * The per-subagent override entries in a model profile do nothing on their
 * own — they are consumed by the registry's profile-aware spawn composer
 * (effective = profile override ⊕ frontmatter baseline, recomputed on every
 * `use_agent` dispatch). When the registry is absent the config wizard skips
 * the per-agent questions entirely instead of writing entries no one reads.
 *
 * Detection is a dynamic-import probe of the package name, validating the
 * optional contract members dsh-tui-pi established as the ecosystem
 * convention (`composeAgentRuntime` / `readModelProfilesDoc` /
 * `workspaceProfileName`, present since registry 0.9.x). Tool names are NOT
 * a reliable probe (they are configurable) and the registry exposes no
 * cordis service. An old registry missing the members degrades to "not
 * detected", as does an unresolvable package — never a throw.
 *
 * The import resolves through the profile's own node_modules: plugins are
 * installed as siblings under `~/.dsh/profiles/<name>/node_modules`, so the
 * package is reachable from any plugin in the same profile without being a
 * declared dependency (declaring it would pin a second registry copy into
 * the closure — the double-closure hazard every dsh plugin avoids).
 */

import { isRegistryModule, REGISTRY_PACKAGE } from './contract.ts'
let cached: boolean | undefined

/**
 * Whether the registry is installed AND carries the contract members. The
 * probe runs once per process (package presence does not change while the
 * host runs — plugin sets are boot-time) and never throws.
 */
export async function probeRegistry(): Promise<boolean> {
  if (cached !== undefined) return cached
  cached = await detectRegistry()
  return cached
}

async function detectRegistry(): Promise<boolean> {
  try {
    const mod: unknown = await import(REGISTRY_PACKAGE)
    return isRegistryModule(mod)
  } catch {
    return false
  }
}
