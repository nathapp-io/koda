# SPEC: Thread UX fixes from the 2026-11-21 A-Z e2e run

## Summary

Fix the thread findings from the 2026-11-21 A-Z end-to-end run on koda-wk (`2579ca3d`): the composer keeps a sent message so it can be sent and billed twice (F1), the thread page buries the conversation under its controls and still offers cap and send controls on an archived thread (F14), a long code line widens the page on mobile (F15), a subscription ACP thread reads as `$0` (F17), the repo-thread form hides that Feature is required and how to fill it (F5), and a workspace thread on the default "Automatic" home project fails with a project-thread message (F4). The findings report is `projects/koda/e2e-2026-11-21/koda-wk-a-z-e2e-findings-2026-11-21.md` in the workspace repo.

## Motivation

- F1: `ThreadComposer.vue` emits `send(text)` and never learns whether the POST succeeded, so the draft stays in the box. In the live run, pressing Send again posted the same prompt a second time; the agent answered twice and both turns were billed. Nothing blocks a second Enter while the first POST is in flight.
- F14: on `pages/[project]/threads/[id].vue` the conversation sits below about 450 px of panels (flows, start flow, pre-approval, controls, mode, action bar). `ThreadControls.vue` shows Raise cap on an archived thread (`showRaise` is `isCreator` only). An archived thread still renders the textarea and Send. The Raise cap dialog opens empty instead of showing the current cap. The pre-approval card's "Cost cap" input reads as the thread's own cap, which it is not.
- F15: `ThreadMessage.vue` renders assistant HTML in a `whitespace-pre-wrap break-words` box with no horizontal scroll container, so a `pre` block or a long token widens the page (288 px of sideways scroll at 390 px).
- F17: an ACP Codex subscription turn is `unpriced`, so `costUsd` stays `0` while tokens count up. `costText` shows `$0 / $0.5`, which reads as free and suggests the cap protects the thread when it never can.
- F5: in `pages/[project]/threads/new.vue` the Feature field has no required marker and no format hint, an empty Feature gives "Use a valid feature name", Base ref has no hint, and clicking Create with no repository showed nothing visible in the live run.
- F4: `WorkspaceThreadsService.create` picks the default home only among projects the caller is a member of (deliberate: `workspace-threads.service.spec.ts` AC-10 "admin default requires actual membership"). The live Owner holds only a global binding and no project membership, so the pick fails and throws `threads.noFleetRepo`, whose text "This project has no repository, so a project thread cannot run" is about a project thread and names no project. The explicit-home branch throws the same key.

## Design

### Integration

Symbols this feature only reads:

- `ThreadActionResult` from `apps/web/lib/thread-controller.ts`: `{ ok: true } | { ok: false; error?: unknown }`. `useThread(slug, id).send(text)` already resolves it: `{ ok: true }` after the POST returns, `{ ok: false, error }` after a refusal (it drops its optimistic echo).
- `composerState(thread, messages, viewer)` in `apps/web/lib/thread-view.ts` returns `{ canSend, reason }`; `reason` is a `ComposerReason` (`ThreadSendRefusal | 'readOnly'`), and `'archived'` is a `ThreadSendRefusal` the API sends for an archived thread.
- `ThreadBackend` in `apps/web/lib/thread-types.ts`: `{ kind: 'native'; ... } | { kind: 'acp'; agent; ... }`. `ThreadDto` carries `backend`, `costUsd: string`, `maxCostUsd: string`, `tokens: ThreadTokens | null` (`input`, `output`, `cacheRead`, `cacheWrite`). `ThreadHeader.vue` computes total tokens as `input + output`.
- `FEATURE_RE` in `apps/web/lib/fleet-dispatch.ts`: `/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/` (mirrors the API).
- `extractApiError(err)` in `apps/web/composables/useApi.ts` returns the API envelope `message`, which the API has already localized.
- Precedents for a function prop instead of an emit: `ThreadModeControl` takes `:change-mode` and `ThreadApprovalCard` takes `:decide`, both `(...) => Promise<ThreadActionResult>`.
- Precedent for a horizontal scroll container: `ThreadListTable.vue` wraps its table in `overflow-x-auto`.

Symbols this feature changes. The baseline only locates the code and is never the interface to implement:

- `ThreadComposer.vue` contract.
  - Baseline: props `composerState`, `turnRunning`; emits `send(text)` and `stop`.
  - Target: props `composerState`, `turnRunning`, and `send: (text: string) => Promise<ThreadActionResult>`; emits `stop` only. The composer holds a local `sending` flag, set synchronously on entry to `sendDraft` (before `await validate()`) and cleared in a `finally`, so a second Enter during validation or during the send is ignored. While `sending` is true, Send is disabled and Enter does nothing. On `{ ok: true }` the field is reset with vee-validate's `resetField` (value empty, no validation error shown). On `{ ok: false }` the draft is kept and Send is enabled again. For `reason === 'archived'` it renders the refusal text only, with no textarea and no Send, the same way it already renders `readOnly`.
- Both thread detail pages (`pages/[project]/threads/[id].vue`, `pages/threads/[id].vue`).
  - Baseline: `onSend` returns `Promise<void>` and is bound to `@send`.
  - Target: `onSend(text)` is no longer built on the page's `runAction` (which returns `Promise<void>`); the other actions keep `runAction`. It calls `controller.send(text)`, toasts `extractApiError(result.error)` once on `{ ok: false }` (unchanged), and returns the `ThreadActionResult`. It is bound to the composer's `:send` prop.
- `ThreadControls.vue`.
  - Baseline: props `isCreator`, `canManage`, `sessionLabel`, `archived`; `showRaise = isCreator`; `capValue` starts as `''`.
  - Target: an added prop `maxCostUsd: string`; `showRaise = isCreator && !archived`; opening the Raise cap dialog sets the input to `maxCostUsd`. Both pages pass `thread.maxCostUsd`.
- `pages/[project]/threads/[id].vue` child order.
  - Baseline: Header, FlowsPanel, StartFlow, PreApprovalCard, Controls, StaleBanner, ModeControl, notices, ActionBar, QueuedNotice, Timeline, approvals, Composer.
  - Target: Header, Controls, StaleBanner, ModeControl, notices, ActionBar, QueuedNotice, Timeline, approvals, Composer, then FlowsPanel, StartFlow and PreApprovalCard below the composer.
- `ThreadPreApprovalCard.vue`: add a hint paragraph `fleet.flows.preapproval.hint` under the cost-cap input. en text: "Flows the agent starts from this thread run without asking you while their cost stays under this cap. This is separate from the thread's own cost cap." zh: "智能体从此线程发起的流程在成本低于此上限时无需你批准即可运行。此上限与线程自身的成本上限无关。"
- `ThreadMessage.vue`: the message root gains `min-w-0 max-w-full`. The assistant body becomes a horizontal scroll container (`overflow-x-auto`), so a `pre` block or a long token scrolls inside the message instead of widening the page. Keep `renderThreadMarkdown` and its sanitizer unchanged.
- `apps/web/lib/thread-view.ts`: add an export `isUnmeteredThread(thread: Pick<ThreadDto, 'backend' | 'costUsd' | 'tokens'>): boolean`. It is true exactly when `backend.kind === 'acp'`, `Number(costUsd) === 0` (a malformed `costUsd` that parses to `NaN` is false), and `tokens` is non-null with `input + output > 0`. `costText` is unchanged.
- `ThreadHeader.vue` and `ThreadListTable.vue`: where `costText(thread)` renders, an unmetered thread renders `t('fleet.threads.detail.unmetered')` instead, with `title` = `t('fleet.threads.detail.unmeteredHint')`. en: "Not metered" / "This agent does not report cost, so the cost cap does not apply." zh: "不计费" / "此智能体不报告成本，因此成本上限不适用。"
- `buildThreadCreateSchema(t)` in `apps/web/lib/thread-create.ts`.
  - Baseline: an empty feature on a REPO form reports `validation.feature`, the same key as a malformed one.
  - Target: the REPO rules stay in `superRefine`; only the feature rule splits. An empty feature reports `fleet.threads.new.validation.featureRequired` (en "Enter a feature name", zh "请输入功能标识"). A non-empty invalid feature keeps `validation.feature`, whose text gains the format: en "Use letters, digits, dot, dash or underscore, starting with a letter or digit (up to 128 characters)", zh "请使用字母、数字、点、连字符或下划线，并以字母或数字开头（最多 128 个字符）".
- `pages/[project]/threads/new.vue`: on a REPO form, the Repository and Feature labels show a required marker (`*`, `aria-hidden="true"`), and the Feature input carries `aria-required="true"`. When Create is disabled because the chosen agent is not available (a chosen agent exists, its `available` is false, and the form is not submitting; nothing renders while the runner list is still loading and no agent is chosen), a paragraph `data-testid="thread-new-unavailable"` next to Create shows `fleet.threads.new.agentUnavailable` (en "The chosen agent is not available on an online runner. Choose another agent or try again later.", zh "所选智能体在在线运行器上不可用。请选择其他智能体或稍后再试。"). In the live run this inert disabled button is why Create seemed to do nothing. A hint under Feature uses `fleet.threads.new.featureHint` (en "Names the branch and the nax feature, for example fix-login-redirect", zh "用于分支名和 nax 功能名，例如 fix-login-redirect"). A hint under Base ref uses `fleet.threads.new.baseRefHint` with `{branch}` = the selected repo's `defaultBranch` (en "Leave empty to start from {branch}", zh "留空则从 {branch} 开始").
- `pages/threads/new.vue`: while Home project is Automatic (`homeProject === ''`), a hint uses `fleet.threads.workspace.homeProjectAutoHint` (en "Automatic uses the oldest project you are a member of that has a repository", zh "自动选择你所属且有代码库的最早项目").
- `WorkspaceThreadsService.create` in `apps/api/src/fleet/threads/workspace-threads.service.ts`.
  - Baseline: both the explicit-home anchor check and the auto-pick failure throw `ConflictAppException({}, 'threads.noFleetRepo')`.
  - Target: the explicit-home branch throws `ConflictAppException({}, 'threads.homeNoRepo')`, and the auto-pick failure throws `ConflictAppException({}, 'threads.noDefaultHome')`, for user and agent principals alike. The pick rule (membership, `thread.create`, anchor) is unchanged. API i18n (`apps/api/src/i18n/{en,zh}/threads.json`), each under status `409`:
    - `homeNoRepo`: en "The chosen home project has no repository. Choose a project that has one.", zh "所选主项目没有代码库，请选择一个有代码库的项目。"
    - `noDefaultHome`: en "No project you are a member of has a repository, so Automatic cannot pick a home project. Choose one.", zh "你所属的项目都没有代码库，无法自动选择主项目，请手动选择。"
  - `threads.noFleetRepo` keeps its text and remains the key for project-thread paths (`threads.service.ts`, `prisma-chat-thread.repository.ts`).

### Failure Handling

- `onSend` toasts a refusal once and still returns the `{ ok: false }` result to the composer.
- A send refusal (`{ ok: false }`) keeps the draft, re-enables Send and toasts `extractApiError(error)` as today.
- A `send` promise that rejects instead of resolving keeps the draft and re-enables Send (the `finally` clears `sending`); the composer does not toast, since the page owns error presentation.
- A Raise cap dialog opened with a `maxCostUsd` the validator rejects keeps the existing confirm-time validation. Prefilling never emits.
- The workspace create 409s surface through the form's existing `submitError` paragraph. No web mapping is added.

## Out of Scope

- F16 (ACP progress text and answer joined with no separator): the join is in the installed `@nathapp/nax-agent-acp` collector (`parts.join("")`, every text chunk on round 0), not in koda. It is fixed upstream in nax, and koda only picks up the release.
- Enforcing a cost cap for unmetered (unpriced) backends, or estimating their cost: this feature only labels them.
- Changing the Automatic home rule (membership required, deliberate in the existing workspace-thread design and pinned by the service spec test "admin default requires actual membership"), and letting a global binding count as membership.
- Changing `threads.noFleetRepo` text or its project-thread call sites.
- Any change to the workspace thread page layout beyond the composer `send` prop and the controls `maxCostUsd` prop; it has no flows or pre-approval panels.
- Collapsing or merging thread controls beyond the moves listed in Design, and any redesign of the thread page.
- F3 and F18 (runner ACP readiness and offer list), and the ticket, not-found, naming and other findings: these are separate bundles.
- Live re-verification on koda-wk (390 px overflow, double-send, archived thread): a post-deploy manual check, not a story.

## Stories

**US-001: Composer clears a sent draft and blocks a second send while one is in flight.** Workdir: `apps/web`. No dependencies. Covers F1.

**US-002: Thread page puts the conversation first and respects the archived state.** Workdir: `apps/web`. Depends on US-001. Covers F14 (both edit `ThreadComposer.vue` and the thread pages).

**US-003: Message overflow and the unmetered cost label.** Workdir: `apps/web`. No dependencies. Covers F15 and F17.

**US-004: Thread create forms show required fields, format hints and the Automatic rule.** Workdir: `apps/web`. No dependencies. Covers F5 and the web half of F4.

**US-005: Workspace thread home errors say what failed.** Workdir: `apps/api`. No dependencies. Covers the API half of F4.

### Context Files

**US-001**
- `apps/web/lib/thread-controller.ts`
- `apps/web/components/fleet/threads/ThreadModeControl.vue`
- `apps/web/tests/components/thread-composer.spec.ts`
- `apps/web/tests/pages/threads-detail-actions-page.spec.ts`
- `apps/web/tests/pages/workspace-thread-detail-page.spec.ts`

**US-002**
- `apps/web/lib/thread-view.ts`
- `apps/web/lib/thread-types.ts`

**US-003**
- `apps/web/lib/thread-markdown.ts`
- `apps/web/lib/thread-types.ts`
- `apps/web/tests/components/thread-timeline.spec.ts`

**US-004**
- `apps/web/lib/fleet-dispatch.ts`
- `apps/web/lib/thread-create.ts`

**US-005**
- `apps/api/src/fleet/threads/workspace-threads.service.spec.ts`
- `apps/api/src/fleet/threads/threads.service.ts`
- `apps/api/src/i18n/en/threads.json`
- `apps/api/test/integration/fleet/workspace-create.integration.spec.ts`

### Creates

**US-003**
- `apps/web/tests/components/thread-message.spec.ts` — the first component spec for `ThreadMessage`; hosts US-003 AC-1 and AC-2.

### Modifies

**US-001**
- `apps/web/components/fleet/threads/ThreadComposer.vue` — replace the `send` emit with the `send` function prop, and add the in-flight guard and the clear-on-success behaviour.
- `apps/web/pages/[project]/threads/[id].vue` — `onSend` stops using `runAction`, returns the `ThreadActionResult` and binds to the composer's `:send` prop.
- `apps/web/pages/threads/[id].vue` — `onSend` stops using `runAction`, returns the `ThreadActionResult` and binds to the composer's `:send` prop.
- `apps/web/tests/components/thread-composer.spec.ts` — the AC1/AC2/AC3 and over-length tests assert `emitted('send')`. Mount with a `send` prop double and assert on its calls instead: the same texts reach it, Shift+Enter, whitespace and over-length drafts make zero calls. The readOnly, refusal and Stop tests stay as they are.
- `apps/web/tests/pages/threads-detail-actions-page.spec.ts` — its `ComposerStub` declares `emits: ['send', 'stop']` and emits `send` on Enter, so it cannot show the composer reacting to the page's result. Replace the stub with the real `ThreadComposer` loaded through `loadSfc`, the way the workspace thread detail page spec mounts it, and host US-001 AC-7 and AC-8 here. The page-level assertions (controller `send('hello')` once, toast on a failed send) keep holding.
- `apps/web/tests/pages/workspace-thread-detail-page.spec.ts` — its composer marker records only `composerState` and `turnRunning`. Add `send` to the recorded props where the page passes it, so marker-based assertions stay accurate. The real-composer Enter test keeps its controller assertion.

**US-002**
- `apps/web/components/fleet/threads/ThreadControls.vue` — add the `maxCostUsd` prop, hide Raise cap when archived, and prefill the cap dialog.
- `apps/web/components/fleet/threads/ThreadComposer.vue` — render only the refusal text for the `archived` reason.
- `apps/web/components/fleet/threads/ThreadPreApprovalCard.vue` — add the hint paragraph under the cost-cap input.
- `apps/web/pages/[project]/threads/[id].vue` — reorder the children per Design and pass `maxCostUsd` to the controls.
- `apps/web/pages/threads/[id].vue` — pass `maxCostUsd` to the controls.
- `apps/web/i18n/locales/en.json` — add `fleet.flows.preapproval.hint`.
- `apps/web/i18n/locales/zh.json` — add `fleet.flows.preapproval.hint`.
- `apps/web/tests/components/thread-controls.spec.ts` — the mount helper builds the props object. Add `maxCostUsd` with a default, so existing tests keep their meaning. Any assertion that Raise cap shows for a creator on an archived thread is replaced by the new hidden-when-archived invariant.
- `apps/web/tests/pages/threads-detail-page.spec.ts` — register marker stubs for ThreadControls, ThreadTimeline and ThreadComposer beside its existing FlowsPanel, StartFlow and PreApprovalCard stubs. Host US-002 AC-6 (document order) and the project half of AC-7 (`maxCostUsd` reaches the controls).
- `apps/web/tests/pages/threads-detail-actions-page.spec.ts` — its `ControlsStub` declares `props: ['isCreator','canManage','sessionLabel','archived']`. Add `maxCostUsd` so the stub keeps accepting the page's props.
- `apps/web/tests/pages/workspace-thread-detail-page.spec.ts` — its ThreadControls marker records only `isCreator`. Record `maxCostUsd` too and host the workspace half of US-002 AC-7.
- `apps/web/tests/components/thread-composer.spec.ts` — add the archived and closing refusal cases (US-002 AC-4 and AC-5).
- `apps/web/tests/components/thread-preapproval-card.spec.ts` — add the hint case (US-002 AC-8).

**US-003**
- `apps/web/components/fleet/threads/ThreadMessage.vue` — add the overflow classes on the message root and the assistant body.
- `apps/web/lib/thread-view.ts` — add `isUnmeteredThread`.
- `apps/web/components/fleet/threads/ThreadHeader.vue` — render the unmetered label in place of the cost text.
- `apps/web/components/fleet/threads/ThreadListTable.vue` — render the unmetered label in place of the cost text.
- `apps/web/i18n/locales/en.json` — add `fleet.threads.detail.unmetered` and `fleet.threads.detail.unmeteredHint`.
- `apps/web/i18n/locales/zh.json` — add `fleet.threads.detail.unmetered` and `fleet.threads.detail.unmeteredHint`.
- `apps/web/tests/lib/thread-view.spec.ts` — add the `isUnmeteredThread` cases (US-003 AC-3 to AC-5); the existing `costText` cases stay.
- `apps/web/tests/components/thread-header-workspace.spec.ts` — add the unmetered and metered header cases (US-003 AC-6 and AC-7).
- `apps/web/tests/components/thread-list-table.spec.ts` — add the mixed unmetered and native rows case (US-003 AC-8).

**US-004**
- `apps/web/lib/thread-create.ts` — add the `featureRequired` key for an empty feature.
- `apps/web/pages/[project]/threads/new.vue` — add the required markers, `aria-required`, the feature hint, the base-ref hint and the agent-unavailable paragraph next to Create.
- `apps/web/pages/threads/new.vue` — add the Automatic hint.
- `apps/web/i18n/locales/en.json` — add `featureRequired`, `featureHint`, `baseRefHint`, `agentUnavailable` and `homeProjectAutoHint`, and reword `validation.feature`.
- `apps/web/i18n/locales/zh.json` — add the same keys and reword `validation.feature`.
- `apps/web/tests/lib/thread-create-project.spec.ts` — if any case expects `validation.feature` for an EMPTY feature, it expects `validation.featureRequired` instead. Invalid non-empty features such as `a..b` keep `validation.feature`.
- `apps/web/tests/pages/threads-new-page.spec.ts` — host US-004 AC-3 to AC-7 (agent-unavailable paragraph, repo error on submit, required markers, hints).
- `apps/web/tests/pages/workspace-threads-new-page.spec.ts` — host US-004 AC-8 and AC-9 (Automatic hint, 409 message shown).

**US-005**
- `apps/api/src/fleet/threads/workspace-threads.service.ts` — throw `threads.homeNoRepo` on the explicit-home branch and `threads.noDefaultHome` on the auto-pick failure.
- `apps/api/src/i18n/en/threads.json` — add `homeNoRepo` and `noDefaultHome`, keeping `noFleetRepo`.
- `apps/api/src/i18n/zh/threads.json` — add `homeNoRepo` and `noDefaultHome`, keeping `noFleetRepo`.
- `apps/api/src/fleet/threads/workspace-threads.service.spec.ts` — AC-10 ("admin default requires actual membership") and the agent "no reachable project hosts the thread" test expect prefix `threads.noFleetRepo` for the auto-pick failure; they now expect `threads.noDefaultHome`, still with httpStatus 409 and no create. AC-12 ("explicit home needs a repo") expects `threads.noFleetRepo`; it now expects `threads.homeNoRepo` with httpStatus 409.
- `apps/api/test/integration/fleet/workspace-create.integration.spec.ts` — AC-10 (auto-pick with the root user's project roles revoked) and AC-12 (explicit home `web` with its repo deleted) assert the 409 message "This project has no repository, so a project thread cannot run"; AC-10 now expects the en `noDefaultHome` text and AC-12 the en `homeNoRepo` text.

### Seams

- US-001 drives the real `ThreadComposer` from each real thread detail page: a real Enter keypress reaches `useThread().send` through the page's `onSend`, and the composer reacts to the result the page returns.
- US-003's `isUnmeteredThread` is consumed by `ThreadHeader` and `ThreadListTable` in the same story. Its seam ACs mount those components with an unmetered thread and assert the label, not only the helper.
- US-005 changes only error keys. The web shows them through the existing `extractApiError` path, so no web seam is added.

## Acceptance Criteria

### US-001

- AC-1 [unit] Mounting `ThreadComposer` with `composerState` `{ canSend: true, reason: null }` and a `send` prop resolving `{ ok: true }`, then typing `hello` and pressing Enter, calls `send` once with `hello`; after the promise settles the textarea value is the empty string and no `thread-composer-error` element is rendered.
- AC-2 [unit] With a `send` prop resolving `{ ok: false, error }`, pressing Enter on `hello` calls `send` once, and after it settles the textarea still holds `hello` and the `thread-send` button is enabled.
- AC-3 [unit] While a `send` call is still pending, a second Enter press and a click on `thread-send` make zero additional `send` calls, and `thread-send` is disabled until the first call settles.
- AC-4 [unit] With a `send` prop whose promise rejects, Enter on `hello` calls `send` once; after the rejection the textarea still holds `hello` and `thread-send` is enabled.
- AC-5 [unit] After an `update:modelValue` from the textarea with `hello`, `thread-send` is enabled. After one with only whitespace, it is disabled.
- AC-6 [unit] Shift+Enter inserts a newline and makes zero `send` calls. A whitespace-only draft or a draft over 32768 UTF-8 bytes makes zero `send` calls on Enter, and the over-length draft shows the `thread-composer-error` message.
- AC-7 [integration] In `threads-detail-actions-page.spec.ts`, mounting `pages/[project]/threads/[id].vue` with the real `ThreadComposer` and a `useThread` double whose `send` resolves `{ ok: true }`: typing `hello` and pressing Enter calls the double's `send` once with `hello`, and the composer textarea is empty afterwards.
- AC-8 [integration] On the same page with the double's `send` resolving `{ ok: false, error }`, Enter on `hello` toasts `extractApiError(error)` once and the textarea still holds `hello`.
- AC-9 [integration] Mounting `pages/threads/[id].vue` (workspace thread) with the real composer and a `useThread` double resolving `{ ok: true }`, Enter on `hello` calls `send` once with `hello`, and the textarea is empty afterwards.

### US-002

- AC-1 [unit] `ThreadControls` with `isCreator: true`, `archived: true` and `maxCostUsd: '0.5'` renders no `thread-raise-cap` control. With `archived: false` it renders it.
- AC-2 [unit] With `maxCostUsd: '0.5'`, clicking `thread-raise-cap` opens the dialog with `thread-cap-input` holding `0.5`. Confirming without editing emits `raiseCap` with the number `0.5`.
- AC-3 [unit] With `maxCostUsd: '0.00001'`, opening the Raise cap dialog and confirming without editing emits no `raiseCap` and keeps the dialog open.
- AC-4 [unit] `ThreadComposer` with `composerState` `{ canSend: false, reason: 'archived' }` renders the `fleet.threads.refusal.archived` text, and renders neither `thread-composer-input` nor `thread-send`.
- AC-5 [unit] `ThreadComposer` with `composerState` `{ canSend: false, reason: 'closing' }` still renders the `fleet.threads.refusal.closing` text together with a disabled `thread-composer-input`.
- AC-6 [integration] Mounting `pages/[project]/threads/[id].vue` with a REPO thread, the thread timeline and the composer come before the flows panel, the start-flow control and the pre-approval card in document order, and the thread controls come before the timeline.
- AC-7 [integration] Mounting `pages/[project]/threads/[id].vue` with a thread whose `maxCostUsd` is `'0.5'` passes `maxCostUsd` `'0.5'` to `ThreadControls`. `pages/threads/[id].vue` does the same for a workspace thread.
- AC-8 [unit] `ThreadPreApprovalCard` for a REPO thread with no pre-approval, viewed with `fleet.thread.preapprove`, renders the `fleet.flows.preapproval.hint` text next to `preapproval-cap-input`.
- AC-9 [unit] Both `apps/web/i18n/locales/en.json` and `zh.json`, loaded as JSON, define a non-empty string at `fleet.flows.preapproval.hint`.

### US-003

- AC-1 [unit] Mounting `ThreadMessage` with an assistant message whose content is a fenced code block with a 300-character line: the assistant body element has class `overflow-x-auto`, the rendered `pre` is a descendant of it, and the message root has classes `min-w-0` and `max-w-full`.
- AC-2 [unit] Mounting `ThreadMessage` with a user message keeps its interpolated text (no `v-html`), and the message root still has `min-w-0` and `max-w-full`.
- AC-3 [unit] `isUnmeteredThread` returns true for `{ backend: { kind: 'acp', agent: 'codex' }, costUsd: '0', tokens: { input: 800, output: 76, cacheRead: 0, cacheWrite: 0 } }`.
- AC-4 [unit] `isUnmeteredThread` returns false for an ACP thread with `costUsd: '0.12'`, false for an ACP thread with `costUsd: '0'` and `tokens: null`, false for an ACP thread with `costUsd: '0'` and zero input and output tokens, and false for an ACP thread with `costUsd: 'abc'` and 876 total tokens.
- AC-5 [unit] `isUnmeteredThread` returns false for a native thread with `costUsd: '0'` and 876 total tokens.
- AC-6 [integration] `ThreadHeader` mounted with the unmetered ACP thread from AC-3 renders the `fleet.threads.detail.unmetered` text with a `title` of `fleet.threads.detail.unmeteredHint`, and renders no `$0 / $0.5` text.
- AC-7 [integration] `ThreadHeader` mounted with a native thread at `costUsd: '1.25'`, `maxCostUsd: '5'` still renders `$1.25 / $5`.
- AC-8 [integration] `ThreadListTable` mounted with one unmetered ACP thread and one native thread renders `fleet.threads.detail.unmetered` in the first row's cost cell and `costText` output in the second.
- AC-9 [unit] Both `en.json` and `zh.json`, loaded as JSON, define non-empty strings at `fleet.threads.detail.unmetered` and `fleet.threads.detail.unmeteredHint`.

### US-004

- AC-1 [unit] `buildThreadCreateSchema(t).safeParse` on a REPO form with a valid title and repo and an empty `feature` reports the feature issue message `fleet.threads.new.validation.featureRequired`.
- AC-2 [unit] On a REPO form with feature `a..b` or `-bad`, the feature issue message is `fleet.threads.new.validation.feature`. A PROJECT form with an empty feature and repo reports no `repoId` or `feature` issue.
- AC-3 [integration] Mounting `pages/[project]/threads/new.vue` with the chosen agent's `available` false renders `thread-new-unavailable` with the `fleet.threads.new.agentUnavailable` text, and the Create button is disabled.
- AC-4 [integration] With the chosen agent's `available` true, `thread-new-unavailable` is not rendered, and while the runner list has not loaded and no agent is chosen it is not rendered either.
- AC-5 [integration] In REPO scope with an available agent, a title filled and no repository chosen, clicking Create shows the `fleet.threads.new.validation.repoRequired` text next to the repository select and sends zero POST requests.
- AC-6 [integration] In REPO scope, the Repository and Feature labels each render a required marker, and `thread-new-feature` carries `aria-required="true"`.
- AC-7 [integration] In REPO scope the Feature field shows the `fleet.threads.new.featureHint` text. With a repo whose `defaultBranch` is `main` selected, the Base ref field shows `fleet.threads.new.baseRefHint` interpolated with `branch` = `main`.
- AC-8 [integration] Mounting `pages/threads/new.vue` with Home project on Automatic shows the `fleet.threads.workspace.homeProjectAutoHint` text. After choosing a named project the hint is not rendered.
- AC-9 [integration] On `pages/threads/new.vue`, when `POST /threads` rejects with a 409 envelope whose message is the en `noDefaultHome` text, that text is rendered in the form's `role="alert"` paragraph and no navigation happens.
- AC-10 [unit] Both `en.json` and `zh.json`, loaded as JSON, define non-empty strings at `fleet.threads.new.validation.featureRequired`, `fleet.threads.new.featureHint`, `fleet.threads.new.baseRefHint`, `fleet.threads.new.agentUnavailable` and `fleet.threads.workspace.homeProjectAutoHint`, and both `baseRefHint` strings contain the `{branch}` placeholder.

### US-005

- AC-1 [unit] `WorkspaceThreadsService.create` for a user principal with no project membership and no `homeProject` rejects with prefix `threads.noDefaultHome` and httpStatus 409, and the thread repository `create` is not called.
- AC-2 [unit] For an agent principal for which no reachable project passes the host checks, `create` without `homeProject` rejects with prefix `threads.noDefaultHome` and httpStatus 409.
- AC-3 [unit] With `homeProject` naming a reachable, hostable project that has no repository anchor, `create` rejects with prefix `threads.homeNoRepo` and httpStatus 409.
- AC-4 [unit] With no `homeProject` and a member project that has `thread.create` and an anchor, `create` still creates a WORKSPACE thread homed there with `repoId` null, and the returned `homeProject` carries that project's slug.
- AC-5 [unit] Loading `apps/api/src/i18n/en/threads.json` and `zh/threads.json` as JSON yields non-empty `409` strings for `homeNoRepo`, `noDefaultHome` and `noFleetRepo`, and the en `noDefaultHome` string equals "No project you are a member of has a repository, so Automatic cannot pick a home project. Choose one.".
