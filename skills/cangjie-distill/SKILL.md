---
name: cangjie-distill
description: Distill books, PDFs, EPUB/TXT/Markdown files, long articles, subtitles/transcripts, podcasts, courses, interviews, or long-form videos into audited executable Agent Skills. Use when the user says “蒸馏资料”, “蒸馏一本书”, “把这个 PDF/视频/播客/课程做成 Skills”, “拆书”, “把资料变成可复用 Skill”, or asks to turn long-form source material into reusable methods rather than a summary. Not for ordinary summarization, book reviews, or role-playing as an author.
---

# Cangjie Distill for DevSpace

Turn long-form source material into reusable Agent Skills that DevSpace can discover on later workspace opens.

This is a DevSpace-native adaptation of `kangarooking/cangjie-skill`. Keep the upstream method recognizable, but adapt execution to DevSpace primitives, local skill discovery, and optional DevSpace subagents.

## User-facing invocation

Treat these as equivalent explicit invocations:

```text
蒸馏资料 <path-or-url>
把 <path-or-url> 蒸馏成 Skills
蒸馏这本书 <path>
把这个视频/播客/课程蒸馏成 Skills <url-or-transcript>
```

The user should not need to remember slash commands or internal stages.

## Defaults

- Run in **autopilot mode** unless the user explicitly asks for review checkpoints.
- Do not stop for routine confirmations between stages. Only ask when a missing input makes correct execution impossible or when a destructive/credential-sensitive action would be required.
- Never invent source text from model memory.
- Never auto-install packages, CLIs, browser extensions, repositories, or system dependencies. Prefer already available tools and Skills. If a required extractor is missing, report the exact missing capability and the smallest next action.
- Never overwrite an existing installed Skill directory. Reuse identical content or create a deterministic suffixed name.
- Preserve provenance and rejected candidates so the distillation is auditable.

Read these references when needed:

- `references/ingestion.md` — how to normalize local files, webpages, transcripts, and long-video sources.
- `references/cangjie-method.md` — the adapted RIA-TV++ extraction and validation process.
- `references/output-contract.md` — output layout, installation rules, naming, and completion checks.
- `references/upstream.md` — upstream source and attribution.

## High-level workflow

1. **Resolve the source** into trustworthy text and metadata.
2. **Create an audit workspace** under `~/.devspace/distill/<source-slug>/`.
3. **Understand the whole source** before extracting methods.
4. **Extract five evidence streams**: frameworks, principles, cases, counterexamples, glossary.
5. **Triple-verify** every candidate for evidence, transferability, and non-triviality.
6. **Construct RIA++ Skills** only from verified units.
7. **Link related Skills** and build an index/glossary.
8. **Pressure-test triggers** with positive, negative, sibling-confusion, and boundary prompts.
9. **Install only passing Skills** into `~/.devspace/skills/`.
10. **Verify the install** and report what was created, rejected, and where the audit package lives.

## Stage 0 — source resolution and whole-source understanding

Follow `references/ingestion.md` first.

Create a source manifest containing at least:

```yaml
source_type: book|pdf|article|video|podcast|course|transcript|other
title: <title>
author: <author/uploader/speaker if known>
published_at: <date if known>
source_location: <path-or-url>
text_location: <normalized local text path>
```

Then read enough of the complete source to build `BOOK_OVERVIEW.md` with:

- central thesis
- structural outline
- key terminology
- strongest claims
- internal tensions / limitations
- situations where the material is likely useful

For very large sources, chunk by semantic boundaries. Keep chapter/page/time-range provenance in notes so later Skills can point back to evidence.

## Stage 1 — five-stream extraction

Extract these independently:

1. frameworks / decision models
2. principles / rules / checklists
3. cases where the author actually applies a method
4. counterexamples / failure modes / warnings
5. glossary / domain concepts

If DevSpace subagents are available and the user permits delegation, prefer five bounded workers in parallel. Otherwise run the same five passes serially. Do not silently invent parallelism.

Each candidate must include:

- concise name
- source location (chapter/page/time range when available)
- evidence summary
- candidate trigger situation
- possible neighboring/overlapping candidates

Write the raw passes to `candidates/` before filtering.

## Stage 1.5 — triple verification

Use the detailed rules in `references/cangjie-method.md`.

Reject candidates that fail any required gate. Keep rejected items and reasons under `rejected/`.

Autopilot behavior: continue automatically after filtering and record the accepted/rejected inventory. If the user asked for review checkpoints, present only the compact candidate titles and counts before Stage 2.

## Stage 2 — build executable Skills

Each passing Skill must contain:

- `name` and trigger-rich `description`
- **Reading** — short evidence excerpts or paraphrased provenance pointers
- **Interpretation** — the method in original words
- **Past Application** — source-backed example when available
- **Future Trigger** — when the agent should invoke it
- **Execution** — concrete ordered steps
- **Boundary** — when not to use it and common misuse
- **Related Skills** — added/finalized after linking

Avoid making the Skill a disguised summary. A useful Skill changes what an agent does in a real task.

## Stage 3 — connect the Skill set

Build:

- `INDEX.md` — all Skills, purpose, trigger, relationship graph
- `GLOSSARY.md` — shared terms
- cross-links for dependency, contrast, and combination relationships

Prefer several narrow Skills over one giant Skill when their triggers are meaningfully different.

## Stage 4 — pressure testing

For every Skill create `test-prompts.json` with at least:

- 3 prompts where the Skill should trigger
- 2 prompts where it should not trigger
- 1 sibling-confusion prompt that should trigger a different Skill from the same source
- 1 ambiguous/boundary prompt

If independent subagents are available, use a blind evaluator. Otherwise perform a separate evaluation pass and write the limitations into `test-results.md`.

Do not “fix” failed tests only by changing expected answers. Improve the Skill trigger/boundary/execution contract and rerun the relevant tests.

Install only Skills that pass the acceptance rules in `references/output-contract.md`.

## Stage 5 — install and register

The DevSpace user Skill root is:

```text
~/.devspace/skills/
```

Install each passing Skill as a direct child so DevSpace discovery can see it:

```text
~/.devspace/skills/<source-slug>--<skill-slug>/SKILL.md
```

Keep the full audit package separate under:

```text
~/.devspace/distill/<source-slug>/
```

Do not place the whole source package under the Skill root; only install the executable Skill directories.

After installation, verify on disk that every installed directory contains a valid `SKILL.md` with `name` + `description`. Explain that an already-open workspace may have a snapshot of the previous Skill catalog; a fresh workspace open is the reliable verification point.

## Completion report

Keep the final report compact and operational:

```text
蒸馏完成
来源: <title>
通过: <N> Skills
淘汰: <M> candidates
安装目录: ~/.devspace/skills/
审计目录: ~/.devspace/distill/<source-slug>/
代表 Skills: <3-6 names>
验证: <what was actually checked>
```

If a stage could not be verified, say exactly which stage and why. Do not claim the pipeline is complete when extraction or registration was only inferred.
