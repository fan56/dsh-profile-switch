# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Releases are tag-driven: a `v*` git tag is the only path to npm.

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
