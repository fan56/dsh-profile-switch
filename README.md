# dsh-profile-switch

A [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) plugin: **named model
profiles you can switch and configure interactively through the host's native
ask-user flow — one implementation that works on the TUI and the web surface,
and fails fast with guidance on headless.**

A *model profile* is a snapshot of your whole model configuration:

- the **default model + think level** (a saved `/model` selection), and
- optional **per-subagent model/thinking overrides**.

Switching between contexts (`work` ↔ `personal`) becomes one command instead
of a `/model` + per-agent tour.

> **"profile" means two different things in dsh — this plugin is the model
> kind.** A dsh *profile* (`~/.dsh/profiles/<name>/`, `dsh --profile <name>`)
> is the boot-time plugin composition; it cannot change while the process
> runs. The *model profiles* this plugin switches live in
> `~/.dsh/model-profiles.json`, apply at runtime, and are scoped to the
> workspace tree that binds them.

## Install

```bash
dsh plugin --profile <your-profile> add @aiwayds/dsh-profile-switch
```

The plugin mounts with `inject: ['commands', 'userQuestions']` — both are
dsh-base services, so it coexists with any surface and any plugin stack.

## Commands

### `/profile-switch`

One question: which profile this workspace tree binds to. Answering applies
the profile in layers:

1. **Live default model** — when a live-selection channel exists: on the TUI
   through dsh-tui-pi's selection bridge, on the web through the session
   controller. The current conversation continues on the new model
   immediately. Without a channel the summary says so; the route still lands
   through the tree pin on the next session.
2. **Tree binding** — writes `.dsh-profile` into the current directory
   (nearest file up the tree wins, `.nvmrc` style), so every NEW session in
   this tree assembles its initial selection from the profile. Other trees
   are untouched: a switch is workspace-scoped, never machine-global.
3. **Subagent overrides** — written nowhere at apply time. Each agent's
   runtime model/thinking is composed at spawn from the agent file's
   frontmatter baseline ⊕ this pinned profile's overrides (recomputed on
   every dispatch, including continuations), which is what keeps a switch
   fully workspace-scoped.

The switch deliberately does NOT write the global `agent-default-model`
setting — that stays `/model`'s write, and crossing tree boundaries is
exactly what a profile switch must not do.

The list also carries **`(unbind this tree)`** when the tree is bound:
removes the pin (guarded — a hand-decorated pin file is never clobbered; the
plugin refuses and says so).

### `/profile-cfg`

The configuration wizard — an operation menu, then the matching flow:

| Operation | What it asks |
| --- | --- |
| `new` | name → default model chain → per-subagent overrides |
| `edit` | pick a profile → re-answer the same chain (current values shown in the questions) |
| `save-current` | name → captures the live selection (or the deployment default) → optionally snapshot every discovered agent's baseline |
| `rename` | pick a profile → new name |
| `delete` | pick a profile → confirm (the last remaining profile is refused) |

Every model choice is a **three-step narrowing chain** of separate ask-user
questions — provider → that provider's models → that model's think levels —
because each step's options depend on the previous answer. All three lists
are read live from the installed llm adapters (`listProviders` /
`listModels` / `resolveModelInfo`), so think levels are exactly what the
adapter serves — never hardcoded (the `llm-deepseek` route rejects `medium`;
only the adapter knows what a model accepts). A provider that lists nothing
falls back to typing a model id; a model with no selectable efforts skips
the think step.

Cancel anywhere (Esc / closing the question) aborts the wizard with **nothing
saved** — the store is written exactly once, at the end.

## Subagent overrides (with dsh-subagent-registry)

When [dsh-subagent-registry](https://github.com/fan56/dsh-subagent-registry)
is installed, the `new`/`edit` wizards add a multi-select over your
discovered agents (`~/.dsh/agents/*.md`), then the same provider → model →
think chain per selected agent — with **`(inherit)`** leading every step.
Composing semantics:

- a recorded non-empty value wins over the agent file's frontmatter;
- an empty entry (both steps inherited) records an *explicit inherit*;
- agents absent from the profile compose from the baseline.

**Without the registry** the overrides would have no consumer, so the
per-agent section is skipped with a note and profiles simply hold the main
default model — detection is a contract-member probe
(`composeAgentRuntime` / `readModelProfilesDoc` / `workspaceProfileName`),
the same convention dsh-tui-pi established.

## Surfaces

| | TUI | web | headless |
| --- | --- | --- | --- |
| Question rendering | dsh-tui-pi's ask-user dock panel | the web composer takeover | — |
| Live default-model switch | yes (tui-pi bridge) | yes (session controller) | n/a |
| Tree binding + store | yes | yes | via files |
| No-answerer behavior | — | — | fast-fail with guidance |

On a surface with no ask-user answerer (headless runs one task and exits),
the commands fail fast with guidance pointing at the non-interactive path:
write `<workspace>/.dsh-profile` and edit `~/.dsh/model-profiles.json`
directly. Nothing hangs.

## Storage & files

- `~/.dsh/model-profiles.json` — the store (`$DSH_HOME` honored). Versioned
  (`version: 1`), self-healing (a corrupt/unknown file degrades to the
  seeded `work` / `personal` / `other` profiles, never throws), atomically
  written (tmp sibling + rename). **This file is a shared contract**:
  dsh-subagent-registry reads it (spawn-time composition) and dsh-tui-pi's
  session bootstrap reads it (new-session seeding from the pin). Schema:

  ```jsonc
  {
    "version": 1,
    "current": "work",            // informational, last applied anywhere
    "profiles": [
      {
        "name": "work",
        "defaultModel": { "provider": "zai-coding-cn", "model": "glm-5.3", "reasoningEffort": "high" },
        "agents": {
          "workhorse": { "model": "volc-ark-plan/deepseek-v4-flash", "thinking": "high" },
          "oldfox": {}              // empty entry = explicit inherit
        }
      }
    ]
  }
  ```

- `<workspace>/.dsh-profile` — the tree pin: one line naming the profile;
  blank lines and `#` comments allowed. The plugin overwrites it on a switch
  ONLY when it parses as exactly one entry line — a hand-decorated file is
  refused and surfaced, never clobbered.

## Relation to dsh-tui-pi

The model-profile feature moved here from dsh-tui-pi (which carried it as
TUI-only panels). Pairing:

- **with** a dsh-tui-pi that provides the `dshTuiModelSelection` bridge:
  `/profile-switch` also live-switches the current TUI session's default
  model;
- with an older/newer tui-pi without the bridge: everything else works; the
  live leg degrades to "next session in this tree" and the summary says so;
- the per-agent editing entry in tui-pi's `/agents` manager writes the same
  store with the same schema — both editors coexist.

## Uninstall

```bash
dsh plugin --profile <your-profile> remove @aiwayds/dsh-profile-switch
```

The plugin owns no daemons and holds no host resources, so removal is clean
on the next boot. Your data is intentionally preserved:

- `~/.dsh/model-profiles.json` — delete it if you want the store gone;
- `<workspace>/.dsh-profile` pins — delete per tree (`rm .dsh-profile`); a
  pin naming a missing profile simply binds nothing.

## Development

```bash
pnpm install
pnpm build && pnpm check && pnpm test   # unit suite (builds first)
node scripts/smoke-boot.mjs             # real-host boot gate (needs global dsh)
```

`scripts/link-dsh-closure.mjs` re-points `node_modules/@deepseek-ai/*` at
the global dsh CLI's own closure so typecheck and tests see exactly one
cordis. CI runs the same steps on Node 22/24 plus the boot smoke, and a
daily schedule watches for upstream rc/stable drift.

License — MIT.
