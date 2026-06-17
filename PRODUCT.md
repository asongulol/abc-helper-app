# Product

## Register

product

## Users

Two distinct audiences share one system:

- **ABC payroll administrators (internal).** Operate the `(admin)` surface: contractor
  onboarding, Hubstaff time imports, pay calculation, batches, invoicing, Wise payments,
  reports, and audit. Context: focused desktop work sessions, handling money for real
  people. They repeat the same flows every pay period, so accuracy, scannability, and an
  audit trail matter more than novelty.
- **Contractors (external).** Use the `portal/(authed)` surface: complete onboarding, sign
  documents, and view statements, time, profile, and docs. Context: occasional, lower-trust,
  possibly non-technical. They need clarity, reassurance, and a guided path — not a dense
  admin console.

## Product Purpose

A payroll and operations system for ABC that runs the full pipeline — contractor onboarding →
time tracking (Hubstaff) → pay calculation → invoicing → international payment (Wise) — plus a
self-serve contractor portal. It is a parallel rewrite of the legacy app onto Next.js (App
Router) + Supabase, kept faithful to legacy behavior until cutover. Success: payroll runs that
are accurate, auditable, and trusted, with a contractor experience smooth enough to be
self-serve.

## Brand Personality

Calm, trustworthy, precise. Financial-grade reliability with a quietly professional voice.
Three words: **dependable, precise, unobtrusive.** The interface should make people feel that
their pay is in careful hands. Voice is plain and reassuring — clear labels, honest states,
never cute or jargon-heavy.

## Anti-references

- **The generic AI / Bootstrap template look:** purple gradients, equal-weight everything, no
  real hierarchy, decoration standing in for structure. The design should never read as a
  default scaffold.
- **Toy-like or playful:** bright primaries, rounded-everything, emoji-as-UI. This software
  handles people's pay; it must feel grown-up.

## Design Principles

1. **Trust through precision.** Money reads as exact and verifiable — tabular numerals,
   unambiguous states (good / warn / bad), visible audit trails. No detail is "close enough".
2. **Clarity over cleverness.** One primary task per screen; lower cognitive load for the
   repetitive flows admins run every pay period.
3. **Preserve the identity.** Navy + gold is the established brand. Extend the existing token
   system; don't reinvent it.
4. **Confidence without noise.** Restrained color and motion. Emphasis is earned, not sprayed —
   gold is an accent, not a fill.
5. **Two audiences, one system.** Dense efficiency for admins; gentle, guided reassurance for
   contractors in the portal — built from the same tokens.

## Accessibility & Inclusion

Target **WCAG 2.1 AA**. Body text ≥ 4.5:1 contrast, large text ≥ 3:1 (the token set is already
tuned for this — e.g. `--subtle` was darkened to hit 4.5:1). Visible keyboard focus on every
interactive element (`:focus-visible` is global). Respect `prefers-reduced-motion` (all motion
is gated behind it). Use `tabular-nums` for all monetary and time figures so columns align and
scan cleanly.
