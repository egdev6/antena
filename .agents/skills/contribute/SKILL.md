---
name: contribute
description: "Trigger: contribute to antena, contribuir a antena, work on an issue, what can I work on, resume a PR. Picks free work from the open issues, claims it on explicit start and delivers a small tested PR."
license: MIT
metadata:
  author: egdev6
  version: "2.0"
---

## Activation Contract

Activate to work on `egdev6/antena`. Read [docs/estado.md](../../../docs/estado.md) and
[CONTRIBUTING](../../../CONTRIBUTING.md) first. Pass `--repo egdev6/antena` to every GitHub command.

## Hard Rules

- The open issues are the plan. `docs/estado.md` is the current state; there is no roadmap index.
- Recommend only open issues without assignees and without an open PR covering them. Show the
  contributor's own assigned work separately as resumable.
- Assign only when the contributor explicitly starts an issue: `gh issue edit N --add-assignee LOGIN`,
  then read it back. Never remove or replace other assignees.
- One issue = one small PR with its test (or a structural check for docs). Use `Closes #N` when the
  PR completes the issue, `Refs #N` otherwise, and exactly one `type:*` label.
- Run the checks that apply (`pnpm test`, `pnpm baseline`) and report only what ran, on which
  platform. Linux results never prove Windows.
- Never use real Twitch, YouTube, Meld, OBS or Stream Deck accounts or hardware without an
  explicit, separate authorization. Use synthetic data.
- Commit, push, PR and merge each need the contributor's or maintainer's authorization.

## Steps

1. List open issues and open PRs; recommend free work, smallest useful first.
2. On explicit start, assign and read back; stop and coordinate if someone else appears.
3. Implement with a test first when a deterministic test applies; keep the diff small.
4. Open the PR with the [template](../../../.github/pull_request_template.md), assign it to the
   contributor and report checks, limits and the next step. An open PR is not integration.
