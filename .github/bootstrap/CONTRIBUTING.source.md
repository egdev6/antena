# Contributing

## Scope and manual review

Read the issue and related PRs first. The current project state, known
limits and the real-world test checklist live in [docs/estado.md](docs/estado.md).
Existing PRs and worktrees may already cover the work: coordinate before starting.
New bug/feature forms enter `status:needs-review`; review remains manual.
The maintainer decides scope and applies `status:approved` explicitly.
Coordinate ownership before using `status:in-progress`; labels do not grant
permission for live accounts, hardware, remote delivery or integration.
No workflow automatically approves, assigns or advances issues.

## Development and checks

Preserve Node >=24, the current ESM/vanilla stack and zero runtime dependencies.
Keep relevant tests and documentation with each reviewable change.
Use test-first development when a meaningful deterministic test applies;
for passive documentation/configuration, record structural checks without fake RED.
Declared checks are `pnpm test` and `pnpm baseline`; record what actually ran.
Baseline CI covers Linux/Windows with Node 24 and browser checks, with its
existing skip policy. New security checks do not replace this functional matrix.
Baseline (Linux and Windows; Windows is required since #83), Rust (`cargo test` of the
desktop app on Windows), Code safety (Semgrep and zizmor) and Secrets scan (gitleaks) run on
every pull request and on every push to main.
Every PR still reports the local checks it ran.
Report security issues privately as described in [SECURITY.md](SECURITY.md), never in a public issue.
Use synthetic data for ordinary tests; report unverified live/platform behavior.
Do not paste credentials, private paths or unsanitized configuration into reports.

## Pull requests and operational boundaries

Link the approved issue and select exactly one existing `type:*` label.
Use `Refs #N` for partial delivery and `Closes #N` only for complete accepted scope.
A merged PR alone does not establish hardware or live streaming acceptance.
Record focused checks, CI results, limitations and remaining dependencies.
Push, PR creation, merge, tags and releases require their own explicit permission.
Real Twitch/YouTube/Meld/OBS actions and account or hardware checks need a
separately agreed target, operation and authorization; never infer them from labels.
Code safety analyzes JS/TS and workflows; Gitleaks scans for secret patterns.
Neither passing check is a universal security or prompt-injection guarantee.
No contributor is required to use Pi or any particular coding assistant.

## Contribution skill

Assistants can follow the local [contribute skill](.agents/skills/contribute/SKILL.md):
open issues are the plan, [docs/estado.md](docs/estado.md) is the current state, and each
issue is delivered as one small tested PR. No contributor is required to use it.
