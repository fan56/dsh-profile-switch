# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Releases are tag-driven: a `v*` git tag is the only path to npm.

## [0.4.1] - 2026-11-13

### Fixed
- **The published package no longer carries an install lifecycle hook — `postinstall` became `prepare` — so pnpm 11 updates stop failing with `ERR_PNPM_IGNORED_BUILDS` (see fan56/dsh-subagent-registry#10).** pnpm 11 defaults to `strictDepBuilds`: an install of a dependency declaring an unapproved `preinstall`/`install`/`postinstall` exits non-zero, and the dsh host plugin manager rolls the update back. npm and pnpm never run `prepare` for registry dependencies, and pnpm's gate set is exactly those three install hooks, so the published manifest is now hook-free while the dev closure linking keeps running from the root `prepare` hook (`npm run link-closure` stays the manual entry; CI's explicit `node scripts/link-dsh-closure.mjs` step is unaffected).
- **The closure linker's stand-down guard also exits when `INIT_CWD` is set and is not the repo root** — npm runs `prepare` inside a throwaway clone when installing a git dependency, and a root install invoked from a subdirectory resolves here with an `INIT_CWD` elsewhere. `INIT_CWD` equal to the repo root (a normal root install) and an unset `INIT_CWD` (a direct `node scripts/link-dsh-closure.mjs` call) still link; a `realpathSync` failure exits 0.

### Changed
- **Rides the dsh 0.2.2-rc.2 dev closure; peer floors stay `>= 0.2.0-rc.2`.** The devDependency pins (`dsh-agent`, `dsh-commands`, `dsh-llm`, `dsh-user-questions`) re-pin `0.2.2-rc.1` → `0.2.2-rc.2` exactly (the wave is complete on npm); `@deepseek-ai/cordis` stays `^4.1.0` — the rc.2 closure ships the same `~4.1.0` line, so the range already resolves onto the closure version. The `>= 0.2.0-rc.2` peer floors are intentionally unchanged: no 0.2.2-only API is used and the host preflight satisfies ranges with `includePrerelease`, so the floor already matches the new rc. ci.yml already resolves the host newest-of(latest/next) at runtime with the prerelease-aware node comparator in both jobs; release.yml has no host install step at all — its `npm view` calls only verify the just-published version of this package — so no workflow change this wave. Mechanical dependency ride, no source changes. Re-verified against the 0.2.2-rc.2 scratch closure: typecheck clean, 67 tests pass / 0 fail; real-host boot smoke PASS (composed, 25s boot window survived, removal restored the stock tree).

## [0.4.0] - 2026-11-06

### Changed
- **Rides the dsh 0.2.2-rc.1 dev closure; peer floors stay `>= 0.2.0-rc.2`.** The devDependency pins (`dsh-agent`, `dsh-commands`, `dsh-llm`, `dsh-user-questions`) re-pin `0.2.1-rc.5` → `0.2.2-rc.1` exactly; `@deepseek-ai/cordis` moves `^4.0.4` → `^4.1.0` (the frozen lock installed cordis 4.0.4 while the rc.1 closure members peer-demand `~4.1.0`, so the committed lock could not reproduce the host closure the tests target — re-resolution landed every `@deepseek-ai` instance on 4.1.0 with zero residual 4.0.4 refs, and also repaired two stale lock entries that resolved `dsh-llm` / `dsh-user-questions` to 0.2.1-rc.5 despite the exact 0.2.2-rc.1 pins). The `>= 0.2.0-rc.2` peer floors are intentionally unchanged: no 0.2.2-only API is used and the host preflight satisfies ranges with `includePrerelease`, so the floor already matches the new rc. ci.yml already resolves the newest of the `latest`/`next` dist-tags with the prerelease-aware comparator; release.yml has no host install step at all — its `npm view` calls only verify the just-published version of this package — so no workflow change this wave.

### Fixed
- **The published tarball is npm-installable** — `postinstall` runs `node scripts/link-dsh-closure.mjs`, but the `files` allow-list never shipped `scripts/`, so every non-link install (plugin manager, plain `npm install`) died in the lifecycle step with `MODULE_NOT_FOUND` — the same defect class as fan56/dsh-subagent-registry#2. `scripts/` now ships, and the linker's stand-down guard swapped the fragile marker check for `tsconfig.json` + `.git`. `test/packaged-install.test.mjs` packs, installs the tarball under npm with lifecycle scripts on, and asserts the linker stood down; the boot smoke installs via npm for the same reason and asserts the stand-down against the real host.


### Changed

- **0.2.1-rc.2 wave**: devDeps `@deepseek-ai/*` pins `0.2.0-rc.2` → `0.2.1-rc.2` (pnpm lockfile advanced; peer floors unchanged — pre-flight `includePrerelease` already matches 0.2.1-rc.2), CI closure tower restored to newest-of(latest,next) with a prerelease-aware compare in both the test and smoke jobs (10-17 pin undone); verified against a 0.2.1-rc.2 closure: typecheck clean, 67/0 tests, contract-check pass, boot smoke pass.
- **Raise dsh host floor to 0.2.0-rc.2.** The peer-dependency floor is
  raised to `>=0.2.0-rc.2` (dsh-agent / dsh-commands / dsh-llm /
  dsh-user-questions) and the devDependencies are pinned to `0.2.0-rc.2`,
  lockfile re-resolved against registry.npmjs.org; `@deepseek-ai/cordis`
  stays at `^4.0.4`. Zero source changes — 0.2.0 is a digestion wave with
  no compile-level breaks (tests 66 pass / 0 fail).
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

## [0.1.0] - 2026-09-12

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
