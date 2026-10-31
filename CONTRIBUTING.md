# Contributing

Thanks for helping. This catalog is a set of agent skills, each a folder at
`skills/<category>/<name>/` with a `SKILL.md` and, sometimes, a `scripts/` folder of
source files and a `references/` folder of longer material. The layout and the front
matter follow the
[contributing rules](https://github.com/gamedev-skills/awesome-gamedev-agent-skills/blob/main/CONTRIBUTING.md)
of awesome-gamedev-agent-skills, so a skill here can be submitted there unchanged;
`scripts/validate-skills.mjs` enforces them. Here is how to add or change one.

## Ground rules

- **Target.** Three.js 0.187.0, `three/webgpu` and `three/tsl`. WebGPU only: no WebGL
  fallback, no GLSL strings, no model files. A skill that needs something else says so
  in its first paragraph.
- **One skill, one subject.** A skill covers one material, one kind of geometry, one
  piece of a kit. If a subject needs two skills, the second is a child and the first
  names it.
- **Measurements over adjectives.** Say 2.1 m, not "tall enough". Every number should
  come from something that was built and looked at; say so when it was not.
- **Short code, run code.** Examples are short and written against 0.187.0. If an example
  has not been run, say that in the Notes. A shipped source file must at least pass a
  syntax check under Node, and the README says how far it was run.

## Adding a skill

1. Create `skills/<category>/<name>/SKILL.md`. The categories are `orchestration`,
   `materials`, `geometry`, `environments`, `lighting`, `character`, `outdoor` and `physics`. The
   name is lowercase letters, digits and single hyphens, 64 characters or fewer, and
   matches the folder. The front matter holds only `name` and `description`; the
   description is 1024 characters or fewer and contains no `<` or `>`.
2. Start with the front matter:

   ```markdown
   ---
   name: <name>
   description: <one sentence on what it makes, then "Use when ..." or "Use for ...", then "Ships <file>" if it ships one.>
   ---
   ```

   The description is what the model reads to decide whether to load the skill. Put
   the trigger words a user would actually type in it.
3. The first body line after the heading is the target line, copied from a sibling
   skill.
4. Structure the body the way the siblings do: what it is, how to think about it, the
   measurements, the code, what to avoid. Look at `glass` for a material, `pipes` for
   geometry, `card-grass` for a kit that ships source.
5. If the skill ships a source file, it lives in `scripts/` and imports only
   `three/webgpu`, `three/tsl` and, if it must, `jolt-physics`. Nothing reads global
   scene state; what only a project can supply comes in as a callback or an option. A
   helper that is run rather than imported answers `--help`. A skill folder holds only
   `SKILL.md`, `scripts/`, `references/`, `assets/` and `agents/`.
   Keep `SKILL.md` under 500 lines (the validator fails above that) and under about
   5,000 tokens, roughly 20 KB (the validator warns). Long catalogues and vocabularies
   go in `references/<topic>.md` with a one-paragraph pointer in the body, as
   `procedural-geometry` does; Claude Code, Cursor and Codex all read those on demand.
   Every `scripts/`, `references/` or `assets/` path named in the body must exist.
6. Add the skill to the matching table in `README.md`, to the tree and a decision tree
   in `SKILLS_GUIDE.md`, to the routing table in
   `skills/orchestration/threejs-director/SKILL.md`, and to the `skills` lists in
   `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`.
7. Run `node scripts/validate-skills.mjs`, then `node scripts/sync-skills.mjs` so the
   mirror folders for Cursor and Codex match.
8. Add a line under "Unreleased" in `CHANGELOG.md`. Do not change `version.json`; the
   maintainer bumps the version at release.

## Changing a skill

Keep the change surgical. A corrected measurement is a one-line change; a rewrite
needs a reason in the pull request. If a shipped file's exported interface changes,
say so in the changelog line, since that is a major bump.

## Pull requests

- One skill or one subject per pull request.
- The description says what was built or run to check the change.
- Run `node scripts/sync-skills.mjs` before pushing; the pull request should not
  change the mirrors by hand.
