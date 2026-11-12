# SPEC: Shared UI: breadcrumb leaves, disabled filled buttons, select heights, touch targets

## Summary

Four shared-UI findings from the 2026-11 web audit (`docs/ux/redesign/AUDIT-2026-11.md`): R2-10, R2-12,
R2-13 and R2-16. Six project pages show a breadcrumb with no leaf. Disabled filled buttons keep their indigo
fill at half opacity and read as enabled, and the thread action bar puts the reason a button is disabled
inline beside it. Native filter selects on timeline, memory, outbox and audit are 29 to 36 px tall beside
40 px inputs. Several controls are under 32 px at 390 px. This feature gives those pages a breadcrumb leaf,
gives disabled filled buttons a muted look with the reason under the button, makes the filter selects as
tall as `Input`, and gives the listed small controls a 44 px touch target below the `sm` breakpoint.

## Motivation

- R2-10: `/<project>/approvals`, `/<project>/approval-policies`, `/<project>/timeline`, `/<project>/memory`,
  `/<project>/code-intel` and `/<project>/settings` fall through `breadcrumbItems` in `layouts/default.vue`
  to `[Koda, <project>]`, so the bar reads "Koda / sandbox" with the project as the unlinked leaf.
- R2-12: `components/ui/button/Button.vue` styles every disabled variant with `disabled:opacity-50`. On the
  `default` variant the indigo fill stays, so the KB Search button and the thread Publish/Plan/Run buttons
  look enabled. In `components/fleet/threads/ThreadActionBar.vue` the reason `<span>` is a sibling of the
  button in one wrapping row.
- R2-13: the timeline and memory filter selects use `px-2 py-1` (about 29 px), the outbox status select the
  same, and `components/fleet/NativeSelect.vue` (audit filters) uses `h-9`, while `Input` is `h-10`.
- R2-16: at 390 px the breadcrumb links are 20 px tall, the audit row expand button 20x20, the
  notification-settings checkboxes 16x16, the approval-notification toggle 32 px, and the flow list state
  links 17 px.

## Design

Touch-target convention (from slice 10, R1-20, `pages/[project]/index.vue` priority chips `h-11 sm:h-9`):
a control is 44 px (`h-11` / `min-h-11`) below the `sm` breakpoint and keeps its compact size from `sm` up.

### Integration

Read-only (verified, unchanged):

- `components/ui/input/Input.vue` renders `h-10`.
- `lib/utils.ts` `cn(...inputs)` = `twMerge(clsx(inputs))`; a later conflicting class wins.
- `tests/layouts/flows-nav.spec.ts` `breadcrumbItemsFor(path, params)` runs the real `layouts/default.vue`
  setup for one route and returns `breadcrumbItems.value`; the new breadcrumb spec copies this harness.
- `components/approvals/ProjectApprovalNavLinks.vue` labels its links `t('nav.approvals')` and
  `t('nav.approvalPolicies')`; the layout sidebar labels the others `t('nav.timeline')`, `t('nav.memory')`,
  `t('nav.codeIntel')` and `t('nav.settings')`. All six keys exist in both locale files.

Changed. The baseline exists only to locate the code; implement the target.

- `layouts/default.vue` `breadcrumbItems`
  - Baseline: no branch for the six paths; they reach the final `return [{ label: 'Koda', to: '/' }, { label: project }]`.
  - Target: for each path `/${project}/<page>` in the table below, return
    `[{ label: 'Koda', to: '/' }, { label: project, to: '/' + project }, { label: t(<key>) }]`.

    | page | key |
    |:--|:--|
    | `approvals` | `nav.approvals` |
    | `approval-policies` | `nav.approvalPolicies` |
    | `timeline` | `nav.timeline` |
    | `memory` | `nav.memory` |
    | `code-intel` | `nav.codeIntel` |
    | `settings` | `nav.settings` |

- `components/AppBreadcrumb.vue` link
  - Baseline: `<NuxtLink ... class="hover:text-foreground transition-colors">`
  - Target: the link class adds `inline-flex min-h-11 items-center sm:min-h-0`.
- `components/ui/button/Button.vue` `buttonVariants`
  - Baseline: `default: 'bg-primary text-primary-foreground hover:bg-primary/90'`, `destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90'`, base `disabled:opacity-50`.
  - Target: the `default` and `destructive` variants add `disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100`. The base and the other variants keep `disabled:opacity-50`.
- `components/fleet/threads/ThreadActionBar.vue` action markup
  - Baseline: `<Button>` and the reason `<span>` are siblings directly inside the `flex flex-wrap items-center gap-2` bar.
  - Target: the bar's `items-center` becomes `items-start`, so buttons stay top-aligned when a wrapper is taller.
    Each action renders in its own `flex flex-col gap-1` wrapper holding the button and, under it, the
    reason as a `<p>` with `id` `thread-action-<action>-reason`, `data-testid` `thread-action-<action>-reason`
    (unchanged) and class `text-xs text-muted-foreground`. When a reason shows, the button carries
    `aria-describedby` equal to that id; with no reason it carries no `aria-describedby`.
- `lib/form-control.ts` (new) exports `FILTER_CONTROL_CLASS = 'h-10 rounded-md border border-input bg-background px-3 text-sm'`, the class for raw native filter controls, matching `Input`'s height.
- `components/fleet/NativeSelect.vue` select class
  - Baseline: `h-9 w-full rounded-md border border-input bg-background px-3 text-sm`
  - Target: `FILTER_CONTROL_CLASS` plus `w-full`. Every `FleetNativeSelect` consumer (13 files, including the create-ticket, add-repo, budget, schedule and thread-handoff dialogs, fleet dispatch, new thread and the analytics and log filters) grows from 36 px to 40 px; that is intended, so form selects match `Input` too.
- `pages/[project]/timeline.vue` `#timeline-event-type`, `pages/[project]/memory.vue` `#memory-kind-filter` and `#memory-status-filter`, `pages/admin/outbox.vue` `#outbox-status`
  - Baseline: `rounded-md border border-border bg-background px-2 py-1 text-sm` (outbox adds `w-fit`).
  - Target: `FILTER_CONTROL_CLASS` (outbox keeps `w-fit`). They stay native `<select>` elements with their
    current ids, bindings and `@change` handlers.
- `pages/[project]/memory.vue` text search `<input type="search">` in the same filter row
  - Baseline: `rounded-md border border-border bg-background px-2 py-1 text-sm`
  - Target: `FILTER_CONTROL_CLASS`; it stays a raw `input` with its `v-model`, `maxlength` and placeholder.
- `pages/admin/audit.vue` `data-testid="audit-expand"` button
  - Baseline: `class="rounded p-0.5 text-muted-foreground hover:text-foreground"`
  - Target: `inline-flex h-11 w-11 items-center justify-center rounded text-muted-foreground hover:text-foreground sm:h-8 sm:w-8`.
- `components/fleet/ApprovalBadge.vue` `data-testid="fleet-approval-notifications"` button
  - Baseline: `class="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground"`
  - Target: `inline-flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground sm:h-9 sm:w-9`.
- `pages/settings/notifications.vue` checkboxes
  - Baseline: `#notification-email-master`, `notification-pref-<category>` and `notification-pref-email-<category>` use `h-4 w-4 accent-primary`; the in-app and email checkboxes sit in a `<span class="flex shrink-0 items-center gap-2 ...">`.
  - Target: all three use `h-5 w-5 accent-primary`. Each per-category `<span>` wrapper becomes a `<label>`
    whose `for` is the checkbox it holds and whose class adds `min-h-11 sm:min-h-0`, so the "In app" /
    "Email" text and the row height are part of the hit area. The in-app checkbox then has two labels with
    the same `for` (the existing category label and the new wrapper); that is valid HTML and its accessible
    name becomes the category text plus "In app". The email checkbox keeps its `aria-label`.
- `pages/[project]/flows/index.vue` state link
  - Baseline: `<NuxtLink :to="`/${slug}/flows/${flow.id}`">` with no class.
  - Target: the link carries `inline-flex min-h-11 items-center sm:min-h-0`.

### Failure Handling

None: every change is presentational or a pure path-to-label mapping; no new request or error path.

## Out of Scope

- Other audit items (R2-8, R2-9, R2-11, R2-14, R2-17 to R2-19, R2-22 to R2-24, R1-16) belong to the page-polish feature; R2-21 (slow repo nax config page) stays open separately.
- Breadcrumbs for global pages (no project in the route) are unchanged: the bar stays hidden there.
- The `outline`, `secondary`, `ghost` and `link` button variants keep `disabled:opacity-50`.
- Raw `<select>` elements outside the four filter selects (members panel, invites panel, role and principal-role dialogs, approval policy dialog, agents table, backend picker, repo rule override) keep their current classes; `FleetNativeSelect` consumers do change, see Design.
- Touch targets beyond the five R2-16 controls are not swept here.
- Disabled-reason placement for buttons outside `ThreadActionBar` is unchanged (KB Search has no reason text).
- Measured touch-target sizes and contrast are checked in the post-merge live sweep on koda-wk, not in unit tests (jsdom has no layout).

## Stories

### US-001: Breadcrumb leaf on every project page, 44 px breadcrumb links on narrow screens

No dependencies. Workdir: `apps/web`.

Add the six path branches to `breadcrumbItems` in `layouts/default.vue` and the touch-target classes to the
`AppBreadcrumb` link, as described in Design § Integration.

### US-002: Disabled filled buttons look disabled, the reason sits under the button

No dependencies. Workdir: `apps/web`.

Add the muted disabled classes to the `default` and `destructive` button variants, and restructure the
`ThreadActionBar` actions so each reason renders under its button and describes it.

### US-003: Filter selects as tall as inputs

No dependencies. Workdir: `apps/web`.

Create `lib/form-control.ts` with `FILTER_CONTROL_CLASS` and use it in `NativeSelect`, the four filter
selects (timeline, memory x2, outbox) and the memory text search input. The page mount harnesses to reuse are in
`tests/pages/timeline.spec.ts`, `tests/pages/memory-readable.spec.ts` and `tests/pages/admin-outbox*.spec.ts`.

### US-004: 44 px touch targets for the small controls on narrow screens

No dependencies. Workdir: `apps/web`.

Apply the touch-target classes from Design § Integration to the audit expand button, the
approval-notification toggle, the notification-settings checkboxes and the flow list state link. The mount
harnesses to reuse are in `tests/pages/admin-audit-detail.spec.ts`, `tests/components/fleet-approval-badge.spec.ts`,
`tests/pages/notification-settings-page.spec.ts` and `tests/pages/fleet-flows-list.spec.ts`.

### Context Files

**US-001**

- `apps/web/layouts/default.vue`
- `apps/web/components/AppBreadcrumb.vue`
- `apps/web/tests/layouts/flows-nav.spec.ts` — the `breadcrumbItemsFor` harness to copy
- `apps/web/tests/helpers/fleet-harness.ts`
- `apps/web/tests/helpers/permission-nav.ts`

**US-002**

- `apps/web/components/ui/button/Button.vue`
- `apps/web/components/fleet/threads/ThreadActionBar.vue`
- `apps/web/tests/components/thread-action-bar.spec.ts`
- `apps/web/tests/helpers/mount-sfc.ts`

**US-003**

- `apps/web/components/fleet/NativeSelect.vue`
- `apps/web/pages/[project]/timeline.vue`
- `apps/web/pages/[project]/memory.vue`
- `apps/web/pages/admin/outbox.vue`
- `apps/web/tests/pages/memory-readable.spec.ts`

**US-004**

- `apps/web/pages/admin/audit.vue`
- `apps/web/components/fleet/ApprovalBadge.vue`
- `apps/web/pages/settings/notifications.vue`
- `apps/web/pages/[project]/flows/index.vue`
- `apps/web/tests/pages/notification-settings-page.spec.ts`

### Creates

**US-001**

- `apps/web/tests/layouts/default-breadcrumb-leaves.spec.ts`
- `apps/web/tests/components/app-breadcrumb.spec.ts`

**US-002**

- `apps/web/tests/components/button-disabled.spec.ts`

**US-003**

- `apps/web/lib/form-control.ts`
- `apps/web/tests/lib/form-control.spec.ts`
- `apps/web/tests/pages/filter-select-height.spec.ts`

**US-004**

- `apps/web/tests/pages/admin-audit-touch-target.spec.ts`
- `apps/web/tests/components/fleet-approval-badge-touch-target.spec.ts`
- `apps/web/tests/pages/notification-settings-touch-target.spec.ts`
- `apps/web/tests/pages/fleet-flows-list-touch-target.spec.ts`

### Modifies

None. Checked against the current specs: `tests/components/thread-action-bar.spec.ts` finds reasons by the kept `data-testid` and pins no element tag or sibling order; `tests/components/fleet-native-select.spec.ts` pins no class; `tests/pages/accessible-names.spec.ts` and `tests/pages/notification-settings-page.spec.ts` find the checkboxes by the kept `data-testid` and the email `aria-label` is kept; no spec pins the breadcrumb, button, audit expand, approval toggle or flow link classes being changed.

### Seams

**US-003**: `FILTER_CONTROL_CLASS` (new export of `lib/form-control.ts`) is consumed in the same story by
`NativeSelect.vue`, `timeline.vue`, `memory.vue` and `outbox.vue`; the page-level ACs below render each
consumer and assert the rendered select carries `h-10`, which proves the wiring.

## Acceptance Criteria

### US-001

1. [unit] Running the `layouts/default.vue` setup for route path `/web/timeline` with params `{ project: 'web' }` gives `breadcrumbItems` equal to `[{ label: 'Koda', to: '/' }, { label: 'web', to: '/web' }, { label: 'nav.timeline' }]` (the i18n stub returns the key).
2. [unit] Route `/web/memory` gives the same shape with leaf label `nav.memory`.
3. [unit] Route `/web/code-intel` gives the same shape with leaf label `nav.codeIntel`.
4. [unit] Route `/web/settings` gives the same shape with leaf label `nav.settings`.
5. [unit] Route `/web/approvals` gives the same shape with leaf label `nav.approvals`.
6. [unit] Route `/web/approval-policies` gives the same shape with leaf label `nav.approvalPolicies`.
7. [unit] Regression guard: route `/web/flows` still gives `[{ label: 'Koda', to: '/' }, { label: 'web', to: '/web' }, { label: 'nav.flows' }]`, and route `/web` still gives `[{ label: 'Koda', to: '/' }, { label: 'web' }]`.
8. [unit] Rendering `AppBreadcrumb` with items `[{ label: 'Koda', to: '/' }, { label: 'web' }]` renders the `Koda` link with classes `inline-flex`, `min-h-11`, `items-center` and `sm:min-h-0`, and renders `web` as a non-link `span`.

### US-002

1. [unit] Rendering `Button` with `variant` `default` and `disabled` true renders a `button` whose class includes `disabled:bg-muted`, `disabled:text-muted-foreground` and `disabled:opacity-100`, and does not include `disabled:opacity-50`.
2. [unit] Rendering `Button` with `variant` `destructive` and `disabled` true renders a class including `disabled:bg-muted`, `disabled:text-muted-foreground` and `disabled:opacity-100`.
3. [unit] Rendering `Button` with `variant` `outline` and `disabled` true renders a class including `disabled:opacity-50` and not `disabled:bg-muted`.
4. [unit] Mounting `ThreadActionBar` with a thread whose `writtenPaths` is empty renders `thread-action-publish-reason` as a `p` element with class `text-xs` and `text-muted-foreground`, inside the same `flex-col` wrapper element as the `thread-action-publish` button, placed after the button.
5. [unit] In that mount the `thread-action-publish` button's `aria-describedby` equals `thread-action-publish-reason`, and the reason element's `id` is `thread-action-publish-reason`.
6. [unit] Mounting `ThreadActionBar` with an ask-mode thread with no written path (Publish enabled, no reason) renders the `thread-action-publish` button with no `aria-describedby` attribute.

### US-003

1. [unit] `FILTER_CONTROL_CLASS` imported from `lib/form-control` is the string `h-10 rounded-md border border-input bg-background px-3 text-sm`.
2. [unit] Rendering `FleetNativeSelect` (`components/fleet/NativeSelect.vue`) with two options renders a `select` whose class includes `h-10` and `w-full` and not `h-9`.
3. [unit] Mounting `pages/[project]/timeline.vue` renders the `#timeline-event-type` select with a class including `h-10` and `border-input`.
4. [unit] Mounting `pages/[project]/memory.vue` renders both `#memory-kind-filter` and `#memory-status-filter` with a class including `h-10`.
5. [unit] Mounting `pages/admin/outbox.vue` renders the `#outbox-status` select with a class including `h-10` and `w-fit`.
6. [unit] Mounting `pages/[project]/memory.vue` renders the text search `input` (type `search`) with a class including `h-10` and `border-input`.
7. [unit] Regression guard (passes before and after the change): mounting the memory page with `useMemory` stubbed as in `tests/pages/memory-readable.spec.ts` `mountMemory` but with `applyFilters` a `jest.fn()`, calling the `#memory-kind-filter` select's `onChange` prop calls `applyFilters` once.

### US-004

1. [unit] Mounting `pages/admin/audit.vue` with one audit entry renders the `audit-expand` button with classes `h-11`, `w-11`, `sm:h-8` and `sm:w-8`.
2. [unit] Mounting `ApprovalBadge` with browser notifications supported renders the `fleet-approval-notifications` button with classes `h-11`, `w-11`, `sm:h-9` and `sm:w-9`.
3. [unit] Mounting `pages/settings/notifications.vue` with one category row renders `notification-email-master`, `notification-pref-<category>` and `notification-pref-email-<category>` each with classes `h-5` and `w-5`.
4. [unit] On that mount the `notification-pref-<category>` checkbox's parent element is a `label` (not the existing category label, which shares the same `for`) whose `for` is `notification-pref-<category>` and whose class includes `min-h-11` and `sm:min-h-0`.
5. [unit] On that mount the `notification-pref-email-<category>` checkbox's parent element is a `label` whose `for` is `notification-pref-email-<category>` and whose class includes `min-h-11`, and the checkbox keeps its `aria-label`.
6. [unit] Mounting `pages/[project]/flows/index.vue` with one flow record renders that row's state link (to `/<slug>/flows/<id>`) with classes `inline-flex`, `min-h-11`, `items-center` and `sm:min-h-0`.
