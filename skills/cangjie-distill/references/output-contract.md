# Output contract

## Audit package

Store the complete distillation under:

```text
~/.devspace/distill/<source-slug>/
```

Recommended layout:

```text
source/
  manifest.yaml
  normalized.txt
  source-notes.md
PIPELINE_STATE.md
BOOK_OVERVIEW.md
verified.md
INDEX.md
GLOSSARY.md
DIGEST.md
candidates/
  frameworks.md
  principles.md
  cases.md
  counterexamples.md
  glossary.md
rejected/
  <candidate>.md
skills/
  <skill-slug>/
    SKILL.md
    test-prompts.json
    test-results.md
```

`PIPELINE_STATE.md` is the resume point. Update it after every completed stage. On a repeated invocation for the same source, inspect it before restarting work.

## Installed DevSpace Skills

Install passing Skills as direct children of:

```text
~/.devspace/skills/
```

Use a source-prefixed directory name to reduce collisions:

```text
~/.devspace/skills/<source-slug>--<skill-slug>/
```

The `name` frontmatter value should normally match that directory name. Keep names lowercase with letters, digits, and hyphens.

Do not put `INDEX.md`, source transcripts, candidates, or rejected material in the global Skill root.

## Collision rules

Before installation:

1. If the target directory does not exist, install normally.
2. If it exists and content is functionally identical, reuse it and record `reused`.
3. If it exists with different content, do not overwrite. Use a deterministic suffix such as `-v2`, `-v3`, etc.
4. Never delete an existing Skill as part of distillation.

## Skill validity checks

A Skill is installable only when all are true:

- `SKILL.md` exists
- YAML frontmatter parses
- `name` is non-empty, lowercase/kebab-case, and matches the installed directory
- `description` states what the Skill does and when to trigger it
- R / I / A1 / A2 / E / B are all present, with A1 explicitly marked unavailable if the source has no real example
- evidence/provenance is recorded
- Boundary is non-empty
- `test-prompts.json` exists
- tests include positive, negative, sibling-confusion, and boundary cases
- `test-results.md` records actual evaluation status
- no known critical trigger-confusion failure remains

## Acceptance result states

Use one of:

- `passed` — installable and installed/reused
- `needs-rework` — method is useful but trigger/execution tests failed
- `rejected` — failed verification or is not a reusable method
- `blocked` — source extraction or evaluation capability was unavailable

Never call `needs-rework` or `blocked` Skills complete.

## Resume behavior

`PIPELINE_STATE.md` should record:

```text
source: <slug>
current_stage: <0-5>
source_ready: yes|no
overview_ready: yes|no
candidate_passes: <completed streams>
verified_count: <N>
rejected_count: <M>
skills_built: <N>
skills_passed: <N>
skills_installed: <N>
next_action: <concise action>
```

When resuming, verify existing artifacts before trusting the state file.

## Final verification

At the end:

1. List installed directories.
2. Check every installed `SKILL.md` frontmatter.
3. Confirm each installed Skill came from a passing audit entry.
4. Keep a manifest mapping installed Skill → audit Skill → source evidence.
5. Report whether verification was filesystem-only or also confirmed by opening a fresh DevSpace workspace and seeing the Skill in the discovered catalog.

An already-open workspace may have loaded its Skill catalog earlier. Do not infer runtime discovery from files alone.
