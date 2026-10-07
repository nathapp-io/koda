# Koda Web UX Redesign — Master Plan

> Source of truth for the multi-session redesign of `apps/web`.
> A fresh session should read this file first, then the slice it is about to work on.
> Update the **Status** table and **Decisions log** at the end of every slice.

Slice 0: branch `feat/web-ux-redesign-shell`, PR #215 (nathapp-io/koda). Later slices branch from `main` after the previous one merges.

User intent (2026-10-05): redesign the whole Koda UI/UX, **especially the UX**, using the ui-ux-pro-max skills. The user approved the look of `shell-preview.html`. Never commit, push or open PRs without being asked.

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
- Verification before claiming done: `cd apps/web && bunx jest` (all pass), `bunx eslint <changed files>`, and `cd apps/web && bunx playwright test` (e2e; needs the test Postgres up via `bun run test:db:up` in `apps/api`). `vue-tsc` currently reports missing Nuxt auto-import types in `server/utils/api.ts` (pre-existing). `bunx nuxt prepare` is the likely fix but needs Node 22+ (the repo requirement); it fails on Node 18, so switch Node first. This is untested beyond that failure.

## 4. Status

| # | Slice | Status |
|:--|:------|:-------|
| 0 | Shell, tokens, command palette, board filters | **Done** (PR #215 merged 2026-10-05) |
| 1 | Ticket detail page | **Done** (PR #222 merged 2026-10-06) |
| 2 | Dashboard / home | **Done** — PR #223 (`GET /home` aggregate API + needs-you/projects/activity dashboard) |
| 3 | Shared patterns + docs refresh | **Done** — PR #223 (`lib/ticket-chips.ts` + `FilterBar.vue`; docs/ux refreshed) |
| 4 | Fleet pages | **Done** — PR #223 (jobs list state chips + running-first, approvals keyboard inbox) |
| 5 | Settings, KB, Agents, Labels, auth pages | **Done** — feat/web-ux-slice-5 (settings split into SettingsProjectCard/SettingsVcsCard, token agent chips, PageHeader icon slot, FilterBar on memory/timeline, auth brand mark) |
| 6 | Polish: a11y audit, e2e, responsive sweep | **Done** — feat/web-ux-slice-6 (token-contrast jest guard + destructive-text swap, axe e2e with zero allowlists, drawer/palette/board-filter journeys, responsive sweep, dead-primitive removal; PR to follow) |

## 4b. Effort estimate (2026-10-05, a guess from file sizes, not measured)

About 6 more PRs, 8 to 12 focused sessions (2 to 3 weeks with review; up to 4 if the dashboard needs new API endpoints).

| Slice | Effort | Main risk |
|:--|:--|:--|
| 1 Ticket detail | 1.5 to 2 sessions | Splitting a 721-line page while ticket tests stay green |
| 2 Dashboard | 1 to 3 sessions | Possible new aggregate API endpoint |
| 3 Shared patterns + docs | 1 session | Keep it small |
| 4 Fleet pages (~20 files) | 2 to 3 sessions | Many pinned tests; charts and log viewers stay untouched |
| 5 Remaining pages | 2 to 3 sessions | Settings (502 lines) is the largest |
| 6 Polish + e2e | 1 to 2 sessions | Needs running app and test Postgres |

Recommended order: do slices 1 and 2 (most daily UX value), then decide whether 4 and 5 are worth the cost. They can be cut to the highest-traffic pages (fleet jobs and approvals, Settings), saving 3 to 4 sessions.

## 5. Slice 0 — shipped (reference)

Files changed:
- `layouts/default.vue`: grouped sidebar (project block first via flex `order-first`, then Workspace and Admin), section labels, mobile drawer + backdrop (auto-closes on route change), skip link, `aria-label`ed nav, header search button opening the palette, global Cmd/Ctrl+K handler, Menu/Search/Settings icons.
- `components/CommandPalette.vue` (new): Dialog with combobox/listbox semantics, arrow/enter navigation, static destinations + project-scoped pages + projects fetched from `/projects` on open + theme toggle.
- `components/TicketBoard.vue`: status dots, wider columns. `components/TicketCard.vue`: priority left stripe, keyboard activation (`role="button"`, Enter/Space), 2-line title clamp.
- `pages/[project]/index.vue`: client-side search + priority chips + "Showing n of total" (loaded tickets only).
- `assets/css/globals.css`, `tailwind.config.ts`: tokens above, `:focus-visible` ring, reduced-motion rule.
- `i18n`: `nav.{skipToContent,primary,section*}`, `palette.*`, `tickets.filter.*` (en + zh).

Known limits (deliberate, track in later slices):
- Board filter is client-side over loaded pages only (page size 100). If tickets exceed one page, filtering will not see unloaded ones. The API already supports server-side filters on `GET /projects/:slug/tickets`: `status`, `type`, `priority`, `assignedTo` (user id or `self`) and `unassigned` (see `apps/api/src/tickets/dto/list-tickets.query.ts`). It has **no text search** param. Follow-up: send the priority chip as `priority=` to the API and keep ref/title search client-side, or add a `q` param in `apps/api` (API-owned, then `bun run generate`).
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
- Requires API data. Already available: ticket list filters incl. `assignedTo=self` and `status`/`priority` (see §5), `memory/timeline.controller.ts`, fleet approvals and jobs endpoints under `/fleet/*`. Not yet checked: a cross-project "my tickets" call (the ticket list is per project) and failed-job listing. If an aggregate endpoint is missing, add it in `apps/api` (API-owned), then `bun run generate` for the CLI client. Do not aggregate heavy data in the browser.
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
   - Known issue (2026-10-05): plain `bun run dev` 500s every page — `@nuxt/devtools@4.0.0-alpha.17` breaks `nuxt dev` (`#app-manifest` resolve failure → "Cannot access 'renderer' before initialization"). Workaround until fixed: `E2E_RUN=1 bunx nuxt dev --port 3101` (devtools off — this is how Playwright e2e boots the app, so it works). Verified this way: API on test Postgres (`bun run test:db:up` + `prisma db push` + `seed.ts`, `DATABASE_URL=postgresql://koda:koda@localhost:5433/koda_test`), then SSR 200s for `/login`, `/register`, `/`, `/projects`, a board, and a ticket page.
4. Pick the next "Not started" row in §4.

## 10. Decisions log

| Date | Decision | Why |
|:-----|:---------|:----|
| 2026-10-05 | Linear-style dense dev-tool look, indigo accent, system fonts | Fits a ticket + agent-fleet tool; no new font dependency or network load |
| 2026-10-05 | Project nav first via CSS `order-first`, DOM order unchanged | Layout tests pin source order; UX wants project links on top |
| 2026-10-05 | Client-side board filter for now | Simplest for a UI-only slice. Correction: the API does support `priority`/`status`/`type`/`assignedTo` filters (not text search); server-side priority filtering is a cheap follow-up |
| 2026-10-05 | Discard the ui-ux-pro-max auto-generated design system | It returned a wedding-style pink palette and landing-page pattern; not a fit for a dev tool |
| 2026-10-05 | Keep nav links inline in the layout template | Layout tests render the template with a fixed binding set; data-driven nav would render empty there |
| 2026-10-05 | Fleet overview links: `/admin/fleet` first in the admin fleet group, `/<project>/fleet/overview` above Fleet jobs (icon `Gauge`, label `nav.fleetOverview`), plus a command palette entry | Fleet S2b (c) dashboard (spec `docs/superpowers/specs/2026-10-05-fleet-s2b-c-dashboard-design.md` §4.1); slice 4 (fleet pages) restyles it with the rest |
| 2026-10-05 | Fleet job page: the flat story list becomes a Graph \| List toggle (Graph default at `md`+, choice kept in `localStorage` `koda.fleet.storyView`) with a RUN stage strip above it | Fleet S2b (j) (spec `docs/superpowers/specs/2026-10-05-fleet-s2b-j-story-graph-design.md` J3); slice 4 (fleet pages) restyles it with the rest |
| 2026-10-05 | Slice 1: page split into `TicketHeader` / `TicketActivity` / `TicketProperties`; the source-grep specs (`ticket-detail`, `ticket-detail-priority`, `ticket-edit-markdown`, `ticket-role-visibility`, `web-gap-ops`) now read the page + relevant components as one surface | The old specs grepped the 721-line page file; the split moves those strings into components. Assertions unchanged in intent, updated only in what they read |
| 2026-10-05 | Slice 1: action hierarchy in `TicketActionPanel` = exactly one filled primary (first of verify → start → fix → approveFix present), others outline, reject destructive. The mock's "More actions" dropdown is deferred to slice 6 | Ticket e2e journeys (`ticket-lifecycle`, `ticket-project-roles`, `ticket-detail-operations`) require each action to be a visible button by name; collapsing them into a menu means rewriting those journeys (do it together in slice 6) |
| 2026-10-05 | Slice 1: properties rail omits the status/priority/type chips the mock showed — the header chips row carries them | Same facts twice in one viewport read as noise; rail keeps assignee, created, git ref, synced-from, labels, links, danger zone |
| 2026-10-05 | Slice 1: rail mutations (assign/label/link/delete/transition) reload via silent GETs (`Promise.all`), never `refresh()` | `refresh()` flips `pending`, swaps the page for `LoadingState` and unmounts the rail mid-interaction — caught by the add-link e2e (input wiped between fill and click) |
| 2026-10-05 | Slice 1: chip markup keeps the label on the same line as the dot span | Playwright `getByText(/^X$/)` does not whitespace-normalize; a mustache on its own line renders `" X"` and broke `ticket-lifecycle`. `{ exact: true }` normalizes, regex does not |
| 2026-10-05 | Slice 1: activity timeline of system events (transitions, PR links) is not built — `CommentThread` stays the only activity source | Needs timeline/aggregate API data (same gap as the dashboard slice); revisit in slice 2 or 3 |
| 2026-10-06 | Slice 2: the dashboard's data comes from a new aggregate endpoint `GET /home` (`apps/api/src/home`), not browser-side fan-out | The plan's rule: API-owned aggregation, one request per dashboard. Member projects for users (all live projects for a global admin), pending approvals incl. no-project ones for admins, 7-day failed-job window, blocked jobs derived from pending approvals. openapi.json + CLI client regenerated |
| 2026-10-06 | Slice 2: "attention jobs" = FAILED/ESCALATED/CRASHED finished within 7 days plus QUEUED/ASSIGNED jobs holding a pending approval; per-project "attention" counts use the same set | "Needs you" should be finite and recent; everything older is history the fleet pages already cover |
| 2026-10-06 | Slice 2: caps at 8/8/8/10 (tickets/approvals/jobs/activity) with exact totals next to each list | Totals stay true behind the caps so "n of m" is honest without pagination on the dashboard |
| 2026-10-06 | Slice 2: `tests/pages/projects-index.spec.ts` deleted; `loading-states.spec.ts` grid pin now reads `data-testid="home-needs-you"` behind the v-else chain; harness `mount-sfc.ts` gained `useAsyncData` as an injectable auto-import | The card grid the old spec pinned no longer exists; the behavioral replacement is `tests/pages/home-dashboard.spec.ts` + three component specs |
| 2026-10-06 | Slice 3: one chip source — `lib/ticket-chips.ts` (dot/chip/stripe/type classes + safe fallbacks); TicketHeader, TicketBoard, TicketCard, HomeNeedsYou import it | Four copies of the same maps had already drifted (TicketCard used raw palette colors that break in dark mode); the per-level classes are pinned once in `tests/lib/ticket-chips.spec.ts` |
| 2026-10-06 | Slice 3: TicketCard's type/priority badges became the shared dot+label chips; `TicketCard.spec.ts` color pins moved to the token classes; `prStateVariant` (PR dots) kept as-is | The spec pinned the old red/blue/orange palette classes; token chips are the same hues via tokens and survive theme switches. No PR-state tokens exist yet, so that dot stays palette-colored |
| 2026-10-06 | Slice 3: `FilterBar.vue` extracted (literal `grid gap-3 sm:grid-cols-4`, slot-only) and adopted by the fleet jobs list; the stat row was NOT extracted — `fleet/dashboard/Tiles.vue` stays the pattern and is documented in component-patterns.md | Filter rows repeat; the stat row exists once, and promoting it would be speculative until a third page needs it |
| 2026-10-06 | Slice 3: docs refresh — navigation-map.md (real sitemap + grouped sidebar/drawer/palette rules), design-tokens.md (token tables replace palette badges), component-patterns.md (chips + shared patterns); `.nax/mono/apps/web/context.md` updated and agent files regenerated with `nax generate` | §8 listed all four as stale after slice 0 |
| 2026-10-06 | Slice 4: the jobs-list state filter became a single-select chip row (All + the nine API states) driving the same `filters.state`; the three name filters keep the shared `FilterBar columns="3"` | The API takes exactly one `state`, so chips are honest one-to-one; the pinned `fleet-filter-state` testid moved to the chip group |
| 2026-10-06 | Slice 4: running-first ordering is a client-side sort of the loaded page (`runningFirstJobs` in lib/fleet-jobs.ts): RUNNING/UPLOADING first (longest-running on top), then newest-queued | The API owns cross-page order and takes one state filter; a true cross-page running-first would be an API sort param — noted as a follow-up, not a UI lie |
| 2026-10-06 | Slice 4: approvals inbox gained a keyboard layer — j/k or arrows move a cursor, Enter opens, A approves, D denies, Esc closes; decisions go through the same `onDecide` path and `keyboardDecision` in lib/fleet-approvals.ts | Budget asks are D-only from the keyboard (approve needs a typed amount); a cut bash ask is deny-only, mirroring `bashChoices`. Keys ignore typing targets; the whole flow is covered by inbox component tests + the existing decide e2e |
| 2026-10-06 | Slice 4: chart wrappers untouched, cost column already existed (fleet S1) | MASTER-PLAN §6 slice 4 constraints |
| 2026-10-06 | Slice 5: Settings kept its existing two Tabs (project / VCS); the 502-line file was split into `SettingsProjectCard` + `SettingsVcsCard` instead of adding a sticky section nav | With only two sections a sticky nav is chrome, not UX |
| 2026-10-06 | Slice 5: agent status chips map ACTIVE/PAUSED/OFFLINE to the ticket status tokens done/review/todo; `tests/pages/agents.spec.ts` palette pins replaced with token pins | Deliberate spec change — the old pins held raw palette classes that break in dark mode; tokens are the slice-3 chip source |
| 2026-10-06 | Slice 5: settings source-grep specs (incl. the web-gap-ops spec, repointed) read page + SettingsVcsCard as one surface; e2e testids unchanged | Slice-1 precedent: splitting a file moves the grepped strings into components; assertions unchanged in intent |
| 2026-10-06 | Slice 5: no mock previews — every change reuses an established pattern (chips, FilterBar with an SSR-aware `stubFilterBar` helper in the memory/timeline specs, PageHeader icon slot) | Each change is an existing pattern applied to another page, not a new layout worth mocking first |
| 2026-10-06 | Slice 5: login/register pages untouched (register's root class is pinned; both already conform) — only the auth layout gained a brand mark | Smallest change that satisfies the slice; the pages already match the redesign language |
| 2026-10-06 | Slice 6: TicketActionPanel keeps the flat secondary stack — the mock's "More actions" dropdown is NOT built | At most 3 secondary actions ever render (`secondaryActions` in `components/TicketActionPanel.vue`); hiding them behind a menu adds a click and contradicts needs-attention-first; three e2e journeys (`ticket-lifecycle`, `ticket-project-roles`, `ticket-detail-operations`) select actions by visible name. Resolves the deferral in the 2026-10-05 slice-1 row |
| 2026-10-06 | Slice 6: contrast convention — `--destructive` is fill-only; destructive text on card/background uses `text-status-rejected` (dark-stepped token); light `--status-rejected` stepped to `0 72% 50%` | No single dark red passes both white-on-it (filled buttons, 6.70:1) and on-dark-card (2.68:1 → 6.01:1 after the swap); the light step (4.56:1 on background) also stops light `--status-rejected` literally equaling light `--destructive`. Guarded by `tests/lib/token-contrast.spec.ts` |
| 2026-10-06 | Slice 6: axe e2e added with zero allowlists — 12 real violations fixed in source (html lang, login title, sidebar/ticket-board contrast, BackButton aria-label, select placeholder labels, ColorPicker label prop, MarkdownEditor $attrs) | Allowlists hide regressions; every violation found had a small source fix. Known one-line follow-up if the design owner wants a dedicated token: `dark:text-ring` reuse on the TicketBoard new-ticket button |
| 2026-10-06 | Slice 6: responsive sweep was objective — throwaway Playwright overflow sweep (17 pages × 4 viewports × light/dark), not a manual pass | Manual sweeps are not repeatable; the script found 2 issues, both fixed (PageHeader actions row @375, TicketHeader long tokens @375); fleet pages swept empty-state only |
| 2026-10-06 | Slice 6: only `ui/separator/` was dead; `form/` + `radio-group/` stay, `setup.spec.ts` component list updated minimally | `form/` and `radio-group/` are live via Nuxt auto-import (no direct import to grep); separator had zero references |
| 2026-10-07 | Ticket page: a Dispatch link next to Edit (DEVELOPER+, project has a fleet repo, ticket open) and a "Fleet runs" card under the header; fleet PR links get a "via fleet" chip | Fleet C9 slice 2 (spec `docs/superpowers/specs/2026-10-06-fleet-c9-ticket-work-products-design.md` §4, D461); built from existing tokens and components (C9-5, no design pass) |
