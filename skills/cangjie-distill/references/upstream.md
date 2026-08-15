# Upstream attribution

This DevSpace Skill is adapted from:

- Project: `kangarooking/cangjie-skill`
- Upstream commit inspected during adaptation: `149cb39f559cafcb82910f8662b3f4e3b9ee5574`
- Upstream license: MIT
- Core method retained conceptually: whole-source understanding → five-stream extraction → triple verification → RIA++ Skill construction → linking → pressure testing → delivery

The DevSpace adaptation intentionally changes orchestration details:

- natural-language trigger `蒸馏资料`
- DevSpace Skill discovery/install target `~/.devspace/skills/`
- audit packages under `~/.devspace/distill/`
- optional use of DevSpace bounded subagents
- autopilot-by-default flow with optional review checkpoints
- explicit no-auto-install policy for missing extraction/transcription dependencies
- direct-child Skill installation to match DevSpace discovery behavior

When the upstream method evolves materially, compare the upstream `SKILL.md`, methodology documents, extractor prompts, and test format before updating this adaptation.
