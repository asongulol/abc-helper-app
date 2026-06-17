# Design

> Captured from the live token system in `src/app/globals.css` (a faithful port of the legacy
> admin + portal CSS). This is the **existing committed identity** — preserve it by default;
> depart only when a PRODUCT.md anti-reference or an explicit request calls for it.

## Theme

Calm, trustworthy enterprise admin. Light neutral surfaces give a clean working canvas; **navy**
carries structure (topbar, sidebar, primary actions, links, focus); **gold** is a sparing
accent, never a fill. Legacy class names (`.card`, `.btn`, `.sub`, `.pill`, …) are kept
identical so ported screens drop in unchanged. The contractor portal reuses the same palette,
namespaced under `.portal`.

## Color Palette

**Brand**
- Navy `--navy` `#1f3a68` — primary structure & action · `--navy-700` `#162a4d` · `--navy-50` `#eef2f8`
- Gold `--gold` `#d4a24c` — accent only · `--gold-soft` `#f7edd8`
- `--accent` aliases navy, `--accent-soft` aliases `--navy-50` (re-skin in one place)

**Surfaces & ink**
- `--bg` `#f4f6f9` (app background) · `--card` `#ffffff` · `--surface-2` `#f8fafc`
- `--border` `#e4e8ee` · `--border-strong` `#ccd3dd`
- `--text` `#15233b` · `--muted` `#5c6677` · `--subtle` `#677083` (tuned to AA 4.5:1)

**Semantic states** (each with a soft background pair)
- Good `--good` `#0a7d3c` / `--good-soft` `#dcfce7`
- Warn `--warn` `#b45309` / `--warn-soft` `#fef3c7`
- Bad `--bad` `#b91c1c` / `--bad-soft` `#fee2e2`

## Typography

- Family: **Inter**, falling back to the system stack (`system-ui, -apple-system, "Segoe UI",
  Roboto, sans-serif`). No webfont is loaded — keep it that way (zero font flash).
- Base: `14px` / line-height `1.5`, antialiased, `optimizeLegibility`.
- **Tabular numerals** on table cells (`font-variant-numeric: tabular-nums`) for money/time
  alignment — extend this to any monetary figure.
- Links use `--accent` (navy), underline on hover.

## Shape, Elevation & Motion

- Radii: `--radius-sm` 7px · `--radius` 11px · `--radius-lg` 16px.
- Shadows: `--shadow-sm` (subtle), `--shadow` (card lift), `--shadow-lg` (overlays). All use
  cool navy-tinted rgba, not pure black.
- Focus ring: `--ring` `0 0 0 3px rgba(31,58,104,.22)`; global `:focus-visible` = 2px navy
  outline, 2px offset.
- Motion: `--dur` `0.16s`, `--ease` `cubic-bezier(0.2,0.6,0.2,1)`. Restrained, enterprise feel;
  **all motion disabled under `prefers-reduced-motion`.**

## Layout

- App shell: topbar `--topbar-h` 78px + sidebar `--side-w` 212px (collapsed `--side-w-collapsed`
  60px). Topbar background is navy.
- Spacing scale: `--space-1..6` = 4 / 8 / 12 / 16 / 24 / 32px.
- Breakpoints mirror Tailwind: `--bp-sm` 640 · `--bp-md` 768 · `--bp-lg` 1024.
- Skip-to-content link (`.skip-link`) for WCAG 2.4.1.

## Components

Legacy-named, reusable building blocks live in `globals.css` and `src/components/`:
`.card`, `.btn` (+ variants), `.sub` (subdued text), `.pill` (status chips), tables with
tabular numerals, the topbar/sidebar shell. Built with `class-variance-authority` + `clsx` +
`tailwind-merge` on Tailwind v4 (CSS-first config, no `tailwind.config`). **Reuse these before
introducing new patterns**; new variants should re-skin via the existing CSS variables so the
whole system shifts from one place.
