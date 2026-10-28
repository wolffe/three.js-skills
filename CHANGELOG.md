# Changelog

All notable changes to this catalog are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). The current version lives in `version.json`.

## [Unreleased]

### Added

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
