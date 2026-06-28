## What & why

<!-- One logical change — a feature, a bugfix, or an experiment. What does it do, and why? -->

## Checklist
- [ ] **One focused change** (not a grab-bag), on a short-lived branch
- [ ] **Conventional Commit** title (`feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `test:`, `perf:`, `build:`, `ci:`)
- [ ] Local gates pass: `pnpm test && pnpm typecheck && pnpm biome ci .`
- [ ] Money/security paths still clean: `pnpm guardrails`
- [ ] No secrets committed; prod migrations recorded if schema changed
- [ ] Branch is **up to date with `main`**

<!-- Auto-merge: once CI is green this PR merges itself (no reviewer required).
     Set it with `gh pr merge --auto --squash`, or the "Enable auto-merge" button. -->
