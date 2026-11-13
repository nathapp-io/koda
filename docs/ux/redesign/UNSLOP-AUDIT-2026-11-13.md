# Koda page-by-page unslop audit — 13 November 2026

Audited after polish commit `ddfb7b4` on `style/koda-unslop-page-audit`. This report proposes follow-ups; this audit adds no product changes. Verdict: **light residual slop**. Keep the existing direction and address the specific findings below.

**Follow-up:** U01–U09 are now resolved on this branch. See the [resolution record](UNSLOP-FIXES-2026-11-13.md) for changes, verification and remaining coverage limits. The original observations below are retained as audit history.

## Direction

- **Product:** Koda gives engineering teams one workbench for tickets, agent conversations, approvals and fleet execution.
- **Character:** Calm, exact, workmanlike.
- **World:** An engineering workbench: slate surfaces, system typography, restrained indigo, meaningful status colors.
- **Moments:** Ticket content and execution progress carry the detail; the shell stays quiet.
- **Signature:** Ticket references connect planning, discussion and execution. Preserve their consistent treatment.

## Coverage and evidence

All **52 page files** were opened through the local API-backed app at desktop 1440×900 in dark and light themes and mobile 390×844 in dark: **156 route/view checks, no navigation errors**. `/projects` resolves to the dashboard, so this is 51 distinct destinations plus one redirect. Responses were 200 after redirects; that does not mean every data request succeeded. Captured screens were compared in contact sheets, with individual inspection of problem screens and a role editor dialog.

Local fixtures populated the board, ticket comments, completed job/story progress, disabled schedule, completed flow, repo, project and workspace conversations, users, roles and audit rows. Empty states remain for agents, approval requests, memory, skill sources, credentials, runner health and spend-ledger charts. Repo config could only show its unavailable-provider error. No jobs were dispatched, schedules enabled, invites accepted or remote repositories changed. Only a dedicated disposable test database was populated.

Route measurements: [route-checks.json](unslop-2026-11-13/route-checks.json). Focused WCAG A/AA axe scans: [accessibility.json](unslop-2026-11-13/accessibility.json). Scans covered ticket detail, Dispatch, repo thread and roles list, with additional mobile Labels/Dispatch verification. This is not an accessibility certification or an exhaustive state/permission audit.

The graph was used for source discovery and cited-path coverage; current source was read for material findings. Graph metadata reported no recorded issue for the 16 checked paths, a best-effort signal rather than proof of completeness.

## Findings

### U01 · P1 · Dispatch controls need accessible names and valid radio markup

**Observed and rechecked after 10 seconds:** axe reports three unnamed inputs (Git ref, Feature, Max cost), three unnamed selects (Repo, Command, Shell command approvals), and three nested interactive radio controls. Visible labels exist, but the rendered fields have no IDs associating them with those labels. Each placement button contains a hidden radio input. The scan reports critical label/select-name and serious nested-interactive violations; these are axe impact levels, while P1 is this report's action priority.

Source: `apps/web/pages/[project]/fleet/dispatch.vue:146` and `:281`; shared `apps/web/components/ui/form/FormControl.vue:1` only renders a slot; `apps/web/components/fleet/NativeSelect.vue:3` binds an optional ID.

**Proposal:** associate labels and fields explicitly or restore shared form-control ID propagation; preserve description/error associations. Use one accessible radio control per choice and verify the actual Radix-rendered DOM and arrow-key behavior before selecting a fix. Re-run axe and keyboard checks on RUN, PLAN, REVIEW and FIX variants. Do not treat a CSS change as a fix for this finding.

### U02 · P2 · Labels create form breaks at mobile width

**Observed and rechecked:** at 390px, document width is 395px. The Create Label button extends to x=395; more importantly, the name field shrinks to roughly a few characters while the color controls take the row. This is the only document-level overflow in the 156 route/view checks.

Source: `apps/web/pages/[project]/labels.vue:128`: a fixed horizontal `flex items-end gap-4` form. [Mobile evidence](unslop-2026-11-13/labels-mobile.png).

**Proposal:** stack the name, color controls and submit button below `sm`; use full-width name input with `min-w-0`, 16px gaps, and restore the horizontal form at `sm`. Verify create and inline edit at 320/390/768px; a horizontally scrolling data table may remain, but the document/form should fit.

### U03 · P2 · Invalid invitation still offers account creation

**Observed and rechecked after 8 seconds:** `GET /api/invites/audit-invalid-token` returns HTTP 404 and `{ret:404,message:"Invite not found"}`. The page still renders `invite-accept-form`; `invite-invalid` is absent. The initial toast disappears, leaving an actionable-looking form without a valid invitation. [Mobile evidence](unslop-2026-11-13/invite-mobile.png).

Source: `apps/web/pages/invite/[token].vue:37` checks `extractErrorStatus(err) === 404`; `apps/web/composables/useApi.ts:240` converts response envelopes into `ApiError`, whose code is stored as `.code` (`:20`), while `extractErrorStatus` (`:113`) checks `.status`/`.response.status` only.

**Proposal:** handle the normalized API error code at the invite boundary (or preserve HTTP status deliberately in the shared error contract), show persistent invalid/expired-link copy, and hide submission unless preview loading succeeded. Verify not-found, expired, transient failure, existing-account and valid invitation states. This needs a behavioral fix and regression coverage.

### U04 · P3 · Interior section labels still shout

**Observed:** ticket Description, Activity, Next step, Properties, Labels, Linked and Fleet runs retain uppercase tracked headings; the role editor similarly uppercases permission groups. These conflict with the now sentence-case shell labels. [Ticket evidence](unslop-2026-11-13/ticket-dark.png), [role editor evidence](unslop-2026-11-13/role-editor-dark.png).

Source: `TicketProperties.vue:106`, `TicketActivity.vue:37`, `TicketFleetRuns.vue:98`, `PermissionMatrix.vue:10` under `apps/web/components/`. Assignee menu groups (`AssigneePicker.vue:122`, `:141`) and config tree groups (`fleet/config/NaxFileTree.vue:15`) use the same pattern in source; these latter states were not visually verified.

**Proposal:** retain existing grouping and density; remove CSS uppercasing/tracking and use 12px/500 muted labels. Humanize permission group names where their source is already uppercase, while leaving actual permission keys and ticket references unchanged.

### U05 · P3 · Comment type badges use light surfaces in dark mode

**Observed:** Verification and Fix Report badges become bright pastel islands in the dark ticket activity panel. Their semantics are useful, but their treatment is disconnected from the quieter token-based ticket states.

Source: `apps/web/components/CommentThread.vue:46` maps Verification/Fix Report/Review directly to blue/orange/green `100` backgrounds and `800` text without dark variants. [Ticket evidence](unslop-2026-11-13/ticket-dark.png).

**Proposal:** retain type labels; use semantic token foregrounds with subtle tinted or neutral backgrounds, 12px/500 text, and verify contrast in both themes. Do not remove meaningful type distinctions.

### U06 · P3 · Auth pages retain heavier type and incomplete page titles

**Observed:** login and closed registration use 30px/700 headings; the invite form uses 24px/700. Register and invitation have empty document titles in the browser sweep, while login is `Sign in · Koda`. Register also adds a one-off 24px top margin inside the auth card.

Source: `apps/web/pages/login.vue:4`, `apps/web/pages/register.vue:4`, `apps/web/pages/invite/[token].vue:84`. [Login evidence](unslop-2026-11-13/login-dark.png).

**Proposal:** keep the existing centered auth layout and logo; use a shared 28px/500 auth heading with 16–24px consistent grouping. Add translated contextual document titles for registration/invitation. Registration-open and valid-invitation form states still need visual verification.

### U07 · P3 · Successful job progress overuses the primary accent

**Observed:** the completed-job view repeats indigo-filled Passed badges across stories and post-run checks, competing with the selected Graph/List control. This spreads the primary-action color over routine history. [Job evidence](unslop-2026-11-13/job-dark.png).

Source: `apps/web/lib/fleet-jobs.ts:116` maps passed stories to the default Badge variant. Inspect the corresponding post-run badge renderer when implementing so all successful states agree.

**Proposal:** use quiet semantic success text/dot or a neutral outlined badge for passed work; retain stronger failure and active-work signals. Keep labels, graph structure and series meaning unchanged. Recheck running, failed and mixed-result jobs before applying broadly.

### U08 · P3 · Conditional: pending approval chip pulses continuously

**Source-confirmed; not observed with a populated pending queue:** `apps/web/components/fleet/ApprovalBadge.vue:6` animates the whole amber chip and nests a destructive count pill. The component can appear throughout the shell.

**Proposal:** static subdued amber indicator, plain count and visible waiting label; reserve motion for a short arrival event and respect reduced motion. Verify with a real pending request before finalizing. Thread streaming animation is purposeful live feedback and is excluded from this finding.

### U09 · P3 · Conditional: knowledge search results use bold, hardcoded severity pills

**Source-confirmed; search results/verdicts not populated:** `apps/web/components/KbResultCard.vue:18` hardcodes HIGH/MED/LOW and raw red/yellow/gray palettes; `:28` uses 700 weight. `KbVerdictBanner.vue:17` and `:26` tint the full verdict surface red/yellow. Similarity and duplicate warnings are meaningful, so color is not itself a defect.

**Proposal:** localized sentence-case similarity labels, 12px/500 treatment, semantic tokens and a restrained verdict indicator. Preserve the score and duplicate warning. Populate high/medium/low, duplicate/related/no-match results and check both themes before deciding how much tint to reduce.

## Page-by-page record

Each row includes desktop dark, desktop light and mobile dark. “No new finding” means only the rendered state passed this visual pass; it does not clear unvisited dialogs, loaded states, permissions or data variants. `:project` was `fleet-e2e`; dynamic IDs resolved to local fixtures. Findings U08 and U09 remain conditional across the appropriate pages.

| # | Route | State inspected | Result |
| --- | --- | --- | --- |
| 1 | `/:project/agents` | Empty project agent list | No new finding |
| 2 | `/:project/approval-policies` | Approvable-key catalog | No new finding; pending badge U08 |
| 3 | `/:project/approvals` | Empty pending queue | No new finding; populated queue unverified |
| 4 | `/:project/code-intel` | Initial search prompt | No new finding; symbol results unverified |
| 5 | `/:project/fleet/analytics` | Empty spend ledger + completed job row | No new finding; populated charts unverified |
| 6 | `/:project/fleet/budgets` | Empty project/repo policies | No new finding |
| 7 | `/:project/fleet/dispatch` | RUN form with repo/ticket options | U01 |
| 8 | `/:project/fleet` | Repo and completed job list | No new finding |
| 9 | `/:project/fleet/jobs/:id` | Completed job, two stories + checks | U07 |
| 10 | `/:project/fleet/jobs/:id/logs` | Empty run/stdout/stderr viewer | No new finding; log lines unverified |
| 11 | `/:project/fleet/overview` | No runners/active jobs + finished job | No new finding |
| 12 | `/:project/fleet/repos/:id/config` | Provider unavailable error | Tree editor unverified; U04 source candidate |
| 13 | `/:project/fleet/schedules/:id` | Disabled schedule details | No new finding |
| 14 | `/:project/fleet/schedules` | One disabled schedule | No new finding |
| 15 | `/:project/flows/:id` | Completed flow + feature | No new finding; fixture caveat below |
| 16 | `/:project/flows` | One completed flow | No new finding |
| 17 | `/:project` | Populated board in several columns | No new finding; board scroll intentional |
| 18 | `/:project/kb` | Initial knowledge search | U09 conditional; populated results unverified |
| 19 | `/:project/labels` | Create form + empty labels list | U02 |
| 20 | `/:project/memory` | Filters + empty memory list | No new finding |
| 21 | `/:project/settings` | General settings, members/invites/keys | No new finding; other tabs source-reviewed |
| 22 | `/:project/threads/:id` | Repo thread with completed conversation | No new finding; streaming/tools unverified |
| 23 | `/:project/threads` | One active repo thread | No new finding |
| 24 | `/:project/threads/new` | Repo thread form; no installed runner | No new finding |
| 25 | `/:project/tickets/:ref` | Assigned ticket, typed comments, linked run | U04, U05 |
| 26 | `/:project/timeline` | Filters + empty timeline | No new finding |
| 27 | `/admin/approval-policies` | Global approvable-key catalog | No new finding |
| 28 | `/admin/audit` | Populated audit rows + filters | No new finding |
| 29 | `/admin/fleet/analytics` | Empty global spend/ingest | No new finding; charts unverified |
| 30 | `/admin/fleet/budgets` | Empty fleet-wide policies | No new finding |
| 31 | `/admin/fleet/credentials` | Empty credential board | No new finding |
| 32 | `/admin/fleet` | No runners/active jobs + finished job | No new finding |
| 33 | `/admin/fleet/provider-keys` | Provider key form + empty list | No new finding |
| 34 | `/admin/fleet/repos` | One repo with overrides/actions | No new finding; table scroll intentional |
| 35 | `/admin/fleet/runners` | No enrolled runners | No new finding |
| 36 | `/admin/outbox` | Empty dead-event list | No new finding |
| 37 | `/admin/roles` | Roles list + Admin edit dialog | U04 |
| 38 | `/admin/skills` | Empty skill sources | No new finding |
| 39 | `/admin/slos` | Zero-valued metrics + date filters | No new finding; nonzero data unverified |
| 40 | `/admin/users` | Admin user + role/status controls | No new finding |
| 41 | `/agents` | Empty workspace agents | No new finding |
| 42 | `/approvals` | Empty global pending approvals | No new finding; pending badge U08 |
| 43 | `/` | Assigned ticket + project summary | No new finding |
| 44 | `/invite/:token` | Invalid token response + form | U03, U06 |
| 45 | `/login` | Sign-in form | U06 |
| 46 | `/notifications` | Empty notification inbox | No new finding |
| 47 | `/projects` | Redirect to dashboard | No independent page |
| 48 | `/register` | Registration closed | U06; open registration unverified |
| 49 | `/settings/notifications` | In-app/email preference rows | No new finding |
| 50 | `/threads/:id` | Workspace thread with conversation | No new finding |
| 51 | `/threads` | One active workspace thread | No new finding |
| 52 | `/threads/new` | Workspace thread form; no runner | No new finding |

## Scope limits and excluded false positives

- Dense boards and tables scroll inside their own containers. They were not counted as document overflow.
- Semantic warning/error notices, uppercase ticket references/permission keys and the streaming activity dot are purposeful. They are not decoration to remove.
- The first early ticket capture showed blank client-formatted dates before mounting; later hydrated checks showed valid dates. Not recorded as a product defect.
- The direct database flow fixture used an unsupported `entry` value (`spec`) instead of the UI's `THREAD`/`NAX` values, producing a raw translation key. This is fixture contamination and is excluded from findings; normal flow-entry rendering still needs a valid-fixture check.
- No live runner, real forge integration, populated spend-ledger chart, approval decision, valid invite, registration-open form, search result, failed job or streaming thread was exercised. No claim is made that these states have passed.
- Initial viewport screenshots, source review and focused deeper checks are not exhaustive full-page interaction tests. All project settings tabs were source-reviewed; the browser inspected General.

## Recommended sequence and completion criteria

1. Fix U01–U03 with behavioral/accessibility regression checks, mobile layout verification and the relevant permission/error states.
2. Apply U04–U07 as a small shared-component polish pass. Preserve routes, workflows, content order, palette and system font. Compare populated light/dark/mobile screens.
3. Populate the states for U08–U09 before final styling decisions. Recheck real semantic contrast and reduced motion.

The existing polish remains committed. These findings are pending proposals, not fixes made by this audit. No redesign or hero artwork is needed; no image-generation prompt was used.

## Verification and attribution

Before committing the polish: 25 targeted Jest suites / 224 tests and changed-file lint passed. The earlier full-polish record documents 469 suites / 5,587 tests, typecheck and additional browser checks. This audit adds 156 browser route/view checks, six focused axe scans across five distinct destinations (Dispatch rechecked on mobile), and dedicated invalid-invitation error verification. The four original axe reports are committed; the mobile recheck reproduced the same Dispatch rules and found none on Labels. These checks expose pending defects and must not be described as an entirely passing suite.

Uses the unslop audit framework by [Damir Sokolovsky (@heydamir)](https://x.com/heydamir), CC BY 4.0. Direction adapted to Koda's established design system.
