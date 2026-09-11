/**
 * dsh-profile-switch — user model profiles as an independent, surface-agnostic
 * dsh plugin.
 *
 * A model profile is a named snapshot of the whole model configuration
 * (default model + think level, plus per-subagent model/thinking) stored in
 * `$DSH_HOME/model-profiles.json`, bound per workspace tree via a
 * `.dsh-profile` pin file, and consumed at subagent-spawn time by
 * dsh-subagent-registry (when installed). The write side of that store used
 * to live in dsh-tui-pi's profile panels; it moved here so every surface
 * gets it through ONE interaction path: the host's native ask-user seam.
 *
 * NOT the host's "profile" — naming note that matters: a dsh *profile*
 * (`~/.dsh/profiles/<name>/` + `dsh --profile`) is the boot-time plugin
 * composition and cannot change while the process runs. The *model
 * profiles* this plugin switches are runtime, workspace-scoped model
 * configuration. The README spells this out; keep the distinction in mind
 * when reading the code.
 *
 * Commands (host registry, both surfaces):
 * - `/profile-switch` — bind this tree to a profile: live default-model
 *   switch when a channel exists (tui-pi's selection bridge on the TUI, the
 *   session controller on the web), the `.dsh-profile` pin everywhere, and
 *   agent values compose per-workspace at spawn.
 * - `/profile-cfg` — the configuration wizard: new / edit / save-current /
 *   rename / delete, with the provider → model → think-level narrowing
 *   chain, and per-subagent overrides when the registry is detected.
 */

import type { Context } from '@deepseek-ai/cordis'
import { registerProfileCommands } from './commands.ts'

export const name = 'dsh-profile-switch'

/**
 * Hard dependencies — both are dsh-base services present on every surface.
 * Everything else (llm catalog, live-selection channels, agent files) is
 * soft-probed inside the flows so a missing piece degrades instead of
 * blocking the mount.
 */
export const inject = ['commands', 'userQuestions']

export function apply(ctx: Context): void {
  registerProfileCommands(ctx)
}
