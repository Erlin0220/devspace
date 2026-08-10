# Adapted Cangjie RIA-TV++ method

This reference condenses the upstream `cangjie-skill` workflow into a DevSpace-compatible execution contract.

## Stage 0 — whole-source understanding

Before extracting Skills, establish the complete source model:

1. **Structure** — sections, sequence, argument flow, repeated motifs.
2. **Interpretation** — central thesis, definitions, causal claims, decision rules.
3. **Critique** — assumptions, tensions, blind spots, evidence limits.
4. **Application** — situations where the source changes a real decision or action.

Write `BOOK_OVERVIEW.md` even when the source is not a book; retain the filename for compatibility with upstream Cangjie packages.

## Stage 1 — five independent extraction streams

### Frameworks

Find multi-step decision models, diagnostic trees, matrices, reusable mental models, and explicit procedures.

### Principles

Find rules, heuristics, checklists, thresholds, constraints, and recurring “do/don't” guidance.

### Cases

Find examples where the source author/speaker applies a method to a concrete situation. Prefer demonstrated use over illustrative anecdotes.

### Counterexamples

Find failure modes, warnings, invalid uses, exceptions, and situations where a superficially appealing method breaks.

### Glossary

Find domain terms whose meaning matters to execution. Do not turn every term into a Skill.

Keep extraction streams separate until candidate synthesis so one pass does not anchor the others.

## Stage 1.5 — triple verification

A candidate must pass all three gates unless the source is explicitly labeled partial and the limitation is documented.

### V1 — evidence support

Require at least two independent supporting passages/segments when the source offers them. If a method is stated only once, require unusually explicit procedural wording and mark the evidence as narrow.

Reject candidates that are mainly an inference by the distiller rather than a method grounded in the source.

### V2 — transfer / predictive power

The candidate should help answer or act on a plausible new situation that the source did not simply spell out verbatim.

A practical test:

> Can an agent use this candidate to choose, diagnose, sequence, evaluate, or avoid something in a new task?

If not, it is probably a fact, theme, quote, or summary point rather than a Skill.

### V3 — distinctiveness

Reject generic advice that a competent person would likely produce without this source. Preserve source-specific structure, thresholds, distinctions, or reasoning.

## Candidate synthesis

Merge duplicates only when their trigger and execution logic are materially the same. Keep separate Skills when the same source idea has different operational triggers.

For each accepted unit record:

- candidate name
- evidence locations
- trigger situation
- execution effect
- neighboring candidates
- V1/V2/V3 verdicts

## Stage 2 — RIA++ Skill construction

Each Skill must contain these elements.

### R — Reading

Use short evidence snippets or precise provenance pointers. Prefer paraphrase plus location over large quotations.

### I — Interpretation

State the method in compact original language. Capture the mechanism: why the method changes the decision, not just what the author believes.

### A1 — Past Application

Include a source-backed example when available. If the source supplies no genuine application, say so instead of inventing one.

### A2 — Future Trigger

Define the observable user/task conditions that should activate the Skill. This belongs in the frontmatter `description` as well as the body.

Good trigger descriptions mention:

- task shape
- decision/problem state
- signals that distinguish this Skill from siblings

Bad trigger descriptions only say “a Skill about X”.

### E — Execution

Provide an ordered, executable procedure. Prefer 3–7 steps, explicit inputs, intermediate checks, and a clear output/decision.

### B — Boundary

Define when not to use the Skill, common misuse, and source limitations. Use Stage 0 critique and Stage 1 counterexamples here.

## Stage 3 — linking

Classify cross-Skill relationships as:

- **depends-on** — A needs B first
- **contrasts-with** — A and B solve similar-looking but different problems
- **combines-with** — A + B form a useful sequence

Use links to sharpen trigger boundaries, not merely to create a dense graph.

## Stage 4 — pressure tests

Each Skill gets a compact evaluation set:

- positive triggers
- obvious negatives
- sibling-confusion negatives
- ambiguous/boundary cases

The evaluator should judge both **whether** the Skill triggers and **whether its execution procedure is appropriate**.

A passing Skill should have no critical false-positive trigger on sibling-confusion tests and no missing trigger on its canonical positive cases.

When a test fails, revise the Skill contract (description, Future Trigger, Execution, Boundary) and rerun. Do not rewrite the expected test result to make the Skill pass.

## Stage 5 — delivery

Create a human-facing `DIGEST.md` only after executable Skills exist. The digest summarizes the verified method set; it is not a substitute for the Skills.

Install only passing Skill directories into DevSpace's configured Skill root, while keeping candidates, rejected material, overview, glossary, tests, and source normalization in the audit package.
