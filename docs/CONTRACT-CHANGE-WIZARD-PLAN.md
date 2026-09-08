# Contract-change wizard — reason, increase, benefits, re-sign package, access

> **Status:** decisions confirmed 2026-09-08 (owner interview, one question at a time). Slice 1
> (migration 47 with every column, wizard Reason → Terms → Review, reason label in the admin
> history / portal / send email) shipped 2026-09-08. Slice 2 (Increase step owning the rate,
> `change_detail.increase` + the history line, early pricing as an in-memory overlay of sent /
> signed versions on the `rates` rows at Calculate's one rate read — send and void rebuild the
> worker's open drafts so it holds straight away — and the overpayment note on
> `change_detail.overpayment` when a void follows pay) shipped 2026-09-08. Slice 3 (Package step
> with Request a document; send supersedes the ticked signatures and stamps `resign_due_on`; the
> portal signs the contract then each agreement in order through the same modal, filed under the
> version number; `syncPackageHolds` in the payroll service stamps `payments.hold_*` after every
> draft build and on every package state change, lifts on its own or by hand with a logged note;
> the Wise batch, Mark paid and the Process page refuse a held row; the three warnings — send
> email, portal card, one reminder at due − 3 from the hiring-review cron slot; rehire blocks
> countersign; void restores an un-re-signed superseded signature) shipped 2026-09-08. Slices 4–5
> in §6 not started.
> **Builds on:** [Contract versions plan](./CONTRACT-VERSIONS-PLAN.md) — every decision there
> stands unless §0 below says otherwise (only decision 5's "rate is written at countersign" gains
> the early-pricing exception in §0.5).

---

## 0. Decisions (confirmed)

**The wizard**

1. **Replaces the New contract modal.** Every version goes through the wizard; the old form is
   its Terms step, prefilled from the contract of record exactly as today.
2. **Reason is required:** `annual_review`, `cola`, `role_change`, `rehire`, `terms_change`,
   `other` (note required). Saved on the version (`change_reason`, `change_note`), shown in the
   admin history and the audit log; **label only** on the portal Contracts tab and in the send
   email, never the note. The reason **sets defaults and never skips a step**: Annual Review /
   COLA land on the increase step with percent selected; Role or Title Change on position;
   Rehire pre-ticks the whole re-sign package + access and requires a new start date; Change in
   Terms / Other open the Terms step plain.
3. **Review is the last step:** old vs new terms side by side with the change highlighted,
   benefits, the re-sign package with its due date, the access line. Two buttons: **Save draft**
   and **Send for signature**. Reopening a draft re-enters the wizard at Review with everything
   editable. Permissions unchanged (countersign gate on draft / send / void / countersign).

**Money**

4. **Increase step:** base = the contract of record's rate; if the live `rates` row differs, show
   both and let the admin pick the base. Methods: **percent**, **flat peso**, **exact**, all on
   the semi-monthly figure, monthly equivalent shown beside it. Percent rounds to the **nearest
   peso**. The version stores only the resulting `rate_php`; method and amount go in
   `change_detail` so history reads "Annual Review · +5% · 8,000 → 8,400".
5. **Early pricing, any direction.** When a version is **sent** and its `effective_from` falls in
   or before the period currently due, Calculate prices that period at the new rate straight
   away (status `sent` or `signed`), the draft row reading "at new rate, contract pending
   signature". Decreases too — owner's call. Countersign still writes the `rates` row; the
   backpay quote then finds nothing owed. A **void after payment** leaves an **overpayment note**
   on the profile with the amount; **no automatic clawback**.

**Benefits and PTO**

6. **Four benefit terms on the version**, prefilled from the worker, written to the worker at
   countersign as part of the one unit: health allowance (bool), 13th month (bool), **holiday
   pay** (bool, new), **PTO days per year** (int, new, default 12). **Silent in the document** —
   no template token. **Records only:** Calculate's treatment of holidays and PTO is untouched.
   Lunch and bonus stay per-payment amounts, not entitlements.
7. **PTO accrual (reference only):** accrued = 12 × approved tracked hours (excluding PTO) ÷
   2,080, capped at the contract's days per year; used = PTO seconds from the Hubstaff sync ÷ 8;
   **running balance carries over** year to year with a **ceiling of 30 days**. Full-time year =
   2,080 h; one PTO day = 8 h. Part-timers use the same formula and simply reach less.

**Re-sign package and holds**

8. **Package:** non-compete, NDA, BAA as checkboxes (all pre-ticked for Rehire, blank otherwise);
   uploads use the existing Request a document. Saved on the version (`resign_kinds`). On send,
   each ticked agreement's current signature is marked `superseded` (evidence row kept). The
   portal signs **the contract first, then each agreement in order**, through the same
   SignModal.
9. **Working contractor: countersign is never blocked.** The pay period containing the send date
   always pays. The **following** period is **held** while anything in the package is unsigned;
   the due date shown everywhere is that period's last day. Owner's example: sent 8 Sep → the
   1–15 Sep payroll processes regardless; the 16–30 Sep payroll is withheld if still incomplete;
   due date 30 Sep. The hold **lifts on its own** when the last item is signed (hours were
   approved all along, nothing recomputed), or **by hand with a logged reason**.
10. **Warning in three places**, each naming the date and the consequence ("Sign by 30 September.
    If it is not done, your pay for 16–30 September will be delayed until it is."): the send
    email; the portal "ready to sign" card, which stays as a banner after the contract itself is
    signed while agreements remain; one **automatic reminder three days before the due date**
    (existing Remind template, no new cron — ride the hiring-review slot), plus manual Remind.
11. **Rehire:** package **blocks countersign** (nobody is waiting on pay); new start date
    required; `effective_from` defaults to it; terms and benefits prefill from the ended
    engagement's last contract; documents on file stay on file, but expired / expiring ones are
    listed so Request a document can be ticked there.

**Access**

12. **No opt-out** from send's login guarantee. The access step is a confirmation screen built
    from `getPortalAccess()` (status, login email, last sign-in) plus one line saying what Send
    will do. The **email is editable there** and the edit updates both the login and the worker.

**Delivery**

13. Five PR slices (§6), merged one at a time, stop-and-report after each.

Assumed without asking (owner may override): one version in flight per engagement stays; the
manual hold-lift is countersign-gated; the reminder goes only to contractors with a portal
login (the others get Onboard Current, as today); "approved tracked hours" for PTO accrual means
`approval = 'approved'` entries of the employer company.

---

## 1. Schema (one additive migration, `00000000000047_contract_change_wizard.sql`)

`contract_versions`
- `change_reason text` CHECK in (`annual_review`,`cola`,`role_change`,`rehire`,`terms_change`,`other`), nullable (legacy rows).
- `change_note text`.
- `change_detail jsonb` — `{ "increase": { "method": "percent"|"flat"|"exact", "value": 5, "from": 8000, "to": 8400, "base": "record"|"live" } }`.
- `health_allowance boolean`, `thirteenth_month boolean`, `holiday_pay boolean`, `pto_days_per_year int` — null on legacy rows = "unchanged".
- `resign_kinds agreement_kind[] not null default '{}'`, `resign_due_on date`.

`workers`
- `holiday_pay_eligible boolean not null default false`, `pto_days_per_year int not null default 12`.

`payments`
- `hold_reason text`, `held_at timestamptz`, `hold_lifted_at timestamptz`, `hold_lifted_by text`, `hold_lifted_note text`.

`onboarding_signatures` — no change (`superseded` already exists in `signature_status`).

## 2. Reads / pure logic

- `contractOfRecord` gains the four benefit terms (null → worker's current flags).
- `src/lib/pay/pto.ts` — pure: `ptoAccrual({ trackedSecondsByYear, ptoSecondsByYear, capDays })` → running balance with carry-over and the 30-day ceiling; unit-tested.
- `src/lib/contracts/package.ts` — pure: `resignDueOn(sentOn)` = last day of the period after the one containing `sentOn`; `packageOutstanding(version, signatures)`; `holdFor(period, version, signatures)`; unit-tested against the owner's 8 Sep example.
- Early pricing seam: wherever Calculate resolves a worker's period rate (find the one call site behind `reconcilePeriod` / rate lookup), consult a pending version (`sent`/`signed`, `effective_from <= period_end`) first. One seam, one test.

## 3. Actions

- `draftContractVersion` / `DraftContractVersionSchema`: + reason, note, change_detail, benefits, resign_kinds.
- `sendContractVersion`: + supersede the ticked signatures, set `resign_due_on`, email with the warning line and reason label, then the existing login guarantee.
- `countersignContractVersion`: + write the four benefit terms to the worker; **refuse** while the package is outstanding **only for `change_reason = 'rehire'`**.
- `signAgreement` (portal): allow a re-sign when the worker's current signature for that kind is `superseded` and a sent/signed version lists the kind; enforce order (contract first).
- `liftPaymentHold({ paymentId, note })` — countersign-gated, audited.
- Calculate build (`reconcilePeriod`): stamp `hold_reason` on the draft when `holdFor()` says so; never put a held draft on the Wise batch; clear the hold when the package completes.
- `updatePortalEmail({ workerId, email })` for the access step (auth + `contractor_logins.email` + `workers.email`).

## 4. UI

- `ContractWizard` (replaces the modal in `ContractsTab`): Reason → Terms → Increase → Benefits → Package → Access → Review.
- Portal Contracts tab: package card in signing order with the due-date warning; banner while agreements remain.
- Calculate: red "Held: NDA, BAA unsigned · due 30 Sep" badge with Lift; Overview and Onboarding queues count held drafts.
- Profile: PTO card (accrued / used / balance); reason label in the Contracts history.
- Admin Contracts history: "v5 · Annual Review · +5% · 8,000 → 8,400".

## 5. Emails

- Send email: + reason label + warning line (when a package exists).
- Automatic reminder: existing `owed_reminder` template, sent once at `resign_due_on − 3` from the hiring-review cron slot.

## 6. PR slices (each commit-clean; stop and report after each)

1. **Wizard shell + reason.** Migration 47 (all columns), wizard with Reason / Terms / Review, Save draft + Send from Review, reason label in history, portal, send email.
2. **Increase + early pricing.** Increase step; pending-version rate at the Calculate seam, either direction; overpayment note on void.
3. **Package + holds.** Checkboxes + Request a document; superseded signatures; ordered portal signing; due date + three warnings; hold from the following period + manual lift; rehire blocks countersign.
4. **Benefits + PTO.** Four terms written through at countersign; worker fields; accrual / balance on profile and pay tab.
5. **Access step + rehire polish.** Confirmation screen with editable email; rehire prefill and start-date default; expiring documents offered for request.

## 7. Out of scope (decided)

- Pay-engine use of holiday pay or the PTO entitlement; PTO proration; benefits in the document; automatic clawback; a contractor decline; the legacy portal.
