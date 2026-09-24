# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Releases are tag-driven: a `v*` git tag is the only path to npm.

## [0.1.2] - 2026-09-14

### Changed
- **Docs: TUI pairing floor.** Recommend dsh-tui-pi ≥ 2.18.1 when pairing on
  the TUI: tui-pi 2.16.0–2.18.0 dropped these command names from its
  never-aborting dispatch list while moving the panels here, so a
  `/profile-cfg` session longer than 90s echoed a spurious
  `aborted due to timeout` (the panel kept working; tui-pi 2.18.1 fixed the
  dispatch). Web/headless surfaces have no such guard. Also states plainly
  that no manual profile wiring is expected: `dsh plugin add` reconciles the
  bundle entry and the commands register on every surface.

## [0.1.1] - 2026-09-12

### Fixed
- **`apply()` is now idempotent across mounts.** dsh-tui-pi's bundle patch
  mounts this plugin automatically (so an upgrade reactivates the commands
  with zero user action), and a profile may also list it in `bundles` — two
  tree entries, one plugin. The second apply used to register the same
  command names and crash the whole boot (`command "profile-switch" is
  already registered`). The first apply now claims a root-scope marker
  synchronously at apply entry; every later mount no-ops. Guarded by unit
  tests and exercised in both mount shapes on a real host.

## [Unreleased]

### Added

- `/profile-switch` — bind the current workspace tree to a model profile via
  one native ask-user question: live default-model switch when a
  live-selection channel exists (dsh-tui-pi's selection bridge, or the web
  session controller), the `.dsh-profile` pin everywhere, and a summary that
  says which channel served the switch. Includes the guarded
  `(unbind this tree)` action.
- `/profile-cfg` — the configuration wizard over the same ask-user seam:
  new / edit / save-current / rename / delete, with the three-step narrowing
  chain (provider → that provider's models → that model's think levels, all
  read live from the installed llm adapters) and per-subagent
  model/thinking overrides offered only when dsh-subagent-registry is
  detected (the consumer of those entries).
- The `model-profiles.json` store write side (moved here from dsh-tui-pi's
  profile panels, schema unchanged — `MODEL_PROFILES_VERSION = 1`), the
  `.dsh-profile` pin reader/writer with the hand-edited-file guards, and the
  agent-file discovery for `~/.dsh/agents/*.md` baselines.
- Headless / no-answerer fallback: an interactive command on a surface with
  no ask-user answerer fails fast with guidance pointing at the
  non-interactive files instead of hanging.

### Changed

- **Aligned with the dsh 0.1.7-rc.1 wave.** The peer-dependency floor is
  raised to `>=0.1.7-rc.1` (dsh-agent / dsh-commands / dsh-llm /
  dsh-user-questions) and the devDependencies are pinned to `0.1.7-rc.1`
  with `@deepseek-ai/cordis` at `^4.0.4`. No code changes were required:
  the flows' narrow structural types (`ModelSelection`,
  `ReasoningEffortId`, the ask-user envelopes) compile unchanged against
  0.1.7-rc.1.
- **Plugin Manager metadata.** Ships `locale/en.json` / `locale/zh.json`
  (localized title + description) and an `icon.svg` declared in
  `package.json`, per the 0.1.7 plugin-metadata convention.
- **No settings migration needed:** the plugin never registered a
  `settings.yaml` namespace under 0.1.5 — its data has always lived in the
  plugin-owned `model-profiles.json` store and the `.dsh-profile` pins, so
  the 0.1.7 settings rework (declarative `static Config` projection) leaves
  nothing to carry over, and the stable entry id `dsh-profile-switch` keeps
  any hypothetical hand-written section importable by name.
