# Git & CI workflow

How changes get from a branch to production. The aim: **focused, short-lived
branches that merge back within days**, with CI — not a human reviewer — as the
gate, since this is effectively a solo repo.

## Branches
- **One logical change per branch** — a feature, a bugfix, an experiment. Not a grab-bag.
- Name it `feat/…`, `fix/…`, `chore/…`, `perf/…`, etc. (matches the Conventional Commit type).
- **Short-lived.** Merge within days, not weeks. The longer a branch lives, the more it
  diverges from `main` and the more painful the merge. The weekly *Stale PRs* job nudges
  anything idle 10+ days (label `keep`/`wip` to exempt).
- Never commit directly to `main` — branch protection blocks it (admins may bypass in a
  real emergency).

## Commits
- **Conventional Commits** are enforced by the `commit-msg` git hook
  (`feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `test:`, `perf:`, `build:`, `ci:`, `style:`).
- Local git hooks (lefthook) run automatically:
  - **pre-commit:** Biome (autofix) + typecheck on staged files.
  - **pre-push:** guardrails (money/security gate) + prod-migration check + typecheck + tests.
- Don't routinely `--no-verify`. CI re-runs the same gates anyway (below).

## Pull requests
- Open a PR for every change (`gh pr create`). Use the PR template's checklist.
- **CI** (`.github/workflows/ci.yml`) runs on the PR: Biome → typecheck → guardrails →
  tests → Next.js build. This is the **only required status check** (`checks`).
- **Auto-merge is the default.** With no required reviewers, enable auto-merge once and the
  PR merges itself the moment CI goes green — no manual click:
  ```bash
  gh pr merge --auto --squash --delete-branch
  ```
- Merges are **squash + delete branch**, and the branch must be **up to date with `main`**
  before merging (GitHub can update it for you). This serializes integration enough to
  catch "two green PRs that break when combined" without a full merge queue.

## Dependencies
- **Dependabot** opens weekly PRs (npm/pnpm + GitHub Actions), grouping low-risk bumps.
- **Patch & minor** bumps **auto-merge** after CI passes
  (`.github/workflows/dependabot-auto-merge.yml`). **Major** bumps stay manual.

## Deploy
- **No manual deploys.** Vercel auto-deploys from `main` (`abc-helper-app`, and the cutover
  host `abc-helper-3a`). Merging to `main` ships it.
- The `Vercel – abc-helper-3a` **preview** check can be red on PRs (its env is Production-only);
  that is **not** a required check and does **not** block merges. Its production deploys are fine.

## Upgrading later (optional)
- **Merge queue**: enable a GitHub merge queue (ruleset) to test each PR against the *current*
  `main` serially before merging. Requires a Team/Enterprise plan for private repos. The CI
  workflow already has the `merge_group:` trigger, so it's ready when you turn it on.
- **Required reviews**: if a second maintainer joins, add `CODEOWNERS` + a required approval.
