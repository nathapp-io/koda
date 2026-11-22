# SPEC: Styled confirm dialogs for the remaining window.confirm sites

## Summary

Move the 18 remaining `window.confirm` call sites in `apps/web` onto the shared styled confirm dialog (`useConfirm` plus `ConfirmDialogHost`). That dialog was added by `e2e-1121-ticket-page` (#500), which migrated only ticket and comment delete. Each dialog gets a short question title, an explanatory body, a confirm button labelled with the action and, for destructive actions, the destructive button style. The feature closes with an ESLint rule that rejects any new `window.confirm` or bare global `confirm()` in `apps/web` source. This is A-Z finding F6 from `projects/koda/e2e-2026-11-21/koda-wk-a-z-e2e-findings-2026-11-21.md` in the workspace repo, ruled 2026-11-21 as "all window.confirm sites".

## Motivation

- F6: the browser can suppress `window.confirm`, its OS-styled box ignores the app theme and dark mode, and the one sentence it shows mixes the question with its consequence.
- After #500, ticket and comment delete use the styled dialog, while 18 other destructive or bulk actions still use the native one. The same app asks the same kind of question two different ways.
- Nothing stops new code from adding another `window.confirm`.

## Design

### Integration

Read-only, used as they are (no change):

- `composables/useConfirm.ts`: `useConfirm(): { confirm(options: ConfirmOptions): Promise<boolean>; settle(ok: boolean): void; current: ComputedRef<ConfirmOptions | null> }`, with `interface ConfirmOptions { title: string; body?: string; confirmLabel?: string; destructive?: boolean }`. It is auto-imported in components, pages and composables.
- `components/ConfirmDialogHost.vue`: already mounted once in `app.vue`, so a dialog requested from any page, including admin pages, renders.
- `tests/helpers/mount-sfc.ts`: `useConfirm` is in the auto-import list, and its default global resolves `true` (`useConfirm: () => ({ confirm: async () => true, ... })`). A spec overrides it through `globals: { useConfirm: () => ({ confirm }) }`, as `tests/components/comment-thread-author.spec.ts` does.
- The reference migration is `CommentThread.vue` `deleteComment`: `const confirmed = await confirm({ title, body, confirmLabel, destructive: true }); if (!confirmed) return`.

Changed symbols. The baseline only locates the code. It is never the interface to implement.

- `composables/useFleetBudgetPage.ts` `remove`.
  Baseline: `remove(policy: BudgetPolicyDto, confirmText: string): Promise<void>`, which calls `window.confirm(confirmText)`.
  Target: `remove(policy: BudgetPolicyDto, prompt: { title: string; body: string }): Promise<void>`, which awaits `confirm({ title: prompt.title, body: prompt.body, confirmLabel: t('fleet.budgets.actions.delete'), destructive: true })`.
- `pages/admin/fleet/budgets.vue` and `pages/[project]/fleet/budgets.vue` `confirmText`.
  Baseline: `confirmText(p): string` returns `t('fleet.budgets.deleteConfirm', { scope })`.
  Target: `confirmPrompt(p): { title: string; body: string }` returns `{ title: t('fleet.budgets.deleteConfirm', { scope }), body: t('fleet.budgets.deleteConfirmBody') }`, and the `@remove` handler passes it to `remove`.
- `pages/[project]/fleet/repos/[id]/config.vue` leave guard.
  Baseline: `onBeforeRouteLeave(() => { if (submitted.value || edits.value.length === 0) return true; return window.confirm(t('fleet.config.page.leaveConfirm')) })`.
  Target: an `async` guard that returns `true` for a clean or submitted draft without asking, and otherwise returns the boolean that `confirm(...)` resolves to. Vue Router accepts a `Promise<boolean>` from a leave guard.

Every other site keeps its function shape and replaces `if (!window.confirm(text)) return` with `if (!(await confirm({ ... }))) return`, making the handler `async` where it is not already. `pages/admin/skills.vue` `onRemove` is a non-async function returning `Promise<void>` (`return Promise.resolve()` on a declined native confirm). It may become `async` and return early on `false`, as long as it still returns a `Promise<void>` that its caller awaits.

### Copy

Each site keeps its existing i18n key as the dialog **title**. Where the existing value holds a second sentence, the title loses it and that sentence moves to a new `<key>Body` key. Where the existing value is a bare question, the body is new text. The confirm button reuses the i18n key of the button that opened the dialog. Only `fleet.config.page.leaveConfirmLabel` is new. Titles marked "unchanged" keep their current en and zh values.

| # | Site (file, function) | Title key (en / zh) | Body key (en / zh) | `confirmLabel` key | `destructive` |
|---|---|---|---|---|---|
| 1 | `components/SettingsVcsCard.vue` `rotateSecret` | `vcs.secret.rotateConfirm` = "Rotate the webhook secret?" / "确定轮换 Webhook 密钥？" | `vcs.secret.rotateConfirmBody` = "Deliveries signed with the old secret will be rejected." / "使用旧密钥签名的投递将被拒绝。" | `vcs.secret.rotate` | true |
| 2 | `components/SettingsProviderKeysCard.vue` delete | `fleet.providerKeys.deleteConfirm` (unchanged, `{provider}`) | `fleet.providerKeys.deleteConfirmBody` = "The stored key is removed and cannot be recovered." / "已保存的密钥将被移除，且无法恢复。" | `fleet.providerKeys.delete` | true |
| 3 | `components/ProjectInvitesPanel.vue` cancel invite | `projects.invites.cancelConfirm` (unchanged, `{email}`) | `projects.invites.cancelConfirmBody` = "The invite link stops working." / "该邀请链接将失效。" | `projects.invites.cancel` | true |
| 4 | `components/ProjectMembersPanel.vue` `onRemoveRow` | `projects.members.removeConfirm` (unchanged, `{name}`) | `projects.members.removeConfirmBody` = "All of their roles in this project are removed." / "其在此项目中的所有角色将被移除。" | `projects.members.remove` | true |
| 5 | `components/SettingsDangerZoneCard.vue` delete project | `projects.settings.deleteConfirm` = "Delete this project?" / "确认删除此项目？" | `projects.settings.deleteConfirmBody` = "This action cannot be undone." / "此操作不可撤销。" | `projects.settings.delete` | true |
| 6 | `pages/admin/fleet/analytics.vue` `bulk('rerunOutdated')` | `fleet.analytics.ingest.confirmRerunOutdated` (unchanged) | `fleet.analytics.ingest.confirmRerunOutdatedBody` = "Each bundle is read again with the current parser. This can take a while." / "每个运行包都会用当前解析器重新读取，可能需要一些时间。" | `fleet.analytics.ingest.rerunOutdated` | false |
| 7 | `pages/admin/roles.vue` delete role | `admin.roles.deleteConfirm` (unchanged, `{name}`) | `admin.roles.deleteConfirmBody` = "This action cannot be undone." / "此操作不可撤销。" | `admin.roles.delete` | true |
| 8 | `pages/admin/approval-policies.vue` delete policy | `approvals.policies.list.deleteConfirm` (unchanged, `{pattern}`) | `approvals.policies.list.deleteConfirmBody` = "Actions it covers no longer ask for approval under this policy." / "其覆盖的操作将不再按此策略请求审批。" | `approvals.policies.list.delete` | true |
| 9 | `pages/admin/skills.vue` remove source | `skills.confirm.remove` (unchanged, `{url}`) | `skills.confirm.removeBody` = "Its skills are removed from the catalog." / "其技能将从目录中移除。" | `skills.actions.remove` | true |
| 10 | `pages/admin/fleet/repos.vue` delete repo | `fleet.repos.deleteConfirm` = "Unregister {repo}?" / "取消注册 {repo}？" | `fleet.repos.deleteConfirmBody` = "A repo with unfinished jobs cannot be removed." / "有未完成任务的仓库无法移除。" | `fleet.repos.actions.delete` | true |
| 11 | `pages/admin/fleet/runners.vue` delete runner | `fleet.runners.deleteConfirm` = "Delete runner {name}?" / "删除执行机 {name}？" | `fleet.runners.deleteConfirmBody` = "Its key is revoked. A runner with unfinished or pinned jobs cannot be deleted." / "其密钥将被吊销。有未完成任务或被固定任务的执行机无法删除。" | `fleet.runners.actions.delete` | true |
| 12 | `pages/admin/fleet/provider-keys.vue` delete credential | `fleet.providerKeys.deleteConfirm` (unchanged, `{provider}`) | `fleet.providerKeys.deleteConfirmBody` (row 2) | `fleet.providerKeys.actions.delete` | true |
| 13 | `pages/[project]/approval-policies.vue` delete policy | `approvals.policies.list.deleteConfirm` (unchanged, `{pattern}`) | `approvals.policies.list.deleteConfirmBody` (row 8) | `approvals.policies.list.delete` | true |
| 14 | `pages/[project]/flows/[id].vue` `stopFlow` | `fleet.flows.stop.confirm` (unchanged) | `fleet.flows.stop.confirmBody` = "The flow does not continue to its next step." / "该流程将不再继续下一步。" | `fleet.flows.stop.button` | true |
| 15 | `pages/[project]/kb.vue` delete document source | `kb.documents.deleteConfirm` (unchanged) | `kb.documents.deleteConfirmBody` = "Its indexed content is removed from search." / "其已索引内容将从搜索中移除。" | `common.delete` | true |
| 16 | `pages/[project]/fleet/repos/[id]/config.vue` leave guard | `fleet.config.page.leaveConfirm` = "Leave with unsaved changes?" / "离开并丢弃未保存的改动？" | `fleet.config.page.leaveConfirmBody` = "Your edits to nax files are lost." / "你对 nax 文件的改动将丢失。" | `fleet.config.page.leaveConfirmLabel` (new) = "Leave" / "离开" | true |
| 17 | `composables/useFleetScheduleActions.ts` `remove` | `fleet.schedules.deleteConfirm` = "Delete schedule {name}?" / "删除定时计划 {name}？" | `fleet.schedules.deleteConfirmBody` = "The jobs it dispatched are kept." / "它派发过的任务会保留。" | `fleet.schedules.actions.delete` | true |
| 18 | `composables/useFleetBudgetPage.ts` `remove` (via both budgets pages) | `fleet.budgets.deleteConfirm` = "Delete the budget policy for {scope}?" / "删除 {scope} 的预算策略？" | `fleet.budgets.deleteConfirmBody` = "A paused scope resumes immediately." / "已暂停的范围将立即恢复。" | `fleet.budgets.actions.delete` | true |

Each story adds the en and zh values for its own rows to `i18n/locales/en.json` and `i18n/locales/zh.json`. Rows 2 and 12 share a body key, and so do rows 8 and 13. The story that owns the first row of a pair adds the key. Row 1 deliberately drops the zh "吗" so that the title is a short question, like the other titles.

### Lint guard

`apps/web/.eslintrc.cjs` gains two top-level rules:
- `no-restricted-properties` with the entries `{ object: 'window', property: 'confirm' }` and `{ object: 'globalThis', property: 'confirm' }`, each with the message 'Use useConfirm() (styled dialog) instead of the native confirm.'
- `no-restricted-globals` with `{ name: 'confirm', message: 'Use useConfirm() (styled dialog) instead of the global confirm().' }`.

The existing `*.spec.ts` override turns both rules off, because specs build fake `window` objects. A local `confirm` (destructured from `useConfirm()`, or a local function as in `ThreadStaleBanner.vue`) is not a global, so `no-restricted-globals` does not flag it. The shared preset sets `env.browser: true`, so `confirm` is a known global and the rule applies. `bun run lint` (`--max-warnings=0`) then fails on any new native confirm in `apps/web` source.

### Failure Handling

| Case | Behaviour |
|---|---|
| The user cancels, presses Escape or closes the dialog | `confirm()` resolves `false`. The handler returns before any API call, toast or state change, as the native `false` did. |
| A second dialog is requested while one is open | `useConfirm` resolves the first with `false`. This existing behaviour is unchanged and already covered by `tests/composables/useConfirm.spec.ts`. |
| The confirmed API call fails | Unchanged: each site keeps its existing error toast and refresh path. |

## Out of Scope

- `useConfirm`, `ConfirmDialogHost` and their tests do not change. No new option (for example an input field or a third button) is added.
- A second confirm request closing the first one with `false` is existing `useConfirm` behaviour; no story adds a test for it.
- The error toast and refresh path after a confirmed API call fails is unchanged at every site; no story adds tests for it beyond what each site's existing spec already has.
- `components/fleet/threads/ThreadStaleBanner.vue` already uses its own styled dialog and is not touched.
- `CommentThread.vue` and `TicketProperties.vue` were migrated by #500 and are not touched.
- Closing or reloading the browser tab with unsaved nax-file edits is not guarded (there is no `beforeunload` handler today, and none is added).
- Dialogs that are already styled components (`DeleteAgentDialog`, `RotateKeyDialog`, memory retire, thread archive and similar) are not changed.
- No i18n value changes beyond those in the Design copy table: the title trims, the row 1 zh and row 16 title rewrites, and the new body and label keys.
- No end-to-end test is added. Only `tests/e2e/fleet-budgets.e2e.spec.ts`, which accepts a native dialog today, changes, to click the styled confirm button.
- Updating `.nax/mono/apps/web/context.md` with a "no window.confirm; use useConfirm" note is a manual edit after merge, not story work (`.nax/` is read-only to the run).
- Specs that only stub `window = { confirm: () => true }` and never assert on it or on a declined path need no change, because the harness `useConfirm` default already resolves `true`. Examples are `tests/pages/fleet-schedules-list-page.spec.ts`, `tests/pages/fleet-schedule-approval-gates.spec.ts`, `tests/pages/fleet-job-budget-gates.spec.ts` and `tests/components/project-invites-role-keys.spec.ts`.

## Stories

### US-001: Project settings and members confirmations
Migrate sites 1 to 5 (`SettingsVcsCard`, `SettingsProviderKeysCard`, `ProjectInvitesPanel`, `ProjectMembersPanel`, `SettingsDangerZoneCard`) to `useConfirm` with the Design copy, and add their en and zh keys. No dependencies. Workdir: `apps/web`.

### US-002: Admin governance page confirmations
Migrate sites 6 to 9 (admin analytics re-run outdated, roles, admin approval policies, skills) to `useConfirm` with the Design copy, and add their en and zh keys. This story owns `approvals.policies.list.deleteConfirmBody`. No dependencies. Workdir: `apps/web`.

### US-003: Admin fleet page confirmations
Migrate sites 10 to 12 (admin fleet repos, fleet runners, provider keys) to `useConfirm` with the Design copy, and add their en and zh keys. It reuses `fleet.providerKeys.deleteConfirmBody`, which US-001 adds. Depends on US-001. Workdir: `apps/web`.

### US-004: Project page confirmations and the nax-file leave guard
Migrate sites 13 to 16 (project approval policies, flow stop, KB document delete, the nax-file editor leave guard) to `useConfirm` with the Design copy, and add their en and zh keys. It reuses `approvals.policies.list.deleteConfirmBody`, which US-002 adds. The leave guard becomes async. Depends on US-002. Workdir: `apps/web`.

### US-005: Schedule and budget delete confirmations
Migrate sites 17 and 18 (`useFleetScheduleActions.remove`, `useFleetBudgetPage.remove`) to `useConfirm`. Change `useFleetBudgetPage.remove` to take `{ title, body }`, and make both budgets pages pass it. Add their en and zh keys, and update the budgets end-to-end spec to confirm through the styled dialog. No dependencies. Workdir: `apps/web`.

### US-006: Lint ban on native confirm
**No-test:** an ESLint configuration change, enforced by the existing `bun run lint` gate. No runtime code loads it.
Add the Design lint rules to `apps/web/.eslintrc.cjs`. Depends on US-001, US-002, US-003, US-004, US-005. Workdir: `apps/web`.

### Context Files

**US-001**
- `apps/web/composables/useConfirm.ts`
- `apps/web/components/CommentThread.vue`
- `apps/web/tests/components/comment-thread-author.spec.ts`
- `apps/web/tests/helpers/mount-sfc.ts`
- `apps/web/tests/i18n/locale-parity.spec.ts`

**US-002**
- `apps/web/composables/useConfirm.ts`
- `apps/web/components/CommentThread.vue`
- `apps/web/tests/helpers/mount-sfc.ts`

**US-003**
- `apps/web/composables/useConfirm.ts`
- `apps/web/components/CommentThread.vue`
- `apps/web/tests/helpers/mount-sfc.ts`

**US-004**
- `apps/web/composables/useConfirm.ts`
- `apps/web/components/CommentThread.vue`
- `apps/web/tests/helpers/mount-sfc.ts`
- `apps/web/tests/pages/fleet-repo-config-page.spec.ts`

**US-005**
- `apps/web/composables/useConfirm.ts`
- `apps/web/composables/useFleetBudgetPage.ts`
- `apps/web/composables/useFleetScheduleActions.ts`
- `apps/web/tests/helpers/fleet-harness.ts`

**US-006**
- `apps/web/.eslintrc.cjs`
- `apps/web/package.json`

### Creates

**US-001**
- `apps/web/tests/components/settings-vcs-card-rotate-confirm.spec.ts`: the site 1 confirmation tests. `tests/pages/settings-vcs-webhook-secret.spec.ts` only checks that keys exist and has no behavioural mount.
- `apps/web/tests/components/project-members-remove-confirm.spec.ts`: the site 4 confirmation tests.
- `apps/web/tests/i18n/confirm-copy-settings.spec.ts`: the en and zh values for rows 1 to 5.

**US-002**
- `apps/web/tests/i18n/confirm-copy-admin-governance.spec.ts`: the en and zh values for rows 6 to 9.

**US-003**
- `apps/web/tests/i18n/confirm-copy-admin-fleet.spec.ts`: the en and zh values for rows 10 and 11.

**US-004**
- `apps/web/tests/pages/kb-document-delete-confirm.spec.ts`: the site 15 confirmation tests. No existing spec covers KB document delete. The delete button (`kb.vue`, `common.delete` label) has no `data-testid`, so the spec finds it by its label or `variant`.
- `apps/web/tests/i18n/confirm-copy-project.spec.ts`: the en and zh values for rows 14 to 16.

**US-005**
- `apps/web/tests/i18n/confirm-copy-schedules-budgets.spec.ts`: the en and zh values for rows 17 and 18.

### Modifies

**US-001**
- `apps/web/tests/components/SettingsProviderKeysCard.spec.ts`: tests "AC-6" and "M2" stub `window.confirm` and read its string argument. They switch to a `useConfirm` global whose `confirm` mock resolves `false`/`true`. "M2" asserts that the `title` option interpolates `{provider}`.
- `apps/web/tests/components/ProjectInvitesPanel.spec.ts`: test "AC6" drives `window.confirm` and checks that its message names the invite email. It switches to a `useConfirm` global and asserts that the `title` option contains `pending@x.io`. Cancel is called only when `confirm` resolves `true`.
- `apps/web/tests/components/settings-danger-zone-card.spec.ts`: "AC-7" asserts `window.confirm` was called with `'projects.settings.deleteConfirm'`, and "AC-8" declines through `window.confirm`. Both switch to a `useConfirm` global. AC-7 asserts the `confirm` options object, and AC-8 resolves `false` with no delete.

**US-002**
- `apps/web/tests/pages/admin-fleet-analytics.spec.ts`: `mountAdmin(get, confirmAnswer)` answers through `window.confirm`. It switches to a `useConfirm` global resolving `confirmAnswer`.
- `apps/web/tests/pages/admin-roles.spec.ts`: `mountPage` builds a `confirm` mock on `window`. It moves that mock to a `useConfirm` global (resolving the same boolean), so tests reading `confirm` keep working.
- `apps/web/tests/pages/admin-approval-policies.spec.ts`: `mountPage` builds a `confirm` mock on `window`. It moves that mock to a `useConfirm` global resolving the same boolean.
- `apps/web/tests/pages/admin-skills.spec.ts`: `mountSkills({ confirm })` answers through `window.confirm`. It switches to a `useConfirm` global; the cancelled-Remove test resolves `false`.

**US-003**
- `apps/web/tests/pages/admin-fleet-repos.spec.ts`: `mountRepos({ confirm })` answers through `window.confirm`. It switches to a `useConfirm` global; the cancelled-confirm test resolves `false`.
- `apps/web/tests/pages/admin-fleet-runners.spec.ts`: `mountRunners(over, confirmResult)` answers through `window.confirm`, and `window.location.origin` stays on the stub. The confirm answer moves to a `useConfirm` global.
- `apps/web/tests/pages/admin-fleet-provider-keys.spec.ts`: `mountPage({ confirm })` answers through `window.confirm`. It switches to a `useConfirm` global; "AC-8" resolves `false` and then `true`.

**US-004**
- `apps/web/tests/pages/project-approval-policies.spec.ts`: `mountPage` builds a `confirm` mock on `window`. It moves that mock to a `useConfirm` global resolving the same boolean.
- `apps/web/tests/pages/fleet-flow-stop.spec.ts`: `confirm` is a `window.confirm` mock and "AC-4" declines with `mockReturnValue(false)`. It becomes a `useConfirm` global whose mock resolves the boolean (`mockResolvedValue(false)`).
- `apps/web/tests/pages/fleet-repo-config-page.spec.ts`: the `onBeforeRouteLeave: () => undefined` global discards the guard. It captures the registered guard so the new leave-guard tests can call it, and adds a `useConfirm` global.

**US-005**
- `apps/web/tests/composables/useFleetScheduleActions.spec.ts`: `setup` stubs `g.window = { confirm }`, and the delete test asserts `window.confirm` was called with `'Delete schedule nightly? The jobs it dispatched are kept.'`. It switches to a `g.useConfirm` global and asserts the `confirm` options object with the split title and body. `afterEach` deletes `useConfirm` as well.
- `apps/web/tests/composables/useFleetBudgetPage.spec.ts`: `setup` stubs `g.window = { confirm }`, and the `remove` tests pass the string `'sure?'`. It switches to a `g.useConfirm` global, the tests pass `{ title: 'sure?', body: 'b' }`, and `afterEach` deletes `useConfirm`.
- `apps/web/tests/pages/admin-fleet-budgets.spec.ts`: `mountBudgets(api, confirmResult)` answers through `window.confirm`, and "a declined confirm deletes nothing" relies on it. The answer moves to a `useConfirm` global, and the file gains the admin page `remove` prompt test.
- `apps/web/tests/pages/fleet-budgets-project-page.spec.ts`: it stubs `window.confirm` and never asserts the prompt. It gains a `useConfirm` global whose `confirm` mock records options, plus the project page `remove` prompt test.
- `apps/web/tests/e2e/fleet-budgets.e2e.spec.ts`: the delete step registers `page.once('dialog', dialog => dialog.accept())`, which a styled dialog never fires. It instead clicks `[data-testid="confirm-dialog-confirm"]` after the delete button, and the row count assertion stays.

**US-006**

None. The rule only fails on code that still calls the native confirm, and US-001 to US-005 have removed every such call.

### Seams

None across stories. Every story calls the existing `useConfirm`, which is not created or changed here. US-005's `remove` signature change and both of its callers sit in the same story. US-006 depends on US-001 to US-005 because its rule fails lint while any site is unmigrated.

## Acceptance Criteria

The options asserted below use i18n keys (`t('key', params)`). A spec may assert either the key form its harness `t` returns or the en text from the Design copy table. "Resolves `false`" means the mocked `useConfirm().confirm` returns a promise of `false`. Each "no call" AC is checked after the promise settles. A locale AC reads `i18n/locales/en.json` and `i18n/locales/zh.json` and compares every listed key with its Design table value.

### US-001

1. [unit] Clicking rotate in `SettingsVcsCard` calls `confirm` once with `{ title: t('vcs.secret.rotateConfirm'), body: t('vcs.secret.rotateConfirmBody'), confirmLabel: t('vcs.secret.rotate'), destructive: true }`.
2. [unit] In `SettingsVcsCard`, when `confirm` resolves `false`, no `POST /projects/:slug/vcs/webhook-secret/rotate` request is sent.
3. [unit] Deleting a key in `SettingsProviderKeysCard` calls `confirm` once with `{ title: t('fleet.providerKeys.deleteConfirm', { provider }), body: t('fleet.providerKeys.deleteConfirmBody'), confirmLabel: t('fleet.providerKeys.delete'), destructive: true }`, where `provider` is the row's `providerId`.
4. [unit] In `SettingsProviderKeysCard`, when `confirm` resolves `false`, no delete request is sent.
5. [unit] Cancelling the invite for `pending@x.io` in `ProjectInvitesPanel` calls `confirm` once with `{ title: t('projects.invites.cancelConfirm', { email: 'pending@x.io' }), body: t('projects.invites.cancelConfirmBody'), confirmLabel: t('projects.invites.cancel'), destructive: true }`.
6. [unit] In `ProjectInvitesPanel`, when `confirm` resolves `false`, the invite cancel API is not called.
7. [unit] Removing a member row in `ProjectMembersPanel` calls `confirm` once with `{ title: t('projects.members.removeConfirm', { name }), body: t('projects.members.removeConfirmBody'), confirmLabel: t('projects.members.remove'), destructive: true }`, where `name` is the row's display name.
8. [unit] In `ProjectMembersPanel`, when `confirm` resolves `false`, no binding is removed.
9. [unit] Deleting the project in `SettingsDangerZoneCard` calls `confirm` once with `{ title: t('projects.settings.deleteConfirm'), body: t('projects.settings.deleteConfirmBody'), confirmLabel: t('projects.settings.delete'), destructive: true }`.
10. [unit] In `SettingsDangerZoneCard`, when `confirm` resolves `false`, no project delete request is sent.
11. [unit] The en and zh locale files hold the Design table values for the row 1 to 5 keys: `vcs.secret.rotateConfirm`, `projects.settings.deleteConfirm`, `vcs.secret.rotateConfirmBody`, `fleet.providerKeys.deleteConfirmBody`, `projects.invites.cancelConfirmBody`, `projects.members.removeConfirmBody` and `projects.settings.deleteConfirmBody`.

### US-002

1. [unit] Clicking the re-run-outdated bulk action on `pages/admin/fleet/analytics.vue` calls `confirm` once with `{ title: t('fleet.analytics.ingest.confirmRerunOutdated'), body: t('fleet.analytics.ingest.confirmRerunOutdatedBody'), confirmLabel: t('fleet.analytics.ingest.rerunOutdated'), destructive: false }`.
2. [unit] On the admin analytics page, when `confirm` resolves `false`, `rerunOutdated` is not called.
3. [unit] On the admin analytics page, the backfill bulk action calls `backfill` without calling `confirm`.
4. [unit] Deleting a role on `pages/admin/roles.vue` calls `confirm` once with `{ title: t('admin.roles.deleteConfirm', { name }), body: t('admin.roles.deleteConfirmBody'), confirmLabel: t('admin.roles.delete'), destructive: true }`.
5. [unit] On the admin roles page, when `confirm` resolves `false`, no `DELETE /roles/:id` is sent.
6. [unit] Deleting a policy on `pages/admin/approval-policies.vue` calls `confirm` once with `{ title: t('approvals.policies.list.deleteConfirm', { pattern }), body: t('approvals.policies.list.deleteConfirmBody'), confirmLabel: t('approvals.policies.list.delete'), destructive: true }`.
7. [unit] On the admin approval policies page, when `confirm` resolves `false`, no `DELETE /approval-policies/:id` is sent.
8. [unit] Removing a skill source on `pages/admin/skills.vue` calls `confirm` once with `{ title: t('skills.confirm.remove', { url }), body: t('skills.confirm.removeBody'), confirmLabel: t('skills.actions.remove'), destructive: true }`, where `url` is the source's `gitUrl`.
9. [unit] On the admin skills page, when `confirm` resolves `false`, the catalog `remove` is not called.
10. [unit] The en and zh locale files hold the Design table values for the row 6 to 9 keys: `fleet.analytics.ingest.confirmRerunOutdatedBody`, `admin.roles.deleteConfirmBody`, `approvals.policies.list.deleteConfirmBody` and `skills.confirm.removeBody`.

### US-003

1. [unit] Deleting a repo on `pages/admin/fleet/repos.vue` calls `confirm` once with `{ title: t('fleet.repos.deleteConfirm', { repo }), body: t('fleet.repos.deleteConfirmBody'), confirmLabel: t('fleet.repos.actions.delete'), destructive: true }`.
2. [unit] On the admin fleet repos page, when `confirm` resolves `false`, the repo is not deleted.
3. [unit] Deleting a runner on `pages/admin/fleet/runners.vue` calls `confirm` once with `{ title: t('fleet.runners.deleteConfirm', { name }), body: t('fleet.runners.deleteConfirmBody'), confirmLabel: t('fleet.runners.actions.delete'), destructive: true }`.
4. [unit] On the admin fleet runners page, when `confirm` resolves `false`, the runner is not deleted.
5. [unit] Deleting a credential on `pages/admin/fleet/provider-keys.vue` calls `confirm` once with `{ title: t('fleet.providerKeys.deleteConfirm', { provider }), body: t('fleet.providerKeys.deleteConfirmBody'), confirmLabel: t('fleet.providerKeys.actions.delete'), destructive: true }`.
6. [unit] On the admin provider keys page, when `confirm` resolves `false`, no `DELETE` is sent.
7. [unit] On the admin provider keys page, when `confirm` resolves `true`, exactly one `DELETE` is sent.
8. [unit] The en and zh locale files hold the Design table values for the row 10 and 11 keys: `fleet.repos.deleteConfirm`, `fleet.runners.deleteConfirm`, `fleet.repos.deleteConfirmBody` and `fleet.runners.deleteConfirmBody`.

### US-004

1. [unit] Deleting a policy on `pages/[project]/approval-policies.vue` calls `confirm` once with `{ title: t('approvals.policies.list.deleteConfirm', { pattern }), body: t('approvals.policies.list.deleteConfirmBody'), confirmLabel: t('approvals.policies.list.delete'), destructive: true }`.
2. [unit] On the project approval policies page, when `confirm` resolves `false`, no project policy `DELETE` is sent.
3. [unit] Stopping a live flow on `pages/[project]/flows/[id].vue` calls `confirm` once with `{ title: t('fleet.flows.stop.confirm'), body: t('fleet.flows.stop.confirmBody'), confirmLabel: t('fleet.flows.stop.button'), destructive: true }`.
4. [unit] On the flow page, when `confirm` resolves `false`, `flows.stop` is not called.
5. [unit] Deleting a document source on `pages/[project]/kb.vue` calls `confirm` once with `{ title: t('kb.documents.deleteConfirm'), body: t('kb.documents.deleteConfirmBody'), confirmLabel: t('common.delete'), destructive: true }`.
6. [unit] On the KB page, when `confirm` resolves `false`, no document delete request is sent.
7. [unit] On `pages/[project]/fleet/repos/[id]/config.vue` with no edits, the leave guard returns `true` without calling `confirm`.
8. [unit] On the config page with one unsaved edit, the leave guard calls `confirm` once with `{ title: t('fleet.config.page.leaveConfirm'), body: t('fleet.config.page.leaveConfirmBody'), confirmLabel: t('fleet.config.page.leaveConfirmLabel'), destructive: true }`.
9. [unit] On the config page with one unsaved edit, the leave guard resolves `false` when `confirm` resolves `false`.
10. [unit] On the config page with one unsaved edit, the leave guard resolves `true` when `confirm` resolves `true`.
11. [unit] On the config page after a submit (`submitted` is `true`) with edits present, the leave guard returns `true` without calling `confirm`.
12. [unit] The en and zh locale files hold the Design table values for the row 14 to 16 keys: `fleet.config.page.leaveConfirm`, `fleet.flows.stop.confirmBody`, `kb.documents.deleteConfirmBody`, `fleet.config.page.leaveConfirmBody` and `fleet.config.page.leaveConfirmLabel`.

### US-005

1. [unit] `useFleetScheduleActions(api, onStale).remove({ id: 's1', name: 'nightly' })` calls `confirm` once with `{ title: t('fleet.schedules.deleteConfirm', { name: 'nightly' }), body: t('fleet.schedules.deleteConfirmBody'), confirmLabel: t('fleet.schedules.actions.delete'), destructive: true }`.
2. [unit] When `confirm` resolves `false`, `useFleetScheduleActions(...).remove` returns `false` and `api.remove` is not called.
3. [unit] `useFleetBudgetPage(base).remove(policy, { title: 'T', body: 'B' })` calls `confirm` once with `{ title: 'T', body: 'B', confirmLabel: t('fleet.budgets.actions.delete'), destructive: true }`.
4. [unit] When `confirm` resolves `false`, `useFleetBudgetPage(base).remove(policy, { title: 'T', body: 'B' })` does not call the budgets API `remove`.
5. [unit] On `pages/admin/fleet/budgets.vue`, a `BudgetTable` `remove` event for a policy calls `confirm` with `title` equal to `t('fleet.budgets.deleteConfirm', { scope })` for that policy's scope text and `body` equal to `t('fleet.budgets.deleteConfirmBody')`.
6. [unit] On `pages/[project]/fleet/budgets.vue`, a `BudgetTable` `remove` event for a policy calls `confirm` with `title` equal to `t('fleet.budgets.deleteConfirm', { scope })` for that policy's scope text and `body` equal to `t('fleet.budgets.deleteConfirmBody')`.
7. [unit] The en and zh locale files hold the Design table values for the row 17 and 18 keys: `fleet.schedules.deleteConfirm`, `fleet.budgets.deleteConfirm`, `fleet.schedules.deleteConfirmBody` and `fleet.budgets.deleteConfirmBody`.

### US-006

1. [review] `apps/web/.eslintrc.cjs` top-level `rules` sets `no-restricted-properties` to `error`, with the entries `{ object: 'window', property: 'confirm' }` and `{ object: 'globalThis', property: 'confirm' }`, each with a message that names `useConfirm()`.
2. [review] `apps/web/.eslintrc.cjs` top-level `rules` sets `no-restricted-globals` to `error`, with the entry `{ name: 'confirm' }` and a message that names `useConfirm()`.
3. [review] The existing `files: ['*.spec.ts']` override in `apps/web/.eslintrc.cjs` sets both `no-restricted-properties` and `no-restricted-globals` to `off`.

Verification note (US-006): `bun run lint` in `apps/web` passes with the new rules. That is the gate that proves no native confirm remains in `apps/web` source.
