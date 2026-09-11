/**
 * Agent definitions as markdown files — one file per agent, mirroring the
 * dsh "one file per agent" convention.
 *
 * An agent is `<agents-dir>/<name>.md` with a `---` frontmatter block and a
 * markdown body that doubles as the agent's system prompt. dsh-profile-switch
 * only READS this directory: the config wizard offers the discovered agents
 * as per-profile override targets, and "save-current" snapshots their
 * frontmatter baseline. Parsing is a self-contained copy of the helpers from
 * dsh-tui-pi's agent manager / dsh-subagent-registry's agents-dir, with the
 * same fail-loud policy (an invalid `thinking`/`background`/`maxRounds` value
 * marks the file broken instead of being silently ignored) so every consumer
 * of `~/.dsh/agents/*.md` agrees on what a broken file is.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Valid frontmatter `thinking` values, in canonical order. */
export const THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'max'] as const

/** A reasoning effort id accepted in the `thinking` frontmatter key. */
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

/** One agent's frontmatter-derived metadata. */
export interface AgentMeta {
  /** Frontmatter `name` — required, the stable agent id. */
  name: string
  /** Optional display name, shown before `name` in a picker. */
  displayName?: string
  /** Optional one-line summary used as the tool-roster subtitle. */
  description?: string
  /** dsh model route (`provider/model`); absent = inherit the default. */
  model?: string
  /** Reasoning effort id (one of THINKING_LEVELS); absent = inherit. */
  thinking?: ThinkingLevel
  /** Spawn-depth budget: default 1 (may start subagents), 0 = leaf. */
  deep: number
  /** Dispatch the agent as a durable continuable (background) child. */
  background?: boolean
  /** Per-agent round cap (positive integer); absent = the global cap applies. */
  maxRounds?: number
}

/** A parsed agent file: metadata + the raw system-prompt body. */
export interface AgentFile {
  path: string
  meta: AgentMeta
  body: string
}

/** One parse outcome: a usable agent, or a broken file with a reason. */
export type AgentParseResult =
  | { ok: true; agent: AgentFile }
  | { ok: false; error: string }

/**
 * The dsh home directory: `$DSH_HOME` when set, `~/.dsh` otherwise — the
 * same resolution the dsh host and every dsh-* plugin use, so all shared
 * files (`model-profiles.json`, `agents/`, the `.dsh-profile` pin) live
 * under one root.
 */
export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** The dsh agents directory (`$DSH_HOME/agents`, i.e. `~/.dsh/agents`). */
export function agentsDir(): string {
  return join(dshHome(), 'agents')
}

const FRONTMATTER_FENCE = '---'
/** Frontmatter key pattern (same loose shape dsh-tui-pi / fun-agent accept). */
const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/

/** Strip one pair of matching surrounding quotes, if present. */
function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1)
  }
  return value
}

/** Check a candidate `thinking` value against the THINKING_LEVELS whitelist. */
function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value)
}

/** Find the closing fence line index of a frontmatter starting at line 0. */
function frontmatterBounds(lines: string[]): { close: number } | undefined {
  if (lines[0]?.trim() !== FRONTMATTER_FENCE) return undefined
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === FRONTMATTER_FENCE) return { close: i }
  }
  return undefined
}

/** Parse a loose `key: value` frontmatter block (lines 1..close-1). */
function parseFrontmatterValues(lines: string[], close: number): Record<string, string> {
  const values: Record<string, string> = {}
  for (let i = 1; i < close; i++) {
    const match = KEY_LINE.exec(lines[i])
    if (match === null) continue
    values[match[1]] = stripQuotes(match[2].trim())
  }
  return values
}

/**
 * Parse one agent markdown file. Tolerates CRLF, quotes, and non-key lines
 * inside the frontmatter; `name` is required, `deep` must be a non-negative
 * integer when present (absent defaults to 1). The body is kept verbatim.
 */
export function parseAgentMarkdown(text: string, path: string): AgentParseResult {
  const lines = text.split(/\r?\n/)
  const bounds = frontmatterBounds(lines)
  if (bounds === undefined) {
    return { ok: false, error: 'missing frontmatter (file must start with `---`)' }
  }
  const values = parseFrontmatterValues(lines, bounds.close)
  const name = values['name']?.trim()
  if (name === undefined || name === '') return { ok: false, error: 'missing required frontmatter key `name`' }
  let deep = 1
  if (values['deep'] !== undefined) {
    const raw = values['deep'].trim()
    if (!/^\d+$/.test(raw)) {
      return { ok: false, error: `invalid \`deep\`: expected a non-negative integer, got "${raw}"` }
    }
    deep = Number(raw)
  }
  const body = lines.slice(bounds.close + 1).join('\n').replace(/^\n+/, '').trimEnd()
  const meta: AgentMeta = { name, deep }
  const displayName = values['display_name']?.trim()
  if (displayName !== undefined && displayName !== '') meta.displayName = displayName
  const description = values['description']?.trim()
  if (description !== undefined && description !== '') meta.description = description
  const model = values['model']?.trim()
  if (model !== undefined && model !== '') meta.model = model
  const thinking = values['thinking']?.trim()
  if (thinking !== undefined && thinking !== '') {
    // Fail loud on unknown levels: mark the file broken instead of silently
    // ignoring or clamping the declared effort.
    if (!isThinkingLevel(thinking)) {
      return {
        ok: false,
        error: `invalid \`thinking\`: expected one of ${THINKING_LEVELS.join('/')}, got "${thinking}"`,
      }
    }
    meta.thinking = thinking
  }
  const background = values['background']?.trim()
  if (background !== undefined && background !== '') {
    // Same fail-loud policy as `thinking`: a typo (`ture`, `True`) must drop
    // the file from the roster rather than silently flip the dispatch mode.
    if (background !== 'true' && background !== 'false') {
      return { ok: false, error: `invalid \`background\`: expected true or false, got "${background}"` }
    }
    meta.background = background === 'true'
  }
  const maxRounds = values['maxRounds']?.trim()
  if (maxRounds !== undefined && maxRounds !== '') {
    // Fail-loud like `thinking`/`background`: a mistyped cap (`6o`, `0`, `-3`)
    // must mark the file broken, not silently fall back to the global cap.
    if (!/^\d+$/.test(maxRounds) || Number(maxRounds) < 1) {
      return { ok: false, error: `invalid \`maxRounds\`: expected a positive integer, got "${maxRounds}"` }
    }
    meta.maxRounds = Number(maxRounds)
  }
  return { ok: true, agent: { path, meta, body } }
}

/** List agents under `dir` (top level only), broken files reported aside. */
export function listAgentFiles(dir: string): { agents: AgentFile[]; broken: Array<{ path: string; error: string }> } {
  const agents: AgentFile[] = []
  const broken: Array<{ path: string; error: string }> = []
  if (!existsSync(dir)) return { agents, broken }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const path = join(dir, entry.name)
    const result = parseAgentMarkdown(readFileSync(path, 'utf8'), path)
    if (result.ok) agents.push(result.agent)
    else broken.push({ path, error: result.error })
  }
  agents.sort((a, b) => a.meta.name.localeCompare(b.meta.name))
  return { agents, broken }
}
