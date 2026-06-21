# Audit Track 1 — Feature & Navigation Inventory

**App:** abc-helper-app — Next.js 16 App Router + React 19 + Supabase (@supabase/ssr). A payroll system: Hubstaff tracked time → semi-monthly PHP payroll → Wise draft-only payouts. Parallel rewrite of a legacy single-file SPA.

**Method:** Every claim below is cited to `file:line` (clickable) and labelled **OBSERVED** (present in code) or **INFERRED** / **ASSUMPTION**. Routes were enumerated by listing `src/app/`; modals/overlays by reading each client component. Two surfaces: the **admin app** (everything except `/portal`) and the **contractor portal** (`/portal/*`).

**Two landing screens** (for click-depth):
- **Admin landing** = `/overview` (root `/` redirects there — [page.tsx:5](src/app/page.tsx#L5)). OBSERVED.
- **Portal landing** = `/portal` (Home) — [PortalShell.tsx:28](src/components/portal/PortalShell.tsx#L28). OBSERVED.

---

## §1 — Admin surface

### 1.1 Admin routes (sidebar-reachable)

Sidebar nav is the single source of truth in [nav.ts:24-60](src/components/shell/nav.ts#L24) (`NAV_GROUPS`), rendered by [AdminShell.tsx:216-237](src/components/shell/AdminShell.tsx#L216). All admin pages share one gate pattern: `getCurrentAdmin()` → `redirect('/login')` if not an admin, then a "no company selected" empty-state card if no company is chosen. OBSERVED across every page below.

| Name (UI label) | File:line | User task | Reached via / click-depth | Role/state gating |
|---|---|---|---|---|
| **Overview** | [overview/page.tsx:59](src/app/(admin)/overview/page.tsx#L59) | Dashboard: payroll-cycle status, alerts, metrics needing attention | Sidebar "Home → Overview"; **landing (depth 0)**; also `/` redirect | admin auth ([:59-60](src/app/(admin)/overview/page.tsx#L59)); company-selected else empty card ([:62-70](src/app/(admin)/overview/page.tsx#L62)) |
| **Contractors** | [contractors/page.tsx:49](src/app/(admin)/contractors/page.tsx#L49) | Manage roster, rates, payout, portal logins | Sidebar "Manage Team → Contractors"; **depth 1**; ⌘K worker pick → `?focus=<id>` ([CommandPalette.tsx:117](src/components/shell/CommandPalette.tsx#L117)) | admin auth ([:14-15](src/app/(admin)/contractors/page.tsx#L14)); company guard ([:17-25](src/app/(admin)/contractors/page.tsx#L17)); `isOwner` passed to client ([:54](src/app/(admin)/contractors/page.tsx#L54)) |
| **Hiring & Onboarding** | [onboarding/page.tsx:39](src/app/(admin)/onboarding/page.tsx#L39) | Track hire/onboarding progress; countersign; manage agreement templates | Sidebar "Manage Team → Hiring & Onboarding"; **depth 1** | admin auth ([:15-16](src/app/(admin)/onboarding/page.tsx#L15)); company guard ([:18-26](src/app/(admin)/onboarding/page.tsx#L18)); `canCountersign` + `isOwner` to client ([:42-43](src/app/(admin)/onboarding/page.tsx#L42)) |
| **Documents** | [documents/page.tsx:47](src/app/(admin)/documents/page.tsx#L47) | Upload/review contractor documents | Sidebar "Manage Team → Documents"; **depth 1** | admin auth ([:15-16](src/app/(admin)/documents/page.tsx#L15)); company guard ([:18-26](src/app/(admin)/documents/page.tsx#L18)) |
| **Time & Approval** | [time/page.tsx:52](src/app/(admin)/time/page.tsx#L52) | Import (CSV/Hubstaff) + approve time for the pay period | Sidebar "Run payroll → Time & Approval"; **depth 1** | admin auth ([:19-20](src/app/(admin)/time/page.tsx#L19)); company guard ([:22-30](src/app/(admin)/time/page.tsx#L22)) |
| **Calculate** | [calculate/page.tsx:38](src/app/(admin)/calculate/page.tsx#L38) | Draft/recalc payroll for a period (renders `PayrollShell`) | Sidebar "Run payroll → Calculate"; **depth 1** | admin auth ([:18-19](src/app/(admin)/calculate/page.tsx#L18)); company guard ([:21-29](src/app/(admin)/calculate/page.tsx#L21)); `isOwner` to shell ([:40](src/app/(admin)/calculate/page.tsx#L40)) |
| **Process and Pay** | [process/page.tsx:42](src/app/(admin)/process/page.tsx#L42) | Send locked batches to payout; shows ready vs draft periods | Sidebar "Run payroll → Process and Pay"; **depth 1** | admin auth ([:14-15](src/app/(admin)/process/page.tsx#L14)); company guard ([:17-25](src/app/(admin)/process/page.tsx#L17)) |
| **Review & Recon Batches** | [batches/page.tsx:36](src/app/(admin)/batches/page.tsx#L36) | Reconcile locked/paid batches against Wise | Sidebar "Review → Review & Recon Batches"; **depth 1** | admin auth ([:18-19](src/app/(admin)/batches/page.tsx#L18)); company guard ([:21-29](src/app/(admin)/batches/page.tsx#L21)) |
| **Reports** | [reports/page.tsx:36](src/app/(admin)/reports/page.tsx#L36) | Data-quality reports (paid hours vs tracked time) | Sidebar "Review → Reports"; **depth 1** | admin auth ([:13-14](src/app/(admin)/reports/page.tsx#L13)); company guard ([:16-24](src/app/(admin)/reports/page.tsx#L16)); server-error card ([:27-34](src/app/(admin)/reports/page.tsx#L27)) |
| **Sessions** | [sessions/page.tsx:24](src/app/(admin)/sessions/page.tsx#L24) | View billable Early-Intervention sessions | Sidebar "Review → Sessions"; **depth 1** | admin auth ([:13-14](src/app/(admin)/sessions/page.tsx#L13)); **NO company guard** (OBSERVED — differs from peers) |
| **Invoicing** | [invoicing/page.tsx:28](src/app/(admin)/invoicing/page.tsx#L28) | Preview/generate client invoices | Sidebar "Review → Invoicing"; **depth 1** | admin auth ([:13-14](src/app/(admin)/invoicing/page.tsx#L13)); **NO company guard** (OBSERVED) |
| **Imports** | [imports/page.tsx:26](src/app/(admin)/imports/page.tsx#L26) | Delete previously imported data batches | Sidebar "Review → Imports"; **depth 1** | admin auth ([:10-11](src/app/(admin)/imports/page.tsx#L10)); company guard ([:13-21](src/app/(admin)/imports/page.tsx#L13)) |
| **Audit Log** | [audit/page.tsx:52](src/app/(admin)/audit/page.tsx#L52) | Paginated audit trail of all mutations | Sidebar "Review → Audit Log"; **depth 1**; deep-link `?page=` `?q=` | admin auth ([:18-19](src/app/(admin)/audit/page.tsx#L18)); company guard ([:21-29](src/app/(admin)/audit/page.tsx#L21)); reads `?page` ([:32](src/app/(admin)/audit/page.tsx#L32)) + `?q` ([:33](src/app/(admin)/audit/page.tsx#L33)) |
| **Configuration** | [config/page.tsx:48](src/app/(admin)/config/page.tsx#L48) | Employer/clients/Hubstaff/portal/agreements/onboarding/holidays + Wise recon | Sidebar "Configuration → Configuration"; **depth 1** | admin auth ([:18-19](src/app/(admin)/config/page.tsx#L18)); company guard ([:21-30](src/app/(admin)/config/page.tsx#L21)); `isOwner` to client ([:49](src/app/(admin)/config/page.tsx#L49)) |
| **Payroll** (`/payroll`) | [payroll/page.tsx:11](src/app/(admin)/payroll/page.tsx#L11) | Per-period pay batch — renders `PayrollShell` (same shell as Calculate) | **NOT in sidebar.** Reached only via ⌘K period pick → `?period=<start>` ([CommandPalette.tsx:118](src/components/shell/CommandPalette.tsx#L118)) and from Process links ([ProcessShell.tsx:125,133](src/components/process/ProcessShell.tsx#L125)). See §7. | admin auth ([:12-13](src/app/(admin)/payroll/page.tsx#L12)); company guard ([:15-23](src/app/(admin)/payroll/page.tsx#L15)); `isOwner` to shell ([:34](src/app/(admin)/payroll/page.tsx#L34)) |

> **Note — brief discrepancy (OBSERVED):** the task brief implied `/payroll` exists only as `[paymentId]/print`. There is also a real `/payroll` page ([payroll/page.tsx](src/app/(admin)/payroll/page.tsx)). It is functionally a duplicate of `/calculate` (both render `PayrollShell`) and is **absent from the sidebar** — see §7 Orphans.

> Each route also has a `loading.tsx` Suspense skeleton (e.g. [contractors/loading.tsx](src/app/(admin)/contractors/loading.tsx)) — a transient spinner card, not a distinct screen. OBSERVED. (`batches`, `sessions`, `invoicing` have no `loading.tsx`.)

### 1.2 Admin sub-modals / drawers / panels (by host screen)

| Modal / panel | File:line | Triggered by (host) | Gating / preconditions |
|---|---|---|---|
| **Profile panel** (contractor drawer, 4 tabs: Profile / Pay & payout / Personal-HR / Portal & login) | [ProfilePanel.tsx:466](src/components/contractors/ProfilePanel.tsx#L466) | Row click / "Edit" in Contractors table ([ContractorsClient.tsx:293-305](src/components/contractors/ContractorsClient.tsx#L293)); deep-link `?focus=<id>` | Wraps Modal; `RateCard` lives in Pay tab ([:738](src/components/contractors/ProfilePanel.tsx#L738)) |
| ↳ **Unsaved-changes confirm** | [ProfilePanel.tsx:1224](src/components/contractors/ProfilePanel.tsx#L1224) | Closing panel while dirty ([:187](src/components/contractors/ProfilePanel.tsx#L187)) | dirty flag ([:183](src/components/contractors/ProfilePanel.tsx#L183)); also `useUnsavedGuard` ([ProfilePanel.tsx:4](src/components/contractors/ProfilePanel.tsx#L4)) |
| **Add-contractor wizard** (3 steps: Identity / Engagement / Portal & onboarding) | [AddContractorWizard.tsx:115](src/components/contractors/AddContractorWizard.tsx#L115) | "+ Add contractor" in Contractors ([ContractorsClient.tsx:266](src/components/contractors/ContractorsClient.tsx#L266)) AND "+ Hire new contractor" in Onboarding ([OnboardingClient.tsx:195](src/components/onboarding/OnboardingClient.tsx#L195)) | "Hire" disabled if consolidated ([OnboardingClient.tsx:193](src/components/onboarding/OnboardingClient.tsx#L193)) |
| ↳ **Contractor created** (temp-password) | [AddContractorWizard.tsx:225](src/components/contractors/AddContractorWizard.tsx#L225) | Successful create returning temp password | `done && tempPassword` ([:225](src/components/contractors/AddContractorWizard.tsx#L225)) |
| ↳ **Possible-duplicate confirm** | [AddContractorWizard.tsx:653](src/components/contractors/AddContractorWizard.tsx#L653) | Server `DUPLICATE_NAME` ([:202](src/components/contractors/AddContractorWizard.tsx#L202)) | — |
| **Bulk import modal** | [BulkImportModal.tsx:91](src/components/contractors/BulkImportModal.tsx#L91) | "⇪ Bulk import" ([ContractorsClient.tsx:255](src/components/contractors/ContractorsClient.tsx#L255)) | — |
| **Pull Wise recipient IDs modal** | [PullWiseRecipientsModal.tsx:17](src/components/contractors/PullWiseRecipientsModal.tsx#L17) | "⤓ Pull IDs from Wise" ([ContractorsClient.tsx:252](src/components/contractors/ContractorsClient.tsx#L252)) | — |
| **Announcements modal** | [ContractorsClient.tsx:324-328](src/components/contractors/ContractorsClient.tsx#L324) (wraps [AnnouncementsCard.tsx](src/components/config/AnnouncementsCard.tsx)) | "📣 Announcements" ([ContractorsClient.tsx:261](src/components/contractors/ContractorsClient.tsx#L261)) | — |
| **Deactivate / Reactivate / Delete contractor** (ConfirmDanger) | [ContractorsClient.tsx:330](src/components/contractors/ContractorsClient.tsx#L330), [:346](src/components/contractors/ContractorsClient.tsx#L346), [:361](src/components/contractors/ContractorsClient.tsx#L361) | Row buttons ([:200](src/components/contractors/ContractorsClient.tsx#L200), [:209](src/components/contractors/ContractorsClient.tsx#L209), [:215](src/components/contractors/ContractorsClient.tsx#L215)) | Deactivate=active; Reactivate=inactive; **Delete = `isOwner` AND inactive** ([:214](src/components/contractors/ContractorsClient.tsx#L214)) |
| **Hire-draft resume banner** (inline) | [HireDraftBanner.tsx:15](src/components/contractors/HireDraftBanner.tsx#L15) | Auto-shown when an unfinished hire draft exists | Resume/Discard callbacks |
| **Agreement-templates modal** | [OnboardingClient.tsx:261-265](src/components/onboarding/OnboardingClient.tsx#L261) | "Agreement templates" ([:210](src/components/onboarding/OnboardingClient.tsx#L210)) | — |
| **Onboarding drilldown** (large modal: agreements, profile, docs, actions) | [OnboardingDrilldown.tsx:69](src/components/onboarding/OnboardingDrilldown.tsx#L69) | Row click / "Review" in Onboarding ([OnboardingClient.tsx:143,236](src/components/onboarding/OnboardingClient.tsx#L143)) | Hosts 8 nested modals below |
| ↳ Countersign | [OnboardingDrilldown.tsx:1038](src/components/onboarding/OnboardingDrilldown.tsx#L1038) | Countersign button ([:614](src/components/onboarding/OnboardingDrilldown.tsx#L614)) | **`canCountersign` && stage-1 complete** ([:604](src/components/onboarding/OnboardingDrilldown.tsx#L604)) |
| ↳ Document preview | [OnboardingDrilldown.tsx:1070](src/components/onboarding/OnboardingDrilldown.tsx#L1070) | "View" on a doc ([:402](src/components/onboarding/OnboardingDrilldown.tsx#L402)) | — |
| ↳ Waive document (ConfirmDanger) | [OnboardingDrilldown.tsx:1116](src/components/onboarding/OnboardingDrilldown.tsx#L1116) | "Waive" ([:428,499](src/components/onboarding/OnboardingDrilldown.tsx#L428)) | — |
| ↳ Withdraw offer (ConfirmDanger) | [OnboardingDrilldown.tsx:1131](src/components/onboarding/OnboardingDrilldown.tsx#L1131) | "Withdraw offer…" ([:1017](src/components/onboarding/OnboardingDrilldown.tsx#L1017)) | — |
| ↳ Delete hire (ConfirmDanger) | [OnboardingDrilldown.tsx:1156](src/components/onboarding/OnboardingDrilldown.tsx#L1156) | "Delete hire…" ([:1027](src/components/onboarding/OnboardingDrilldown.tsx#L1027)) | **`isOwner`** ([:1021](src/components/onboarding/OnboardingDrilldown.tsx#L1021)) |
| ↳ Edit prefill | [OnboardingDrilldown.tsx:1184](src/components/onboarding/OnboardingDrilldown.tsx#L1184) | "Edit prefill" ([:721](src/components/onboarding/OnboardingDrilldown.tsx#L721)) | — |
| ↳ Edit signed date | [OnboardingDrilldown.tsx:1229](src/components/onboarding/OnboardingDrilldown.tsx#L1229) | "Edit date" ([:709](src/components/onboarding/OnboardingDrilldown.tsx#L709)) | — |
| ↳ Request replacement | [OnboardingDrilldown.tsx:1260](src/components/onboarding/OnboardingDrilldown.tsx#L1260) | "Needs replacement" ([:419](src/components/onboarding/OnboardingDrilldown.tsx#L419)) | — |
| ↳ Update login & resend | [OnboardingDrilldown.tsx:891](src/components/onboarding/OnboardingDrilldown.tsx#L891) | "✉ Update login & resend" ([:1001](src/components/onboarding/OnboardingDrilldown.tsx#L1001)) | — |
| ↳ Print link → `/onboarding/{workerId}/{kind}/print` | [OnboardingDrilldown.tsx:732](src/components/onboarding/OnboardingDrilldown.tsx#L732) | "Print" link | opens print route (§3) |
| **Misc modal** (HA / 13th / lunch / bonus / misc items) | [MiscModal.tsx:49](src/components/payroll/MiscModal.tsx#L49) (rendered [PayrollShell.tsx:1003](src/components/payroll/PayrollShell.tsx#L1003)) | "+ Misc" / "Edit (N)" per row ([PayrollShell.tsx:905](src/components/payroll/PayrollShell.tsx#L905)) | host = Calculate or Payroll |
| **Recalculate confirm** (ConfirmDanger) | [PayrollShell.tsx:1026](src/components/payroll/PayrollShell.tsx#L1026) | Calculate when overrides exist ([:216](src/components/payroll/PayrollShell.tsx#L216)) | adjusted rows > 0 ([:210](src/components/payroll/PayrollShell.tsx#L210)) |
| **Lock batch confirm** (ConfirmDanger) | [PayrollShell.tsx:1042](src/components/payroll/PayrollShell.tsx#L1042) | "Lock batch for processing" ([:620](src/components/payroll/PayrollShell.tsx#L620)) | **disabled if paid** ([:621](src/components/payroll/PayrollShell.tsx#L621)); shown when not locked/paid ([:615](src/components/payroll/PayrollShell.tsx#L615)) |
| **Delete batch confirm** (ConfirmDanger) | [PayrollShell.tsx:1058](src/components/payroll/PayrollShell.tsx#L1058) | "Delete batch" ([:656](src/components/payroll/PayrollShell.tsx#L656)) | **period `isOpen` && rows>0** ([:653](src/components/payroll/PayrollShell.tsx#L653)) |
| **Unlock-for-editing modal** (reason textarea) | [PayrollShell.tsx:1071](src/components/payroll/PayrollShell.tsx#L1071) | "Unlock for editing…" ([:638](src/components/payroll/PayrollShell.tsx#L638)) | **period `isLocked`** ([:634](src/components/payroll/PayrollShell.tsx#L634)) |
| **Admins modal** (roster: add/remove, role owner↔admin, countersign toggle, company reassign) | [AdminsModal.tsx:50](src/components/shell/AdminsModal.tsx#L50) | "Admins" topbar button ([AdminShell.tsx:201-205](src/components/shell/AdminShell.tsx#L201)) → rendered [AdminShell.tsx:127-134](src/components/shell/AdminShell.tsx#L127) | **owner-only**: button only renders if `admin.isOwner` ([AdminShell.tsx:201](src/components/shell/AdminShell.tsx#L201)); roster fetched only for owners ([(admin)/layout.tsx:35](src/app/(admin)/layout.tsx#L35)) |
| **Configuration panels** (Modal-hosted): Employer, Clients, Hubstaff→Clients, Portal Fields, Agreement Templates, Onboarding, Observed Holidays | [ConfigClient.tsx:154-182](src/components/config/ConfigClient.tsx#L154) | "Open" per config row ([:146](src/components/config/ConfigClient.tsx#L146)) | **Clients card receives `isOwner`** ([:158](src/components/config/ConfigClient.tsx#L158)). `WiseReconCard` renders inline below ([:184](src/components/config/ConfigClient.tsx#L184)). `EmployerCard`/`ClientsCard` embed `ContactsEditor` ([EmployerCard.tsx:281](src/components/config/EmployerCard.tsx#L281), [ClientsCard.tsx:402](src/components/config/ClientsCard.tsx#L402)) |

### 1.3 Admin inline panels / sub-features (not modals)

| Feature | File:line | Host / trigger |
|---|---|---|
| **Period picker** (Prev/Next) | [PeriodPicker.tsx:19](src/components/time/PeriodPicker.tsx#L19) | Time shell ([TimeShell.tsx:79](src/components/time/TimeShell.tsx#L79)) |
| **CSV import card** (+ Hubstaff OptionB) | [CsvImportCard.tsx:55](src/components/time/CsvImportCard.tsx#L55) | Time shell ([TimeShell.tsx:83](src/components/time/TimeShell.tsx#L83)) |
| **Option B panel** (Hubstaff org sync) | [OptionBPanel.tsx:28](src/components/time/OptionBPanel.tsx#L28) | Inside CsvImportCard |
| **Time approval table** (Approve/Reject, bulk approve) | [TimeApprovalTable.tsx:44](src/components/time/TimeApprovalTable.tsx#L44) | Time shell ([TimeShell.tsx:89](src/components/time/TimeShell.tsx#L89)) |
| ↳ **Add hours panel** (inline expand per row) | [AddHoursPanel.tsx:24](src/components/time/AddHoursPanel.tsx#L24) | "Add hours" row button |
| ↳ **Add unlisted row** (inline expand) | [AddUnlistedRow.tsx:30](src/components/time/AddUnlistedRow.tsx#L30) | Bottom "Add hours" row |
| **Rate card** (rate history + set new rate) | [RateCard.tsx:14](src/components/contractors/RateCard.tsx#L14) | ProfilePanel "Pay & payout" tab ([ProfilePanel.tsx:738](src/components/contractors/ProfilePanel.tsx#L738)) |
| **Process shell** (link-only; no modals) | [ProcessShell.tsx:35](src/components/process/ProcessShell.tsx#L35) | Process page. Links: "Open & pay"/"Unlock" → `/payroll` ([:125,133](src/components/process/ProcessShell.tsx#L125)); "Go to Calculate" ([:88](src/components/process/ProcessShell.tsx#L88)); "Go to Time & Approval" ([:93](src/components/process/ProcessShell.tsx#L93)) |
| **Invoicing client** (preview/generate/status/CSV) | [InvoicingClient.tsx:39](src/components/invoicing/InvoicingClient.tsx#L39) | Invoicing page; "Print" → opens `/invoicing/{id}/print` new tab ([:345-351](src/components/invoicing/InvoicingClient.tsx#L345)); generate → opens print ([:346](src/components/invoicing/InvoicingClient.tsx#L346)) |

---

## §2 — Contractor portal surface

Portal nav: [PortalShell.tsx:27-34](src/components/portal/PortalShell.tsx#L27) (6 items). **All non-Home items are hidden in the nav until `onboarded === true`** ([PortalShell.tsx:131-133](src/components/portal/PortalShell.tsx#L131)). Auth gate: `getCurrentWorker()` → `redirect('/portal/login')` ([portal/(authed)/layout.tsx:12-13](src/app/portal/(authed)/layout.tsx#L12)). Docs nav badge counts `needs_replacement` docs ([layout.tsx:17-22](src/app/portal/(authed)/layout.tsx#L17), badge UI [PortalShell.tsx:135,144-150](src/components/portal/PortalShell.tsx#L135)).

### 2.1 Portal routes

| Name (UI label) | File:line | User task | Reached via / click-depth | Role/state gating |
|---|---|---|---|---|
| **Home** | [portal/(authed)/page.tsx:117](src/app/portal/(authed)/page.tsx#L117) → `PortalDashboard` | Announcements, pay timeline, activity %, toolkit | Nav "Home" / **landing (depth 0)** | worker auth ([:40-41](src/app/portal/(authed)/page.tsx#L40)). Visible pre-onboarding (only nav item shown then) |
| **Pay slips** | [statements/page.tsx:14](src/app/portal/(authed)/statements/page.tsx#L14) → `PortalStatements` | View pay history + breakdowns | Nav "Pay slips"; **depth 1** | worker auth ([:8-9](src/app/portal/(authed)/statements/page.tsx#L8)); nav-hidden until onboarded |
| **Time** | [time/page.tsx:24](src/app/portal/(authed)/time/page.tsx#L24) → `PortalTime` | View time history by period | Nav "Time"; **depth 1** | worker auth ([:9](src/app/portal/(authed)/time/page.tsx#L9)); **inline notice card if `!onboarded`** ([:13-19](src/app/portal/(authed)/time/page.tsx#L13)) |
| **Sessions** | [sessions/page.tsx:34](src/app/portal/(authed)/sessions/page.tsx#L34) → `PortalSessions` | Record EI sessions (client/child/EIID/date/item) | Nav "Sessions"; **depth 1** | worker auth ([:11-12](src/app/portal/(authed)/sessions/page.tsx#L11)); **inline notice if `!onboarded`** ([:14-20](src/app/portal/(authed)/sessions/page.tsx#L14)) |
| **Docs** | [docs/page.tsx:17](src/app/portal/(authed)/docs/page.tsx#L17) → `PortalDocs` | Upload/view documents (IC agreement, W-8BEN, Gov ID) | Nav "Docs" (badge); **depth 1** | worker auth ([:9-10](src/app/portal/(authed)/docs/page.tsx#L9)); **accessible pre-onboarding** (but nav-hidden until onboarded) |
| **Profile** | [profile/page.tsx:21](src/app/portal/(authed)/profile/page.tsx#L21) → `PortalProfile` | Edit personal/contact/payout/about fields | Nav "Profile"; **depth 1**; also linked from Onboarding stage 2 ([PortalOnboarding.tsx:416](src/components/portal/PortalOnboarding.tsx#L416)) | worker auth ([:8-9](src/app/portal/(authed)/profile/page.tsx#L8)); editable fields gated by admin config |
| **Onboarding** | [onboarding/page.tsx:65](src/app/portal/(authed)/onboarding/page.tsx#L65) → `PortalOnboarding` | Sign agreements (Stage 1), complete profile tabs (Stage 2), upload docs (Stage 3) | **Not in nav.** Reached pre-onboarding (INFERRED: from DocReminder / direct link). Required kinds: ic_agreement, non_compete, confidentiality_nda, baa ([:12-17](src/app/portal/(authed)/onboarding/page.tsx#L12)) | worker auth ([:20-21](src/app/portal/(authed)/onboarding/page.tsx#L20)); **no onboarded gate** (the pre-onboarding workflow itself) |

> Each authed portal route also has its own `loading.tsx` only for `onboarding` ([onboarding/loading.tsx](src/app/portal/(authed)/onboarding/loading.tsx)); others rely on the shell. OBSERVED.

### 2.2 Portal modals / popups / overlays / banners

| Item | File:line | Trigger | Gating |
|---|---|---|---|
| **Tools popup** (decrypted tool logins: Hubstaff/Gmail/Providersoft/Wise) | [ToolsPopup.tsx:43](src/components/portal/ToolsPopup.tsx#L43) | **Auto-opens on mount if `pending`** ([:14](src/components/portal/ToolsPopup.tsx#L14)); calls `revealMyTools()` once ([:23](src/components/portal/ToolsPopup.tsx#L23)); "Got it" acks ([:76-78](src/components/portal/ToolsPopup.tsx#L76)) | rendered by `PortalDashboard` ([:141](src/components/portal/PortalDashboard.tsx#L141)) |
| **Doc-reminder overlay** (bottom sheet w/ upload slots) | [DocReminderOverlay.tsx](src/components/portal/DocReminderOverlay.tsx) | **Auto-opens on mount if `docs.length>0` and not session-dismissed** ([:26-40](src/components/portal/DocReminderOverlay.tsx#L26)); "Later"/backdrop dismiss ([:44-47,62](src/components/portal/DocReminderOverlay.tsx#L44)) | rendered by `PortalDashboard` ([:142](src/components/portal/PortalDashboard.tsx#L142)) |
| **Agreement-signing modal** (read body, type/draw signature) | [PortalOnboarding.tsx:463-583](src/components/portal/PortalOnboarding.tsx#L463) | "Sign" on a Stage-1 agreement ([:336](src/components/portal/PortalOnboarding.tsx#L336)) | Stage 1 |
| **Tab-completion confirm modal** | [PortalOnboarding.tsx:586-616](src/components/portal/PortalOnboarding.tsx#L586) | "Mark complete" on a Stage-2 tab ([:407](src/components/portal/PortalOnboarding.tsx#L407)) | Stage 2 (shown after Stage 1 complete) |
| **Pay card + activity chart** (inline) | [PortalPayActivity.tsx:93,171](src/components/portal/PortalPayActivity.tsx#L93) | rendered by dashboard ([PortalDashboard.tsx:196](src/components/portal/PortalDashboard.tsx#L196)) | empty state "No logged activity yet." ([:169](src/components/portal/PortalPayActivity.tsx#L169)) |
| **"From New York" hero** (live NYC sky/weather/clocks/trivia) | [FromNewYork.tsx:83](src/components/portal/FromNewYork.tsx#L83) | rendered on dashboard | decorative; 20s refresh ([:151](src/components/portal/FromNewYork.tsx#L151)) |
| **Expandable pay-slip card** (inline expand) | [PortalStatements.tsx:49-167](src/components/portal/PortalStatements.tsx#L49) | Click / Enter / Space | empty "No pay slips yet." ([:18](src/components/portal/PortalStatements.tsx#L18)) |
| **Expandable period card** (inline expand, per-day breakdown) | [PortalTime.tsx:96-169](src/components/portal/PortalTime.tsx#L96) | Click header | empty "No time recorded yet." ([:43](src/components/portal/PortalTime.tsx#L43)) |
| **Onboarding print link** → `/portal/onboarding/{kind}/print` | (INFERRED — via signed agreements UI) | print route §3 | requires signed signature |

---

## §3 — Auth & print/utility routes

### 3.1 Auth surface

| Name | File:line | Task | Reached via | Gating |
|---|---|---|---|---|
| **Admin sign-in** (`/login`) | [login/page.tsx:13](src/app/login/page.tsx#L13) + [AdminLoginForm.tsx:18](src/components/auth/AdminLoginForm.tsx#L18) | Google OAuth (primary) or email/password fallback; "Classic/Modern view" toggle | Unauth redirect from any admin route ([proxy.ts:46](src/proxy.ts#L46)); sign-out target ([AdminShell.tsx:111](src/components/shell/AdminShell.tsx#L111)) | public; reads `?error=domain|oauth` ([login/page.tsx:7-19](src/app/login/page.tsx#L7)). On password success → `/overview` ([AdminLoginForm.tsx:64](src/components/auth/AdminLoginForm.tsx#L64)) |
| **Portal sign-in** (`/portal/login`) | [portal/login/page.tsx:7](src/app/portal/login/page.tsx#L7) + [PortalLoginForm.tsx:21](src/components/auth/PortalLoginForm.tsx#L21) | Contractor email/password + self-serve reset; optional Cloudflare Turnstile | Unauth redirect from `/portal/*` ([proxy.ts:46](src/proxy.ts#L46)); portal sign-out ([PortalShell.tsx:81](src/components/portal/PortalShell.tsx#L81)) | public; on success → `/portal` ([PortalLoginForm.tsx:57](src/components/auth/PortalLoginForm.tsx#L57)); reset → `/auth/callback?next=/portal` ([:69](src/components/auth/PortalLoginForm.tsx#L69)) |
| **Auth callback** (`/auth/callback`) | [auth/callback/route.ts:20](src/app/auth/callback/route.ts#L20) | OAuth/magic-link/reset code exchange; admin SSO domain gate | Google/reset redirect | public route; **federated email must be on allowed domain or signed out** ([:33-37](src/app/auth/callback/route.ts#L33)); honors `?next` via `safeNext` ([:23](src/app/auth/callback/route.ts#L23)) |

### 3.2 Print routes (all auto-print via `AutoPrint` — `window.print()` on mount + manual button, [print/AutoPrint.tsx:1-29](src/components/print/AutoPrint.tsx#L1))

| Route | File:line | Renders | Params | Gating |
|---|---|---|---|---|
| `/invoicing/[id]/print` | [invoicing/[id]/print/page.tsx:21](src/app/(admin)/invoicing/[id]/print/page.tsx#L21) | Invoice table (lines, markup, total) | `[id]` invoice UUID | admin auth; `AutoPrint` ([:43](src/app/(admin)/invoicing/[id]/print/page.tsx#L43)) — re-export shim [invoicing/AutoPrint.tsx:1-4](src/components/invoicing/AutoPrint.tsx#L1) |
| `/payroll/[paymentId]/print` | [payroll/[paymentId]/print/page.tsx:18](src/app/(admin)/payroll/[paymentId]/print/page.tsx#L18) | Pay slip (`PaySlip`) | `[paymentId]` UUID | admin auth; `PaySlip` ([:29](src/app/(admin)/payroll/[paymentId]/print/page.tsx#L29)) |
| `/onboarding/[workerId]/[kind]/print` | [onboarding/[workerId]/[kind]/print/page.tsx:43](src/app/(admin)/onboarding/[workerId]/[kind]/print/page.tsx#L43) | Agreement (merged template) + signatories | `[workerId]`, `[kind]` enum | admin auth; `notFound()` if `kind`∉KINDS ([:47](src/app/(admin)/onboarding/[workerId]/[kind]/print/page.tsx#L47)) or no template ([:60](src/app/(admin)/onboarding/[workerId]/[kind]/print/page.tsx#L60)) |
| `/portal/onboarding/[kind]/print` | [portal/(authed)/onboarding/[kind]/print/page.tsx:41](src/app/portal/(authed)/onboarding/[kind]/print/page.tsx#L41) | Worker's signed agreement | `[kind]` enum | worker auth; `notFound()` if kind invalid ([:45](src/app/portal/(authed)/onboarding/[kind]/print/page.tsx#L45)) or **not signed** ([:61](src/app/portal/(authed)/onboarding/[kind]/print/page.tsx#L61)) |
| `/portal/statements/[paymentId]/print` | [portal/(authed)/statements/[paymentId]/print/page.tsx:18](src/app/portal/(authed)/statements/[paymentId]/print/page.tsx#L18) | Pay slip (`PaySlip`) | `[paymentId]` UUID | worker auth; **ownership check** `pay.workerId !== worker.workerId` → `notFound()` ([:26](src/app/portal/(authed)/statements/[paymentId]/print/page.tsx#L26)) |

---

## §4 — Cross-cutting UI (appears across screens)

| Element | File:line | Where it appears | Notes |
|---|---|---|---|
| **Top bar** (navy, brand `Mark`, "🔎 Find", Employer switcher, email, Admins, Sign out) | [AdminShell.tsx:138-210](src/components/shell/AdminShell.tsx#L138) | All admin screens | "Admins" button owner-only ([:201](src/components/shell/AdminShell.tsx#L201)); company switcher disabled if ≤1 company ([:178](src/components/shell/AdminShell.tsx#L178)) |
| **Collapsible sidebar** (212/60px, persisted `abc_sidebar_collapsed`) | [AdminShell.tsx:211-250](src/components/shell/AdminShell.tsx#L211) | All admin screens | groups from `NAV_GROUPS` |
| **Command palette ⌘K / Ctrl-K** (sections + contractors + periods) | [CommandPalette.tsx:53](src/components/shell/CommandPalette.tsx#L53); hotkey [AdminShell.tsx:68-77](src/components/shell/AdminShell.tsx#L68) | All admin screens | Enter navigates: worker → `/contractors?focus=<id>` ([:117](src/components/shell/CommandPalette.tsx#L117)); period → **`/payroll?period=<start>`** ([:118](src/components/shell/CommandPalette.tsx#L118)) |
| **Portal bottom tab bar** (collapsible, `portal_nav_collapsed`) + header | [PortalShell.tsx:88-190](src/components/portal/PortalShell.tsx#L88) | All portal screens | non-Home items hidden until onboarded ([:131-133](src/components/portal/PortalShell.tsx#L131)) |
| **Toast system** (`ToastProvider` / `useToast`; info/success/warn/error) | [Toast.tsx:1-94](src/components/ui/Toast.tsx#L1) | `ToastProvider` mounted in [AdminShell.tsx:118](src/components/shell/AdminShell.tsx#L118) and [PortalShell.tsx:86](src/components/portal/PortalShell.tsx#L86); `useToast` used in 30+ components | app-wide |
| **Modal base** (focus-trap, Esc-close, backdrop-close, native `<dialog>`) | [Modal.tsx:1-135](src/components/ui/Modal.tsx#L1) | ~27 call sites (config, contractors, onboarding, payroll, shell, portal) | escClose default true |
| **Confirm-danger modal** (type-to-confirm + Enter) | [ConfirmDangerModal.tsx:1-88](src/components/ui/ConfirmDangerModal.tsx#L1) | 14 destructive sites: ContractorsClient, PayrollShell, BatchesClient, OnboardingDrilldown, AddContractorWizard, AdminsCard, AnnouncementsCard, ClientsCard | irreversible actions |
| **Empty state** | [EmptyState.tsx:1-29](src/components/ui/EmptyState.tsx#L1) | 11 sites (PayrollShell, TimeApprovalTable, AuditTable, BatchesClient, ContractorsClient, OnboardingClient, config cards) | icon + message + optional CTA |
| **Spinner** | [Spinner.tsx:1-10](src/components/ui/Spinner.tsx#L1) | every `loading.tsx`; inline busy states | role=status |
| **Sortable/filterable table** | [SortableTable.tsx:1-180](src/components/ui/SortableTable.tsx#L1) | config cards, audit, etc. | sticky header, mobile card-stack |
| **Contractor picker** (searchable multi-select) | [ContractorPicker.tsx:1-119](src/components/ui/ContractorPicker.tsx#L1) | filters/assignment UIs | Esc + outside-click close |
| **Unsaved-changes guard** | [useUnsavedGuard.ts:1-44](src/components/ui/useUnsavedGuard.ts#L1) | ProfilePanel, PortalFieldsCard | beforeunload + confirm |
| **Brand** | [Logo.tsx](src/components/brand/Logo.tsx) (login), [Mark.tsx](src/components/brand/Mark.tsx) (shells) | login + both shells | — |
| **Skip-to-content link** | [AdminShell.tsx:135-137](src/components/shell/AdminShell.tsx#L135) | admin only | a11y |

---

## §5 — Navigation map (click-depth marked)

### Admin tree

```
[Unauth] ── any admin route ──▶ /login  (Google OAuth | email/pw | error=domain|oauth)
                                  └─▶ /auth/callback ──▶ /overview (admin)  OR  /portal (contractor)

/  ──redirect──▶ /overview                                   ◀── ADMIN LANDING (depth 0)
│
├─ Top bar (every screen): 🔎 Find (⌘K), Employer switcher, Admins*(owner), Sign out→/login
│   └─ ⌘K Command Palette ─▶ section | /contractors?focus=<id> | /payroll?period=<start>
│   └─ Admins modal* (owner-only)
│
└─ Sidebar (depth 1):
   ├─ Manage Team
   │   ├─ /contractors ─▶ Profile panel (?focus deep-link) ─▶ Add wizard / Bulk import /
   │   │                  Pull-Wise / Announcements / Deactivate·Reactivate·Delete*(owner)
   │   ├─ /onboarding ─▶ Add wizard | Agreement-templates | Onboarding drilldown
   │   │                  └─ countersign*(canCountersign) · waive · withdraw · delete-hire*(owner)
   │   │                     · edit prefill/date · request-replacement · update-login
   │   │                     · Print ─▶ /onboarding/{workerId}/{kind}/print  (depth 3)
   │   └─ /documents
   ├─ Run payroll
   │   ├─ /time ─▶ PeriodPicker · CSV import (+Hubstaff OptionB) · Approval table
   │   │            └─ Add-hours / Add-unlisted (inline)
   │   ├─ /calculate ─▶ PayrollShell ─▶ Misc modal · recalc/lock/delete/unlock confirms
   │   └─ /process ─▶ links to /payroll · /calculate · /time
   ├─ Review
   │   ├─ /batches      ├─ /reports     ├─ /sessions
   │   ├─ /invoicing ─▶ Print ─▶ /invoicing/{id}/print (depth 2)
   │   ├─ /imports      └─ /audit (?page, ?q)
   └─ Configuration
       └─ /config ─▶ Modal panels: Employer · Clients*(isOwner) · Hubstaff · Portal fields
                     · Agreements · Onboarding · Holidays  ·  WiseRecon (inline)

   ⟂ /payroll  — NOT in sidebar; only via ⌘K period or /process links  (see §7)
```

### Portal tree

```
[Unauth] ── /portal/* ──▶ /portal/login  (email/pw + reset + Turnstile)
                            └─▶ /auth/callback?next=/portal ──▶ /portal

/portal  ◀── PORTAL LANDING (depth 0)  (only nav item visible until onboarded)
│  └─ Auto: Tools popup (if pending) · Doc-reminder overlay (if pending)
│
├─ (pre-onboarding) /portal/onboarding   ← reached via reminder/link, NOT nav
│     Stage 1 sign-agreement modal ─▶ Stage 2 tab-complete modal (→ /portal/profile)
│     ─▶ Stage 3 finish.  Print ─▶ /portal/onboarding/{kind}/print
│
└─ Bottom tabs (depth 1, shown once onboarded):
   ├─ /portal/statements ─▶ expand card ─▶ /portal/statements/{paymentId}/print (depth 2)
   ├─ /portal/time        (inline notice if !onboarded)
   ├─ /portal/sessions    (inline notice if !onboarded; record EI session form)
   ├─ /portal/docs        (badge = needs_replacement; upload slots)
   └─ /portal/profile     (editable fields per admin config)
```

---

## §6 — Role/state gating matrix

Roles: **owner** (`admin_users.role='owner'`), **admin** (non-owner), **contractor** (`contractor_logins` active), **unauth**. Routing enforced by the proxy gate [proxy.ts:19-83](src/proxy.ts#L19) (admins own everything except `/portal`; contractors own `/portal`; **admins may preview the portal** [proxy.ts:57](src/proxy.ts#L57)); re-verified per page via `getCurrentAdmin`/`getCurrentWorker`.

| Screen | owner | admin | contractor | unauth | Precondition |
|---|---|---|---|---|---|
| `/overview` & most admin routes | ✅ | ✅ | ➡ `/portal` ([proxy.ts:77](src/proxy.ts#L77)) | ➡ `/login` | company selected (else empty card) |
| `/contractors` Delete action | ✅ | ❌ ([ContractorsClient.tsx:214](src/components/contractors/ContractorsClient.tsx#L214)) | n/a | n/a | contractor inactive |
| `/config` Clients card | ✅ owner-aware ([ConfigClient.tsx:158](src/components/config/ConfigClient.tsx#L158)) | ✅ (limited) | n/a | n/a | — |
| Admins modal (topbar) | ✅ ([AdminShell.tsx:201](src/components/shell/AdminShell.tsx#L201)) | ❌ (button hidden) | n/a | n/a | owner |
| Onboarding countersign | ✅ if `canCountersign` | ✅ if `canCountersign` ([OnboardingDrilldown.tsx:604](src/components/onboarding/OnboardingDrilldown.tsx#L604)) | n/a | n/a | stage-1 complete |
| Onboarding delete-hire | ✅ ([OnboardingDrilldown.tsx:1021](src/components/onboarding/OnboardingDrilldown.tsx#L1021)) | ❌ | n/a | n/a | — |
| Payroll lock / unlock / delete | ✅ | ✅ | n/a | n/a | period state: lock(open→locked), unlock(locked), delete(open & rows>0) — [PayrollShell.tsx:615,634,653](src/components/payroll/PayrollShell.tsx#L615); lock disabled if paid ([:621](src/components/payroll/PayrollShell.tsx#L621)) |
| Wise money staging | owner-only (server) ([admin.ts:64-68 `requireOwner`](src/server/auth/admin.ts#L64)) | ❌ (server-enforced) | n/a | n/a | INFERRED from `requireOwner` comment |
| `/portal` Home | ✅ (preview) | ✅ (preview) | ✅ | ➡ `/portal/login` | — |
| `/portal/{statements,profile,docs}` | preview | preview | ✅ | ➡ login | nav-hidden until onboarded |
| `/portal/{time,sessions}` | preview | preview | ✅ | ➡ login | **inline notice if `!onboarded`** ([time:13](src/app/portal/(authed)/time/page.tsx#L13), [sessions:14](src/app/portal/(authed)/sessions/page.tsx#L14)) |
| `/portal/onboarding` | preview | preview | ✅ | ➡ login | the pre-onboarding workflow (no onboarded gate) |
| `/login`, `/portal/login`, `/auth/callback` | public | public | public | public | listed in `PUBLIC_PATHS` ([proxy.ts:17](src/proxy.ts#L17)); callback adds admin-SSO domain gate ([:33](src/app/auth/callback/route.ts#L33)) |
| Admin print routes | ✅ | ✅ | n/a (proxy bounces) | ➡ login | per-route validation (§3.2) |
| Portal print routes | preview | preview | ✅ | ➡ login | ownership / signed checks (§3.2) |

> "preview" = admins may view the portal area per the proxy ([proxy.ts:56-57](src/proxy.ts#L56)); whether portal data resolves for an admin is RLS-dependent and **not confirmed in this track** (INFERRED).

---

## §7 — Orphans & dead ends

1. **`/payroll` route not in sidebar (OBSERVED).** [payroll/page.tsx](src/app/(admin)/payroll/page.tsx) renders `PayrollShell` — the same shell as `/calculate` ([calculate/page.tsx:38](src/app/(admin)/calculate/page.tsx#L38)). It is **absent from `NAV_GROUPS`** ([nav.ts:24-60](src/components/shell/nav.ts#L24)). It is reachable only via the ⌘K command palette period pick (`/payroll?period=<start>`, [CommandPalette.tsx:118](src/components/shell/CommandPalette.tsx#L118)) and Process-shell links ([ProcessShell.tsx:125,133](src/components/process/ProcessShell.tsx#L125)). **INFERRED:** `/calculate` and `/payroll` are near-duplicates; one may be a legacy/transitional alias. Worth confirming intent in a later track.

2. **`AdminsCard` (config) appears unused (OBSERVED).** [config/AdminsCard.tsx](src/components/config/AdminsCard.tsx) is not imported anywhere outside its own file; the live owner-only roster UI is the **shell** `AdminsModal` ([AdminsModal.tsx](src/components/shell/AdminsModal.tsx)), which does **not** import `AdminsCard` (grep confirmed no reference). **INFERRED:** `config/AdminsCard.tsx` is a dead/orphaned component (or reserved for a future config panel — it is not in `ConfigClient`'s `ROWS`). The Track-4 cleanup track should verify.

3. **`/portal/onboarding` has no nav entry (OBSERVED, by design).** Not in `PortalShell` `NAV_ITEMS` ([PortalShell.tsx:27-34](src/components/portal/PortalShell.tsx#L27)). Entry is the doc-reminder overlay / direct link during pre-onboarding. Not a true orphan but **has no persistent nav affordance** once a worker leaves it; re-entry depends on the reminder overlay re-appearing or a direct URL. INFERRED minor dead-end risk.

4. **Print routes are terminal (OBSERVED).** All `/print` pages auto-call `window.print()` and offer only a manual "Print" button ([print/AutoPrint.tsx](src/components/print/AutoPrint.tsx)) — **no in-page back/close affordance**; the user relies on the browser back button or closing the tab (most are opened in a new tab, e.g. [InvoicingClient.tsx:345-351](src/components/invoicing/InvoicingClient.tsx#L345)). Expected for print views; noted for completeness.

5. **No-company-selected empty cards are dead-ends until the switcher is used (OBSERVED).** Most admin pages short-circuit to a "No company selected" card (e.g. [overview/page.tsx:62-70](src/app/(admin)/overview/page.tsx#L62)) whose only exit is the header company switcher ([AdminShell.tsx:162-193](src/components/shell/AdminShell.tsx#L162)). `/sessions` and `/invoicing` **do not** apply this guard (OBSERVED — [sessions/page.tsx](src/app/(admin)/sessions/page.tsx), [invoicing/page.tsx](src/app/(admin)/invoicing/page.tsx)), an inconsistency worth flagging.

6. **No `loading.tsx` for `/batches`, `/sessions`, `/invoicing` (OBSERVED).** Other admin routes have skeletons; these three lack one (file listing). Minor UX inconsistency, not an orphan.

---

## Coverage note

- **Fully resolved:** all 14 sidebar admin routes + `/payroll`, all 7 portal authed routes, 3 auth routes, 5 print routes, all top-level modals/drawers/overlays, shell chrome, command palette, and role/state gates traceable to `file:line`.
- **Not fully resolved (left to other tracks):**
  - Whether `/payroll` vs `/calculate` is intentional duplication or a migration alias (§7.1) — needs product/history context.
  - Whether `config/AdminsCard.tsx` is truly dead vs reserved (§7.2) — confirmed unreferenced by grep, but intent unknown.
  - Server-side authorization beyond the page gates (e.g. `requireOwner` for Wise staging [admin.ts:64](src/server/auth/admin.ts#L64)) was sampled, not exhaustively mapped — the server-action surface (`src/server/actions/*`) is out of scope for this navigation inventory and should be inventoried by the data/security track.
  - Exact RLS behaviour when an **admin previews the portal** ([proxy.ts:57](src/proxy.ts#L57)) — routing allows it; data visibility was not verified here (INFERRED).
  - Deep contents of some inline panels (CsvImportCard / OptionBPanel / TimeApprovalTable) were read only to the depth needed to identify triggers and nesting; their full field-level behaviour is a feature-detail track concern.
