# Koda Web UX Redesign — Master Plan

> Source of truth for the multi-session redesign of `apps/web`.
> A fresh session should read this file first, then the slice it is about to work on.
> Update the **Status** table and **Decisions log** at the end of every slice.

Branch for slice 0: `feat/web-ux-redesign-shell`. Later slices branch from `main` after the previous one merges.

---

## 1. Goal

Make Koda faster to scan and operate for both humans and AI-agent supervisors. The emphasis is **UX** (navigation, flows, what needs attention) over decoration.

Principles:
1. **Needs-attention first.** Summaries and actionable items before detail.
2. **Project context is primary.** When inside a project, project navigation comes first.
3. **Keyboard and mobile are first-class.** Cmd/Ctrl+K, visible focus, drawer nav below 1024px.
4. **Dense, not cramped.** Linear-style density; one indigo accent; semantic colors only for state.
5. **State is never color alone.** Pair every status/priority color with a label or shape.

## 2. Visual direction

- Neutral slate surfaces, one indigo accent, tight density, subtle borders.
- System font stack (no new font dependency); `font-mono` for refs, IDs, logs.
- Tokens live in `apps/web/assets/css/globals.css` (HSL CSS variables, light + dark) and are exposed in `apps/web/tailwind.config.ts`:
  - core: `background foreground card muted accent primary destructive border input ring`
  - state: `status-{todo,active,review,done,rejected}`, `priority-{critical,high,medium,low}`
  - charts keep `--chart-1..8` (unchanged, used by unovis)
- Visual reference (open in a browser): [`shell-preview.html`](./shell-preview.html). It is a static mock with example data, not production code.

## 3. Hard constraints (read before touching code)

- Web strings: `apps/web/i18n/locales/{en,zh}.json`, both files, same keys. API i18n is separate.
- Do not move business logic into components. API owns workflow rules.
- Run logs and agent-written text use `{{ }}` only, never `v-html`.
- **Layout tests pin the template** (`apps/web/tests/layouts/*`). They SSR-render `layouts/default.vue` with a fixed set of setup bindings (`t, auth, route, sidebarOpen, projectSlug, breadcrumbItems, backTo, navLinkClass, activeClass, isGlobalAdmin`) and assert source order: SLO link before the project block; Timeline and Settings after KB; `py-4`/`px-6`/`w-56`/`fixed` present; label text immediately before `</a>`. Keep nav links inline in the template (not data-driven) and keep new template-only bindings optional. If a test must change, change it deliberately and say why in the PR.
- `TicketCard`/`TicketBoard` specs are source-pattern tests (they grep for `BUG`, `CRITICAL`, `font-mono`, `Avatar`, etc.). Additive edits only.
- Do not edit `apps/cli/src/generated/` or generated `AGENTS.md`.
- Verification before claiming done: `cd apps/web && bunx jest` (all pass), `bunx eslint <changed files>`. `vue-tsc` in this repo currently reports missing Nuxt auto-import types in `server/utils/api.ts` (pre-existing); run `bunx nuxt prepare` first if you need a clean type-check.

## 4. Status

| # | Slice | Status |
|:--|:------|:-------|
| 0 | Shell, tokens, command palette, board filters | **Done on branch `feat/web-ux-redesign-shell`** (see §5) |
| 1 | Ticket detail page | Not started |
| 2 | Dashboard / home | Not started |
| 3 | Shared patterns + docs refresh | Not started |
| 4 | Fleet pages | Not started |
| 5 | Settings, KB, Agents, Labels, auth pages | Not started |
| 6 | Polish: a11y audit, e2e, responsive sweep | Not started |

## 5. Slice 0 — shipped (reference)

Files changed:
- `layouts/default.vue`: grouped sidebar (project block first via flex `order-first`, then Workspace and Admin), section labels, mobile drawer + backdrop (auto-closes on route change), skip link, `aria-label`ed nav, header search button opening the palette, global Cmd/Ctrl+K handler, Menu/Search/Settings icons.
- `components/CommandPalette.vue` (new): Dialog with combobox/listbox semantics, arrow/enter navigation, static destinations + project-scoped pages + projects fetched from `/projects` on open + theme toggle.
- `components/TicketBoard.vue`: status dots, wider columns. `components/TicketCard.vue`: priority left stripe, keyboard activation (`role="button"`, Enter/Space), 2-line title clamp.
- `pages/[project]/index.vue`: client-side search + priority chips + "Showing n of total" (loaded tickets only).
- `assets/css/globals.css`, `tailwind.config.ts`: tokens above, `:focus-visible` ring, reduced-motion rule.
- `i18n`: `nav.{skipToContent,primary,section*}`, `palette.*`, `tickets.filter.*` (en + zh).

Known limits (deliberate, track in later slices):
- Board filter is client-side over loaded pages only (page size 100). If tickets exceed one page, filtering will not see unloaded ones. Fix: server-side query params once the API supports them (API-owned).
- Timeline sits in the Knowledge group only because tests pin it after KB.
- No drag-and-drop on the board; status changes happen on the ticket page.
- Palette searches nav + projects only, not tickets.
- Slice 0 was verified with Jest (2,932 passing) and ESLint; it has **not** been checked visually in a running app. Do that first (see §9).

## 6. Slice plans

### Slice 1 — Ticket detail (`pages/[project]/tickets/[ref].vue`, 721 lines)
Why first: most-used screen; humans and agents both act here.
- Two-column layout ≥1024px: left = title, description (markdown), activity/comment thread; right = sticky properties panel (status, assignee, priority, type, labels, linked PRs/issues).
- One **primary next action** (the next valid workflow transition from the API) as a prominent button; secondary actions in a menu. Do not re-implement transition rules; read what the API exposes via `TicketActionPanel`.
- Single column below 1024px with the properties panel collapsed under the title.
- Keyboard shortcuts for common actions (document them in the palette).
- Split the 721-line page into components (`TicketHeader`, `TicketProperties`, `TicketActivity`) while keeping existing behavior and tests green.
- Acceptance: all existing ticket tests pass; new component specs; both locales; no horizontal scroll at 375px.

### Slice 2 — Dashboard (`pages/index.vue`)
- Replace the plain project-card grid with: **Needs you** (assigned tickets, pending approvals, failed/blocked fleet jobs), **Projects** (compact rows with open/blocked counts), **Recent activity**.
- Requires API data. Check existing endpoints first (`/projects`, approvals, fleet jobs, project events/timeline). If an aggregate endpoint is missing, add it in `apps/api` (API-owned), then `bun run generate` for the CLI client. Do not aggregate heavy data in the browser.
- Empty state for a new workspace: one primary "Create project" action.

### Slice 3 — Shared patterns + docs refresh
- Extract repeated patterns found in slices 1–2 (page header with actions, status/priority chips, filter bar, stat row) into `components/` and use them in `PageHeader`.
- Replace ad-hoc `typeBadgeClass`/`priorityClass` helpers with token-based ones.
- Refresh `docs/ux/*` (see §8).

### Slice 4 — Fleet pages (`pages/[project]/fleet/**`, `pages/admin/fleet/**`)
- Jobs list: status filter chips, running-first ordering, cost column. Approvals: inbox layout with keyboard approve/deny.
- Keep chart wrappers (`*.client.vue`, unovis) and `--chart-*` colors untouched.
- Untrusted-text rule for logs still applies.

### Slice 5 — Remaining pages
Settings (502 lines: split into tabs/sections with sticky section nav), KB, Agents, Labels, Memory, Timeline, Code Intel, admin Users/SLOs, login/register (`layouts/auth.vue`).

### Slice 6 — Polish
Accessibility audit (contrast 4.5:1 both themes, focus order, labels), Playwright journeys for palette, board filter, drawer nav, a responsive sweep at 375/768/1024/1440, and removal of dead styles.

## 7. Working agreement for each slice

1. New branch from `main` (or from the previous slice's branch if unmerged): `feat/web-ux-<slice>`.
2. Mock first when the layout is non-trivial: update `shell-preview.html` (or add `<page>-preview.html` next to it) and get a "looks good" before porting.
3. Port to Vue; keep tests green; add tests for new logic.
4. Update en + zh i18n.
5. `bunx jest`, `bunx eslint` on changed files.
6. Update §4 Status and §10 Decisions log in this file in the same PR.
7. One PR per slice; PR description lists what changed, what was verified, what was not.

## 8. Docs that Slice 0 made stale

Update these in Slice 3 (or sooner if you touch the area):
- `docs/ux/navigation-map.md` — sidebar rules (grouping, order, drawer, palette, skip link). The "Sidebar Rules" and "Always Visible" sections no longer match `layouts/default.vue`.
- `docs/ux/design-tokens.md` — add the color, status and priority token tables; it currently only documents toasts and similar.
- `docs/ux/component-patterns.md` — "Badges" section describes the old status/priority badge approach; board cards now use a priority stripe plus text chips.
- `.nax/mono/apps/web/context.md` — mention `CommandPalette`, the token set, and the layout-test constraints in §3. (Do not edit generated `apps/web/CLAUDE.md`/`AGENTS.md` by hand; run `nax generate`.)

## 9. First steps for a fresh session

1. Read this file, then `docs/ux/redesign/shell-preview.html` (open it in a browser).
2. `git log --oneline -5` and `git status` to see which slice is current.
3. If Slice 0 has not been checked visually: `cd apps/web && bun run dev`, click through `/`, a project board, a ticket, in light and dark and at <1024px. Fix anything off before starting Slice 1.
4. Pick the next "Not started" row in §4.

## 10. Decisions log

| Date | Decision | Why |
|:-----|:---------|:----|
| 2026-10-05 | Linear-style dense dev-tool look, indigo accent, system fonts | Fits a ticket + agent-fleet tool; no new font dependency or network load |
| 2026-10-05 | Project nav first via CSS `order-first`, DOM order unchanged | Layout tests pin source order; UX wants project links on top |
| 2026-10-05 | Client-side board filter for now | API has no board filter params; avoid inventing backend scope in a UI slice |
| 2026-10-05 | Discard the ui-ux-pro-max auto-generated design system | It returned a wedding-style pink palette and landing-page pattern; not a fit for a dev tool |
| 2026-10-05 | Keep nav links inline in the layout template | Layout tests render the template with a fixed binding set; data-driven nav would render empty there |
