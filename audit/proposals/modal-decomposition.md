# Plan — heavy-modal decomposition

**Status:** plan for review · **Audit ref:** 02-ux (interaction-design: heavy forms → routes)

## Targets (evidence)

| Modal | Lines | Opened from | Data in | Reports out |
|---|---|---|---|---|
| `contractors/ProfilePanel.tsx` | 1353 | `ContractorsClient` `setSelectedWorker(r)` | `worker: RosterWorker` (already in the roster list) | `onSaved(updated)` → parent updates its row |
| `onboarding/OnboardingDrilldown.tsx` | 1293 | `OnboardingClient` `setDrillWorker(row)` | `OnboardingProgressRow` (already loaded) | `onClose` + refresh |

Both receive a **fully-loaded row object** (no fetch-on-open) and live as overlay modals. ProfilePanel is 4 fat tabs — profile (≈515), pay & payout (≈699), personal/HR (≈883), portal & login (≈1168) — plus handlers (`handleSave`, `handleAssign`, `runLogin`, `handlePhoto`) and actions from `@/server/actions/contractors` + `createPortalLogin`.

## The two separable improvements (this is the key framing)

1. **Component decomposition** — split each 1300-line file into a thin shell + per-tab panel components. Pure refactor, **no behavior/UX change, low risk**. Delivers the maintainability win on its own.
2. **Modal → route** — make each a real page (`/contractors/[workerId]`, `/onboarding/[workerId]`). Enables deep-linking + browser back/forward, but changes data-flow (prop → server fetch, `onSaved` → revalidate) and the UX (overlay → full-page). **Higher risk + a UX-preference call.**

They can be done independently. (1) is the bigger maintainability payoff for the lower risk; (2) is the IA change the audit named but is more invasive.

## Recommended sequencing — ProfilePanel first as the template

### Phase A — decompose ProfilePanel into panels (no behavior change)
1. Extract a shared form-state hook `useProfileForm(worker)` (the `form`/`errors`/dirty state + `handleSave`).
2. Extract each tab into its own file: `ProfileTab`, `PayTab`, `PersonalTab`, `PortalLoginTab` — each takes the form-state hook's API + the relevant actions via props. The `Field` helper moves to a shared `ProfileField` (or `ui`).
3. `ProfilePanel` becomes a thin shell: `<Modal>` + `useTablist` tabs + render the active panel. Target ≈150 lines.
4. **Verify:** typecheck · biome · existing tests · build, and a manual pass of all four tabs + save + login. No new routes, no data-flow change — fully reversible.
   *Est: 2–3 commits.*

### Phase B — promote ProfilePanel to a route (`/contractors/[workerId]`)
1. New query `fetchRosterWorkerById(db, companyId, workerId)` (mirror `fetchRoster`'s select, filtered by id) → `RosterWorker | null`.
2. New route `app/(admin)/contractors/[workerId]/page.tsx`: auth → `getSelectedCompanyId` → fetch → render the extracted panels as a **page** (no `<Modal>`), with a "← Contractors" back link.
3. Data-flow swap: `onSaved(updated)` → `router.refresh()` (server re-fetch); unsaved-guard (`useUnsavedGuard`, already route-aware) now guards navigation away — no change needed.
4. `ContractorsClient`: row click → `<Link href={'/contractors/'+id}>` / `router.push`, and **delete** the in-page `<ProfilePanel>` modal mount.
5. **Verify:** deep-link to a worker loads; save persists + reflects on refresh; back returns to the list; unsaved-guard fires on nav. Keep the modal component deletable only after the route is proven.
   *Est: 2 commits.*

### Phase C — repeat for OnboardingDrilldown → `/onboarding/[workerId]`
Same two-step (decompose, then route). It pulls from more action modules (`onboarding` + `portal` + `portal-admin`), so the decompose step is worth more here. *Est: 3–4 commits.*

**Total: ≈8–11 commits**, each independently gate-green and mergeable.

## Risks & mitigations
- **Behavior drift in a 1300-line form** → Phase A is a pure extraction (move code, don't rewrite); diff-review each panel; the existing suite + a manual tab pass guard it.
- **Data-flow change (B)** → the modal mutated parent state; the route re-fetches. Risk: a save that doesn't revalidate looks stale. Mitigate with `revalidatePath('/contractors/[workerId]')` in the save action + `router.refresh()`.
- **Lost context / UX regression** → a full page replaces the in-list overlay. If the team values the stay-in-list feel, stop after Phase A (decompose only) and skip B/C.
- **Unsaved guard** → already wired for route nav (audit-confirmed), so it transfers; verify explicitly.

## Decision points (need your call before I start)
1. **Depth:** Phase A only (decompose, low-risk, keep modals), or A+B+C (full route migration)?
2. **UX:** is replacing the in-list overlay with a full page desirable, or do you prefer keeping the modal feel (→ Phase A only)?
3. **Scope:** both modals, or ProfilePanel only to start?
