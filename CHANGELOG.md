# Changelog

All notable changes to this catalog are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). The current version lives in `version.json`.

## [Unreleased]

## [0.0.4] - 2026-10-31

### Changed

- Target moved to Three.js 0.187.0 (r187). Every `three/tsl`, `three/webgpu` and
  `three/addons` import in the shipped scripts and in the SKILL.md snippets resolves against
  0.187.0; none of the r187 migration items (custom light registration, PMREM on cube render
  targets, struct storage buffers as arrays, `pixelationPass` size, iridescence thickness
  range) is used by any skill. The PMREM `fromScene` call in `photo-sky` is unchanged.
- `ocean-water`: the nested-pass pitfall now says that r187 shares node builds across call
  depths (three.js #35014), so the first-sight stall it describes is mostly gone; the
  top-level mirror pass stays as the layout the kit is built around.

## [0.0.3] - 2026-10-30

### Added

- One-line install for every skills-aware agent (Cursor, Codex, Copilot, Claude Code and
  others) at the top of the README Quick Start:
  `npx skills@latest add wolffe/three.js-skills`, with the skills.sh listing.

### Fixed

- `character-input` and `pipes` were missing from `npx skills add` installs and from the
  skills.sh listing: their `description` contained an unquoted `: `, which is not valid
  YAML. The values are now quoted, so all 26 skills install.

## [0.0.2] - 2026-10-28

### Added

- `pipes` ships `scripts/procedural-models.js`, the library `pipe-rack.js` registers with,
  so the kit runs as shipped.
- `threejs-director`, a router skill that reads a request, picks the specialist skills
  and fixes their order.
- Claude Code plugin manifest and self-hosted marketplace in `.claude-plugin/`, so the
  catalog installs with `/plugin marketplace add wolffe/three.js-skills`.
- Quick Start, Usage Patterns, Workflow Pipelines, Project Structure and Documentation
  sections in the README.
- `SKILLS_GUIDE.md` with the catalog tree and decision trees; `CONTRIBUTING.md`.
- `scripts/sync-skills.mjs`, which mirrors `skills/` into the folders Claude Code, Cursor
  and Codex read when the repo is opened directly; the mirrors are generated and
  ignored by git. A Claude Code hook and a pre-commit hook run it on every change.
- `scripts/validate-skills.mjs` and a GitHub Actions workflow that runs it on push.

### Changed

- Skills are grouped into category folders, `skills/<category>/<name>/` (`orchestration`,
  `materials`, `geometry`, `environments`, `character`, `outdoor`, `physics`); shipped
  source files moved into each skill's `scripts/` folder and `make-atlas.md` into
  `card-grass/references/`, so the layout matches the contributing rules of
  awesome-gamedev-agent-skills. The copy commands and the mirrors drop the category
  level, so an installed skill's folder name is unchanged.
- `megacity` and `station-maglev` trimmed under 500 lines; formatting only, no
  measurement or rule changed.
- `convert-sky.mjs` answers `--help`.
- `scripts/validate-skills.mjs` also enforces the upstream rules: the 500-line limit, the
  allowed skill-folder entries, front matter limited to `name` and `description` with
  their length and character limits, resolving `scripts/`, `references/` and `assets/`
  paths and markdown links, and the skill lists in the plugin manifests.
- `.claude-plugin/plugin.json` and `marketplace.json` list every skill folder explicitly.

## [0.0.1] - 2026-10-26

### Added

- Initial catalog of 25 skills in `skills/`, merged from three separate collections:
  materials, geometry and environments; the character kit; and the outdoor kits
  (sky and weather, ground cover, water, terrain shading, physics).
- Merged root `README.md` with one table per category.
- Social preview image in `_assets/`.
