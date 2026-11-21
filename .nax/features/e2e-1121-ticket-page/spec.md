# SPEC: Ticket page fixes from the 2026-11-21 A-Z e2e run

## Summary

Fix the ticket-page findings from the 2026-11-21 A-Z end-to-end run on koda-wk (`2579ca3d`):
- Posted comments show raw markdown (F2) and no author (F12).
- Markdown lists render without bullets and inline code has no styling (F23).
- Ticket and comment delete use the browser's native `window.confirm` (F6).
- The Verify dialog hides that a comment is required (F7).
- An invalid link URL and a failed login show raw server text (F8).
- The label picker is empty with no hint when the project has no labels (F24).
- "Unassign" shows on an unassigned ticket (F25).
- The Create Ticket dialog labels are not tied to their inputs (F19).

This feature also adds the shared styled confirm dialog (`useConfirm` plus `ConfirmDialogHost`). A follow-up feature, `e2e-1121-confirm-dialogs`, moves the remaining `window.confirm` sites onto it. The findings report is `projects/koda/e2e-2026-11-21/koda-wk-a-z-e2e-findings-2026-11-21.md` in the workspace repo.

## Motivation

- F2: `CommentThread.vue` renders a comment body through `splitMentions` as plain text in a `whitespace-pre-wrap` paragraph. The Preview tab and the ticket description render markdown, so `**markdown**` and `- one` show literally only after posting.
- F12: comment cards show a type chip and a time only. Agent-written, assistant-proposed and human comments look the same, although `CommentResponseDto` already carries `authorUserId` and `authorAgentId`.
- F23: `MarkdownEditor.vue` styles its preview with `prose prose-sm dark:prose-invert`, but `@tailwindcss/typography` is not installed (`tailwind.config.ts` has `plugins: []`). The classes do nothing, Tailwind's preflight removes list markers, and inline `code` gets no styling. The description and comment bodies have the same problem.
- F6: `TicketProperties.vue` `deleteTicket` and `CommentThread.vue` `deleteComment` call `window.confirm`. The browser can suppress that dialog, it says nothing about what happens, and it does not match the styled Archive dialog on threads.
- F7: every `TicketActionPanel.vue` dialog action requires a comment (`canSubmit` needs a non-blank comment), but the dialog shows only the placeholder "Enter a comment or reason...", so Confirm looks broken while it is disabled.
- F8 (link): `CreateTicketLinkDto` rejects a bad URL with the hardcoded English message "url must be a valid URL", and the web form sends any non-blank text.
- F8 (login): `AuthService.login` throws `new AuthException({}, 'auth')`, which resolves to `auth.40000` ("Unauthorized"). The API already has the unused text `auth.invalidCredentials` ("Invalid email or password").
- F24: with no project labels, the label Select opens empty, with no hint that labels are created on the Labels page.
- F25: the assignee row renders Unassign whenever `canAssign` is true, even when `ticket.assignee` is null.
- F19: `FormLabel` (`components/ui/form/FormLabel.vue`) renders a bare `<label>` and `FormControl` is a bare slot, so nothing sets `for` and `id`. Screen readers and `getByLabel` cannot find the Create Ticket fields.

## Design

### Integration

Symbols this feature only reads:

- `renderMarkdownOrEscape(markdown: string): string` in `apps/web/lib/markdown.ts`: sanitized HTML that never throws (the M24 contract).
- `withMentionChips(markdown, nameOf: (userId: string) => string | null): string` in `apps/web/lib/mentions.ts`: replaces `@[Label](user:<id>)` tokens with `<span class="mention-chip">@Name</span>`, falling back to the token label when `nameOf` returns null. The sanitizer keeps exactly that class.
- `renderThreadMarkdown` in `apps/web/lib/thread-markdown.ts` is the precedent for removing images from agent-steered markdown: it applies `renderMarkdownOrEscape(content).replace(/<img\b[^>]*>/gi, '')`.
- `useProjectMemberNames(slug)` returns `{ members, load, nameOf(userId): string | null }`. `useProjectAgentNames(slug)` returns `{ agents, load, nameOf(agentId): string | null }`. Both are auto-imported, and both are used together by `pages/[project]/timeline.vue`.
- `CommentResponseDto` (API): `id`, `ticketId`, `body`, `type`, `authorUserId: string | null`, `authorAgentId: string | null`, `createdAt`, `updatedAt`.
- `isSafeUrl(url)` in `apps/web/lib/safe-url.ts`: a scheme allow-list for `:href`. It accepts relative URLs, so it is not a form validator.
- Thread Archive dialog in `components/fleet/threads/ThreadControls.vue`: the styled confirm precedent. It uses `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, a muted body paragraph and `DialogFooter` with a Cancel (`variant="outline"`) and a Confirm button.
- `NativeSelect.vue` (`FleetNativeSelect`) forwards its `id` prop to the `<select>`. `MarkdownEditor.vue` forwards fallthrough attributes (so `id`) to its `Textarea`.
- `tests/helpers/mount-sfc.ts`: Nuxt auto-imports are injected from `NUXT_AUTO_IMPORTS`, and `AUTO_IMPORT_DEFAULTS` supplies defaults. `useProjectAgentNames` already defaults to `{ agents: [], load: async () => undefined, nameOf: () => null }`.
- API locale: a request with `Accept-Language: zh` gets the `apps/api/src/i18n/zh/*` text (precedent: `test/integration/auth/password-change.integration.spec.ts`).

Symbols this feature changes. The baseline only locates the code and is never the interface to implement:

- New `apps/web/composables/useConfirm.ts` (auto-imported). It has no precedent in the app, so here is a worked skeleton:

  ```ts
  import { computed, shallowRef } from 'vue'

  export interface ConfirmOptions { title: string; body?: string; confirmLabel?: string; destructive?: boolean }
  interface Pending { options: ConfirmOptions; resolve: (ok: boolean) => void }

  // One dialog per tab. Client-only: confirm() is called from event handlers, never during setup or SSR.
  const pending = shallowRef<Pending | null>(null)

  export function useConfirm() {
    function confirm(options: ConfirmOptions): Promise<boolean> {
      pending.value?.resolve(false)
      return new Promise<boolean>((resolve) => { pending.value = { options, resolve } })
    }
    function settle(ok: boolean): void {
      const current = pending.value
      if (!current) return
      pending.value = null
      current.resolve(ok)
    }
    return { confirm, settle, current: computed(() => pending.value?.options ?? null) }
  }
  ```

- New `apps/web/components/ConfirmDialogHost.vue`. It reads `useConfirm().current` and renders, only while `current` is non-null, a `Dialog` (open) with `DialogContent data-testid="confirm-dialog"` containing:
  - `DialogTitle` = `title`;
  - a muted paragraph `data-testid="confirm-dialog-body"` = `body`, shown only when `body` is set;
  - `DialogFooter` with Cancel (`data-testid="confirm-dialog-cancel"`, `variant="outline"`, `t('common.cancel')`) and Confirm (`data-testid="confirm-dialog-confirm"`, text `confirmLabel ?? t('common.confirm')`, `variant="destructive"` when `destructive` is true and `"default"` otherwise).

  Confirm calls `settle(true)`. Cancel, and the `Dialog` emitting `update:open` with `false` (Escape, overlay), call `settle(false)`.
- `apps/web/app.vue`.
  - Baseline: `NuxtLayout` > `NuxtPage`, then `Toaster`.
  - Target: the same, plus one `<ConfirmDialogHost />` after `Toaster`.
- `apps/web/lib/markdown.ts`.
  - Baseline: `renderMarkdownOrEscape(markdown)` and `renderSafeMarkdown(markdown)` call `marked.parse(markdown, { async: false })`.
  - Target: both take an optional second argument `options: { breaks?: boolean } = {}`, and `renderSafeMarkdown` passes `breaks: options.breaks === true` to `marked.parse`. Existing one-argument callers render exactly as before.
  - Target: add the export `renderMarkdownWithoutImages(markdown: string, options: { breaks?: boolean } = {}): string` = `sanitizeHtmlFragment(renderMarkdownOrEscape(markdown, options).replace(/<img\b[^>]*>/gi, ''))`. Comments can be written by agents (MCP, fleet), so a comment must not make the browser fetch a URL, the same rule `renderThreadMarkdown` applies to thread messages. The second sanitize is required, not optional: stripping an `img` tag with a regex over serialized HTML can end an attribute early (a link `title` that holds `<img b=` swallows the following markup), and a string that re-parses with a live event attribute must not reach `v-html`. The sanitizer config is unchanged.
- `apps/web/lib/thread-markdown.ts` `renderThreadMarkdown(content, slug?)`.
  - Baseline: `renderMarkdownOrEscape(content).replace(IMG_TAG, '')`, sanitized a second time only on the `slug` branch. The no-slug branch (reached when `ThreadTimeline` gets its default `slug` of `''`) returns the regex output unsanitized.
  - Target: the image-free HTML comes from `renderMarkdownWithoutImages(content)` (no `breaks`), so every branch returns sanitized HTML; the `slug` branch then linkifies and sanitizes as today. Unused `IMG_TAG` is removed.
- `apps/web/assets/css/globals.css`: add a `.markdown-body` rule set in `@layer components`, built on the existing tokens:
  - `ul` with disc markers and `ol` with decimal markers, both with left padding;
  - spacing between `p`, list and `pre` blocks;
  - inline `code` with `bg-muted`, rounded corners, horizontal padding and a mono font;
  - `pre` with `bg-muted`, padding, `overflow-x-auto` and no extra background on its inner `code`;
  - `a` with `text-link` and an underline;
  - `blockquote` with a left border in `border-border` and `text-muted-foreground`;
  - `h1`-`h3` with font weight and size steps.

  `.markdown-body` is a plain component class that the sanitizer never sees, because it sits on the container, not in user HTML.
- `apps/web/components/CommentThread.vue`.
  - Baseline: the body is `splitMentions(comment.body)` interpolation in a `p.whitespace-pre-wrap`. Each card has no author. `deleteComment` gates on `window.confirm(t('comments.confirmDelete'))`.
  - Target, body: a `div` with `data-testid="comment-body"` and class `markdown-body text-sm` whose `v-html` is `renderMarkdownWithoutImages(withMentionChips(comment.body, id => memberNames.nameOf(id) ?? null), { breaks: true })`. `breaks: true` keeps a single typed newline as a line break, which the removed `whitespace-pre-wrap` used to show. `splitMentions` is no longer imported here. Comments can be agent-written, so this is a deliberate second exception to the web context rule that agent-written text renders through `{{ }}` only. It carries the same guarantees as the thread-message exception: images removed, and the output sanitized after the removal.
  - Target, author: `memberNames` and `agentNames` (`useProjectAgentNames(projectSlug)`) both load on mount. Each sets its own `membersLoaded` / `agentsLoaded` ref to true when its `load()` resolves; a rejected load is caught and leaves the flag false. Name lookups use `??`, because harness stubs return `undefined` as well as `null`. The header row gains, before the type chip, a `span data-testid="comment-author"` (rendered only when its text is non-empty) and, for agent comments, a badge `data-testid="comment-author-agent"` with `t('comments.author.agentBadge')`. The author text is:
    - for `authorUserId` set: `memberNames.nameOf(authorUserId)`; else `t('comments.author.formerMember')` when `membersLoaded`; else `t('comments.author.member')` (the list is still loading, or the viewer may not read members);
    - else for `authorAgentId` set: `agentNames.nameOf(authorAgentId)`; else `t('comments.author.unknownAgent')` when `agentsLoaded`; else empty (only the badge shows);
    - else `t('comments.author.system')`, with no badge.

    The local `Comment` interface gains `authorUserId?: string | null` and `authorAgentId?: string | null`.
  - Target, delete: `deleteComment` awaits `useConfirm().confirm({ title: t('comments.confirmDelete'), body: t('comments.deleteBody'), confirmLabel: t('common.delete'), destructive: true })` and returns when it resolves false.
- `apps/web/components/TicketActivity.vue`: the description container keeps its `v-html`, its renderer (`renderMarkdownOrEscape(withMentionChips(...))`) and its `whitespace-pre-wrap`, and gains the class `markdown-body` and `data-testid="ticket-description-body"`.
- `apps/web/components/MarkdownEditor.vue`: the preview container's `prose prose-sm dark:prose-invert max-w-none` classes are replaced by `markdown-body text-sm`, and it gains `data-testid="markdown-preview"`.
- `apps/web/lib/safe-url.ts`: add the export `isHttpUrl(value: string): boolean`, a client approximation of the API's `@IsUrl({})` (class-validator `isURL` defaults: a host must be an IP address or have a top-level domain). It is true when all hold, and false otherwise, including when parsing throws:
  - `new URL(value)` parses with no base;
  - its `protocol` is `http:` or `https:`;
  - its `hostname` is a dotted-quad IPv4 address, or contains a dot and its last dot-separated label is at least 2 characters of letters or starts with `xn--`.

  A scheme-less value such as `example.com/pull/1` (which the API accepts) is rejected on purpose: the link is stored as typed and rendered as an `href`, where a scheme-less value resolves relative to koda.
- `apps/web/components/TicketProperties.vue`.
  - Baseline: `deleteTicket` gates on `window.confirm(t('tickets.delete.confirm'))`. Unassign renders whenever `canAssign`. The label `Select` renders whenever `canLabel`. `addLink` posts any non-blank text.
  - Target, delete: `deleteTicket` awaits `useConfirm().confirm({ title: t('tickets.delete.confirm'), body: t('tickets.delete.confirmBody'), confirmLabel: t('tickets.delete.button'), destructive: true })` and returns when it resolves false.
  - Target, Unassign: it renders only when `canAssign` and `ticket.assignee` is non-null.
  - Target, labels: when `canLabel` and `allLabels` is empty, the Select and its Add button are replaced by a paragraph `data-testid="ticket-labels-none"` with `t('tickets.labels.noneInProject')` and a `NuxtLink` to `/${projectSlug}/labels` with `t('tickets.labels.manage')`.
  - Target, links: a computed `linkUrlInvalid` is true when the trimmed URL is non-empty and `isHttpUrl` returns false. While it is true, the Add Link button is disabled and a paragraph `data-testid="ticket-link-url-error"` shows `t('tickets.links.invalidUrl')`. A blank URL keeps Add disabled and shows no message.
- `apps/web/components/TicketActionPanel.vue`: the dialog `Textarea` gets `id="ticket-action-comment"`, `aria-required="true"` and `aria-describedby="ticket-action-comment-hint"`. A `Label` with `for="ticket-action-comment"` and text `t('tickets.actions.commentLabel')` sits above it. Under it, a paragraph `id="ticket-action-comment-hint"` with `data-testid="ticket-action-comment-hint"` shows `t('tickets.actions.commentRequired')`. `canSubmit` is unchanged.
- `apps/web/components/CreateTicketDialog.vue`: each `FormLabel` gets a `for` that matches its control's `id`:
  - title: `create-ticket-title` (on the `Input`);
  - type: `create-ticket-type` (the `FleetNativeSelect` `id`, was `type`);
  - priority: `create-ticket-priority` (was `priority`);
  - description: `create-ticket-description` (on the `MarkdownEditor`, which forwards it to its `Textarea`).
- `AuthService.login` in `apps/api/src/auth/auth.service.ts`.
  - Baseline: the unknown-email branch and the wrong-password-or-disabled branch both throw `new AuthException({}, 'auth')`.
  - Target: both throw `new AuthException({}, 'auth.invalidCredentials')`. `issueSession` and its fence refusal, `refresh` and every other `AuthException({}, 'auth')` are unchanged.
  - The key becomes a status-code map, following `auth.currentPasswordWrong`: en `"invalidCredentials": { "40000": "Invalid email or password" }` and zh `"invalidCredentials": { "40000": "无效的邮箱或密码" }` in `apps/api/src/i18n/{en,zh}/auth.json`. `40000` is `CommonExceptionCode.UNAUTHORIZED`, the code `AuthException` carries, and the exception's i18n key is its `prefix` getter. The response keeps HTTP 401.

New web i18n keys (en / zh), in both `apps/web/i18n/locales/en.json` and `zh.json`:

| key | en | zh |
|---|---|---|
| `comments.deleteBody` | The comment is removed from the ticket's activity. | 该评论将从工单动态中移除。 |
| `comments.author.formerMember` | Former member | 前成员 |
| `comments.author.member` | Member | 成员 |
| `comments.author.unknownAgent` | Removed agent | 已移除的智能体 |
| `comments.author.agentBadge` | Agent | 智能体 |
| `comments.author.system` | System | 系统 |
| `tickets.delete.confirmBody` | The ticket is removed from the board, search and its project. This cannot be undone from the app. | 该工单将从看板、搜索和项目中移除，且无法在应用中撤销。 |
| `tickets.labels.noneInProject` | This project has no labels yet. | 此项目还没有标签。 |
| `tickets.labels.manage` | Create labels | 创建标签 |
| `tickets.links.invalidUrl` | Enter a full http:// or https:// URL | 请输入完整的 http:// 或 https:// 链接 |
| `tickets.actions.commentLabel` | Comment | 评论 |
| `tickets.actions.commentRequired` | A comment is required to continue. | 需要填写评论才能继续。 |

### Failure Handling

- A `confirm()` that resolves false (Cancel, Escape, overlay, or a newer `confirm()` replacing it) sends no request and shows no toast.
- A DELETE that fails after a confirmed dialog keeps today's `toast.error(extractApiError(err))`.
- A rejected `useProjectAgentNames` or `useProjectMemberNames` load is caught (no unhandled rejection), and the author line falls back as in Design.

## Out of Scope

- The 18 other `window.confirm` sites (admin roles, approval policies, skills, fleet repos, analytics, provider keys, runners, budgets, schedules, VCS secret rotate, invites, members, project delete, KB documents, flow stop, and the repo-config leave guard). They move to `useConfirm` in the follow-up feature `e2e-1121-confirm-dialogs`.
- Wiring `for`/`id` inside the shared `FormLabel` and `FormControl` primitives app-wide: this feature only pairs them by hand in `CreateTicketDialog.vue`. Also out: the thread forms' axe findings (`label`, `select-name`) and the approval-policies `scrollable-region-focusable` finding.
- Adding `@tailwindcss/typography`, and the `prose` classes used outside `MarkdownEditor.vue`.
- Localizing the API's hardcoded `CreateTicketLinkDto` message "url must be a valid URL", and aligning server-side URL validation with the client's `isHttpUrl`.
- The generic "Unauthorized" text on refresh, on the `issueSession` fence refusal (a sign-in that races a password change), and on every other `AuthException({}, 'auth')` site: only the two `login` credential branches change.
- Telling an assistant-proposed comment apart from one its human approver posted: comments carry no proposal marker, so they show their recorded author.
- Rendering comment images: they are removed, as in thread messages.
- Images in ticket descriptions, and the description's own renderer and `whitespace-pre-wrap`: unchanged here.
- Names of members beyond the first 100 that `useProjectMemberNames` loads: such a comment author shows "Former member", the same limit the fleet pages have.
- `renderMarkdownWithoutImages` raising: it cannot, because `renderMarkdownOrEscape` already escapes on a renderer error (unchanged baseline).
- A link URL that passes `isHttpUrl` but that the API still rejects for another reason keeps today's toast of the API message (unchanged baseline). Other differences between `isHttpUrl` and class-validator `isURL` (ports, userinfo, unusual TLDs) are not mirrored.
- Moving the new-link form or the transition comment onto vee-validate + zod: both stay the raw controls they are today; the URL check is a computed over `isHttpUrl`.
- Updating `.nax/mono/apps/web/context.md`, both the line "Comments render tokens via `splitMentions` (no v-html)" and the rule that runner- and agent-written text renders through `{{ }}` only (adding ticket comments as a second exception beside thread assistant content): `.nax/` is read-only to the run, so it is a manual step after merge (edit, then `nax generate`).
- Calling `useConfirm().confirm()` during SSR or component setup: the store is per-tab module state for event handlers only.
- Visual checks of the `.markdown-body` styles (bullets, code tint, dark mode, and the description's block spacing, where `whitespace-pre-wrap` still adds blank lines between blocks) and of the styled dialogs: a post-deploy manual check on koda-wk, not a story.
- F9, F10, F11, F13, F20-F22 and F26-F30 (not-found pages, palette search, readable names, dashboard rows, page titles, header bells, toast position, dispatch form, auth page polish, board, analytics warnings): these are separate bundles.

## Stories

### US-001: Shared styled confirm dialog

No dependencies. Workdir: `apps/web`.

Add `composables/useConfirm.ts` and `components/ConfirmDialogHost.vue` as in Design, and mount one host in `app.vue`. Add `useConfirm` to the mount harness auto-imports with a default that resolves true, so existing specs that mount a component calling it keep working.

### US-002: Comments render markdown

No dependencies. Workdir: `apps/web`.

Add the `breaks` option and `renderMarkdownWithoutImages` to `lib/markdown.ts`, route `renderThreadMarkdown` through it, and add the `.markdown-body` CSS. Render comment bodies through it in `CommentThread.vue`, and apply `markdown-body` to the ticket description (`TicketActivity.vue`) and the editor preview (`MarkdownEditor.vue`). Jest cannot load the real `marked` and `isomorphic-dompurify` (see `tests/lib/markdown.spec.ts`), so the rendering and sanitizer ACs run in a new real-stack harness under `tests/harness/`, wired into `test:real-sanitizer`; component mounts alias `~/lib/markdown` to a stub, as `markdown-editor-mentions.spec.ts` does.

### US-003: Comment author and styled comment delete

Depends on US-001. Workdir: `apps/web`.

Show the comment author line in `CommentThread.vue` as in Design, and confirm a comment delete through `useConfirm`.

### US-004: Ticket delete, assignee and label fixes

Depends on US-001. Workdir: `apps/web`.

In `TicketProperties.vue`: confirm a ticket delete through `useConfirm`, hide Unassign on an unassigned ticket, and show the no-labels hint.

### US-005: Link URL validation

Depends on US-004. Workdir: `apps/web`.

Add `isHttpUrl` to `lib/safe-url.ts`, and validate the new-link URL with it in `TicketProperties.vue` as in Design. It depends on US-004 only because both edit `TicketProperties.vue`.

### US-006: Transition comment hint and Create Ticket labels

No dependencies. Workdir: `apps/web`.

Label and describe the required comment in `TicketActionPanel.vue`, and pair every Create Ticket label with its control in `CreateTicketDialog.vue`.

### US-007: Login failure says invalid email or password

No dependencies. Workdir: `apps/api`.

Make both `AuthService.login` credential branches throw `auth.invalidCredentials`, in en and zh, as in Design.

### Context Files

**US-001**
- `apps/web/components/fleet/threads/ThreadControls.vue` — styled Archive dialog precedent
- `apps/web/app.vue` — host mount point
- `apps/web/tests/helpers/fleet-harness.ts` — `uiStubs` for Dialog parts and `enI18n`

**US-002**
- `apps/web/lib/thread-markdown.ts` — image-stripping precedent, changed here
- `apps/web/tests/harness/thread-markdown-real-sanitizer.ts` — real marked + DOMPurify harness precedent (jsdom parse)
- `apps/web/assets/css/globals.css` — tokens and `@layer components`
- `apps/web/tests/components/comment-thread-time.spec.ts` — CommentThread mount harness precedent
- `apps/web/tests/components/markdown-editor-mentions.spec.ts` — `~/lib/markdown` alias precedent

**US-003**
- `apps/web/composables/useProjectAgentNames.ts` — agent name lookup
- `apps/web/pages/[project]/timeline.vue` — member-then-agent naming precedent
- `apps/web/tests/components/CommentThread.spec.ts` — CommentThread mount harness

**US-004**
- `apps/web/tests/components/ticket-assignee-collapsed.spec.ts` — TicketProperties mount harness
- `apps/web/pages/[project]/labels.vue` — the Labels page the hint links to

**US-005**
- `apps/web/lib/safe-url.ts` — sibling URL helpers
- `apps/web/tests/components/ticket-assignee-collapsed.spec.ts` — TicketProperties mount harness

**US-006**
- `apps/web/components/fleet/NativeSelect.vue` — forwards `id` to the select
- `apps/web/components/MarkdownEditor.vue` — forwards `id` to its textarea

**US-007**
- `apps/api/src/i18n/en/auth.json` — status-code map precedent `currentPasswordWrong`
- `apps/api/test/integration/auth/password-change.integration.spec.ts` — `Accept-Language: zh` assertion precedent
- `apps/api/test/integration/auth/disabled-user.integration.spec.ts` — disabled-user fixture precedent

### Creates

**US-001**
- `apps/web/composables/useConfirm.ts`
- `apps/web/components/ConfirmDialogHost.vue`
- `apps/web/tests/composables/useConfirm.spec.ts` — AC-1 to AC-4
- `apps/web/tests/components/confirm-dialog-host.spec.ts` — AC-5 to AC-13

**US-002**
- `apps/web/tests/harness/markdown-without-images-real-sanitizer.ts` — AC-1 to AC-6 (real stack, run by bun)
- `apps/web/tests/components/comment-thread-markdown.spec.ts` — AC-7 to AC-9
- `apps/web/tests/components/ticket-markdown-body.spec.ts` — AC-10 and AC-11

**US-003**
- `apps/web/tests/components/comment-thread-author.spec.ts`

**US-004**
- `apps/web/tests/components/ticket-properties-e2e-1121.spec.ts`

**US-005**
- `apps/web/tests/lib/safe-url-http.spec.ts`
- `apps/web/tests/components/ticket-link-url.spec.ts`

**US-006**
- `apps/web/tests/components/ticket-form-labels.spec.ts` — AC-1 to AC-8 (TicketActionPanel and CreateTicketDialog)

**US-007**
- `apps/api/test/integration/auth/login-failure-message.integration.spec.ts` — AC-1 to AC-4

### Modifies

**US-001**
- `apps/web/tests/helpers/mount-sfc.ts` — add `useConfirm` to `NUXT_AUTO_IMPORTS`, and to `AUTO_IMPORT_DEFAULTS` as `() => ({ confirm: async () => true, settle: () => undefined, current: { value: null } })`, so every existing mount of a component that now calls `useConfirm` still runs. A spec that tests the dialog overrides it through `globals`.

**US-002**
- `apps/web/tests/components/markdown-editor-mentions.spec.ts` — the test "comments render tokens as chips without v-html; descriptions run through withMentionChips" asserts that `CommentThread.vue` contains `splitMentions(comment.body)` and `class="mention-chip"` and has no `v-html` bound to a comment. Those three assertions are replaced by the invariant that `CommentThread.vue` renders a comment body through `withMentionChips` and `renderMarkdownWithoutImages` into `[data-testid="comment-body"]`. Its `TicketActivity.vue` `renderMarkdownOrEscape(withMentionChips(` assertion and the `:mention-slug` test are unchanged.
- `apps/web/tests/lib/thread-markdown.spec.ts` — the test "the rewritten HTML is sanitized again before it is rendered" expects the sanitizer double called 2 times for a slug render, and "without a slug the output is sanitized once" expects 1. With the image-free HTML now sanitized once more, the counts become 3 and 2. The invariants stay: the final sanitize call receives the linkified HTML (anchors included), and the no-slug output is sanitized after the images are removed.
- `apps/web/tests/components/CommentThread.spec.ts` — `mountThread` mounts the real `CommentThread.vue`, which now imports the markdown lib, and jest cannot load `isomorphic-dompurify`. Its mount aliases the markdown lib module to a stub whose renderMarkdownWithoutImages returns its input; every existing assertion stays unchanged.
- `apps/web/tests/components/CommentThread-edit.spec.ts` — `mountComments` mounts the real `CommentThread.vue`, which now imports the markdown lib, and jest cannot load `isomorphic-dompurify`. Its mount aliases the markdown lib module to a stub whose renderMarkdownWithoutImages returns its input; every existing assertion stays unchanged.
- `apps/web/tests/components/comment-thread-time.spec.ts` — its mount of the real `CommentThread.vue`, which now imports the markdown lib, cannot load `isomorphic-dompurify` under jest. Its mount aliases the markdown lib module to a stub whose renderMarkdownWithoutImages returns its input; every existing assertion stays unchanged.
- `apps/web/package.json` — the `test:real-sanitizer` script also runs the new markdown-without-images harness that US-002 creates, so `bun run test` executes the new real-stack checks.

**US-003**
- `apps/web/tests/e2e/ticket-detail-operations.e2e.spec.ts` — the comment-delete journey's `page.once('dialog', ...)` native-dialog handler is replaced by clicking `[data-testid="confirm-dialog-confirm"]` after Delete. The invariant is that the DELETE request for the comment is sent.

**US-004**
- `apps/web/tests/pages/project-permission-gates.spec.ts` — the US-007 AC-1 test "only that key renders Change and no label select, link form or delete button" mounts the default ticket fixture with `assignee: null`. It now passes a fixture with an assignee (for example `{ kind: 'user', id: 'u2', name: 'Bob' }`), so its `Unassign` expectation still holds. The invariant: with only `ticket.assign`, an assigned ticket shows Change and Unassign and no other gated control. The "(control)" test is unchanged.
- `apps/web/tests/pages/project-permission-gates.spec.ts` — the test "AC-2: ticket.label.assign alone renders the label select" mounts the page with the project labels route serving an empty list and expects the Add Label button. That test's route now serves one project label (for example `{ id: 'l9', name: 'ux', color: '#123456' }`). The invariant: with `ticket.label.assign` and at least one project label, the label select and Add Label render.
- `apps/web/tests/e2e/ticket-detail-operations.e2e.spec.ts` — the "sends assign, close, and delete ticket requests" journey's `page.once('dialog', ...)` handler is replaced by clicking `[data-testid="confirm-dialog-confirm"]` after Delete Ticket (never a role-and-name locator: the confirm button reads "Delete Ticket" too). The invariant is that the DELETE ticket request is sent.

**US-005**
None. No existing test pins the link form's enabled state for a non-http value.

**US-006**
None. No existing test pins the Create Ticket select ids or the transition dialog's textarea attributes.

**US-007**
- `apps/api/src/auth/auth.service.spec.ts` — add the AC-5 and AC-6 tests here, next to the existing `login` and `refresh` tests, which stay unchanged.

### Seams

- US-001 -> US-003: `CommentThread.vue` calls `useConfirm().confirm` from its Delete click (US-003 AC-9 to AC-11).
- US-001 -> US-004: `TicketProperties.vue` calls `useConfirm().confirm` from its Delete Ticket click (US-004 AC-1 to AC-3).
- US-001 internal: the host renders and settles the composable's pending request (US-001 AC-6 to AC-12), and `app.vue` mounts exactly one `ConfirmDialogHost` (US-001 AC-13).
- US-002 internal: `CommentThread.vue` passes the mention-chipped body and `{ breaks: true }` to `renderMarkdownWithoutImages` (US-002 AC-7).

## Acceptance Criteria

### US-001

`useConfirm` holds module state, so every spec in this story settles any pending request in an `afterEach` (or isolates the module per test), and no test depends on another's leftover request.

1. [unit] `useConfirm().confirm({ title: 'T' })` returns a promise that resolves `true` after `settle(true)` is called.
2. [unit] `useConfirm().confirm({ title: 'T' })` returns a promise that resolves `false` after `settle(false)` is called.
3. [unit] Calling `useConfirm().confirm({ title: 'B' })` while a request titled `A` is pending resolves the `A` promise with `false`, and `current.value.title` is then `B`.
4. [unit] With no pending request, `useConfirm().settle(true)` leaves `current.value` `null`.
5. [unit] `ConfirmDialogHost`, mounted with no pending request, renders no `[data-testid="confirm-dialog"]` element.
6. [unit] After `confirm({ title: 'Delete it?', body: 'Gone for good.', confirmLabel: 'Delete', destructive: true })`, the mounted `ConfirmDialogHost` shows `Delete it?` in its title.
7. [unit] In that mount, `[data-testid="confirm-dialog-body"]` reads `Gone for good.`.
8. [unit] In that mount, `[data-testid="confirm-dialog-confirm"]` reads `Delete` and has `variant` `destructive`.
9. [unit] After `confirm({ title: 'T' })` with no `confirmLabel`, `[data-testid="confirm-dialog-confirm"]` reads `t('common.confirm')` (en "Confirm").
10. [unit] Clicking `[data-testid="confirm-dialog-confirm"]` resolves the pending `confirm()` promise with `true`.
11. [unit] Clicking `[data-testid="confirm-dialog-cancel"]` resolves the pending `confirm()` promise with `false`.
12. [unit] The host's `Dialog` emitting `update:open` with `false` resolves the pending `confirm()` promise with `false`.
13. [unit] Mounting `app.vue` (with `NuxtLayout`, `NuxtPage` and `Toaster` stubbed) renders exactly one `ConfirmDialogHost` component.

### US-002

AC-1 to AC-6 run against the real `marked` and `isomorphic-dompurify`, and parse the returned HTML with jsdom, as `tests/harness/thread-markdown-real-sanitizer.ts` does. The AC-1 and AC-6 payload ends in a closed attribute (`x="y"`) on purpose: with the strip alone and no second sanitize it yields an element with a live `onmouseover`, so the check fails on the old code. A `v-html` value is a string in the Jest mount harness (`mount-sfc.ts` stores it as `props.innerHTML`), so AC-7 to AC-9 read that string.

1. [integration] `renderMarkdownWithoutImages('[x](https://e.com "a<img b=")\n\n" onmouseover="alert(1)" x="y"')` returns HTML in which no element carries an `onmouseover` attribute.
2. [integration] `renderMarkdownWithoutImages('see ![x](https://example.com/a.png) here')` returns HTML with no `img` element that still contains the text `see` and `here`.
3. [integration] `renderMarkdownWithoutImages('[x](javascript:alert(1))')` returns HTML with no `a` element whose `href` starts with `javascript:`.
4. [integration] `renderMarkdownWithoutImages('<script>alert(1)</script>ok')` returns HTML with no `script` element.
5. [integration] `renderMarkdownWithoutImages('line one\nline two', { breaks: true })` returns HTML with a `br` element between `line one` and `line two`.
6. [integration] `renderThreadMarkdown('[x](https://e.com "a<img b=")\n\n" onmouseover="alert(1)" x="y"')`, called with no slug, returns HTML in which no element carries an `onmouseover` attribute.
7. [unit] A mounted `CommentThread`, with `~/lib/markdown` aliased to a stub and `useProjectMemberNames().nameOf('c000000000000000000000009')` returning `Ada`, calls the stub's `renderMarkdownWithoutImages` for a comment whose body is `hi @[Old](user:c000000000000000000000009)` (the real `withMentionChips`; mention ids must match `MENTION_TOKEN`'s cuid shape) with `hi <span class="mention-chip">@Ada</span>` and `{ breaks: true }`.
8. [unit] In that mount, the `innerHTML` of `[data-testid="comment-body"]` equals the string the `renderMarkdownWithoutImages` stub returned.
9. [unit] In that mount, `[data-testid="comment-body"]` has the class `markdown-body`.
10. [unit] A mounted `TicketActivity` with a non-empty `ticket.description` and `editing` false renders `[data-testid="ticket-description-body"]` with the class `markdown-body`.
11. [unit] A mounted `MarkdownEditor` (with `~/lib/markdown` aliased to a stub and the tab parts stubbed so the preview content renders) renders `[data-testid="markdown-preview"]` with the class `markdown-body`.

### US-003

1. [unit] A mounted `CommentThread` whose `useProjectMemberNames().nameOf('u1')` returns `Ada` shows `Ada` in `[data-testid="comment-author"]` for a comment with `authorUserId: 'u1'`.
2. [unit] A mounted `CommentThread` whose member `load()` resolves and whose `nameOf('u1')` returns `null` shows `t('comments.author.formerMember')` (en "Former member") in `[data-testid="comment-author"]` for a comment with `authorUserId: 'u1'`.
3. [unit] A mounted `CommentThread` whose member `load()` resolves and whose `nameOf('u1')` returns `undefined` shows `t('comments.author.formerMember')` in `[data-testid="comment-author"]` for a comment with `authorUserId: 'u1'`.
4. [unit] A mounted `CommentThread` whose member `load()` rejects shows `t('comments.author.member')` (en "Member") in `[data-testid="comment-author"]` for a comment with `authorUserId: 'u1'`.
5. [unit] A mounted `CommentThread` whose `useProjectAgentNames().nameOf('a1')` returns `mcp-probe` shows `mcp-probe` in `[data-testid="comment-author"]` and `t('comments.author.agentBadge')` (en "Agent") in `[data-testid="comment-author-agent"]` for a comment with `authorUserId: null` and `authorAgentId: 'a1'`.
6. [unit] A mounted `CommentThread` whose agent `load()` resolves and whose `nameOf('a1')` returns `null` shows `t('comments.author.unknownAgent')` (en "Removed agent") in `[data-testid="comment-author"]` for a comment with `authorAgentId: 'a1'`.
7. [unit] A mounted `CommentThread` whose agent `load()` rejects renders no `[data-testid="comment-author"]` for a comment with `authorAgentId: 'a1'`.
8. [unit] A mounted `CommentThread` shows `t('comments.author.system')` (en "System") in `[data-testid="comment-author"]` for a comment whose `authorUserId` and `authorAgentId` are both `null`.
9. [unit] Clicking a comment's Delete button in a mounted `CommentThread` calls the `useConfirm().confirm` stub once with `{ title: t('comments.confirmDelete'), body: t('comments.deleteBody'), confirmLabel: t('common.delete'), destructive: true }`.
10. [unit] When the `useConfirm().confirm` stub resolves `false`, clicking a comment's Delete button sends no `$api.delete` call.
11. [unit] When the `useConfirm().confirm` stub resolves `true`, clicking Delete on comment `c1` calls `$api.delete` once with the path `/comments/c1`.
12. [unit] When the stub resolves `true` and `$api.delete` rejects, clicking Delete calls `toast.error` once with `extractApiError` of that rejection.

### US-004

1. [unit] With `canDelete` true, clicking Delete Ticket in a mounted `TicketProperties` calls the `useConfirm().confirm` stub once with `{ title: t('tickets.delete.confirm'), body: t('tickets.delete.confirmBody'), confirmLabel: t('tickets.delete.button'), destructive: true }`.
2. [unit] When the `useConfirm().confirm` stub resolves `false`, clicking Delete Ticket sends no `$api.delete` call and does not call `navigateTo`.
3. [unit] When the `useConfirm().confirm` stub resolves `true`, clicking Delete Ticket on ticket `WEB-1` in project `web` calls `$api.delete` with `/projects/web/tickets/WEB-1` and then `navigateTo('/web')`.
4. [unit] When the stub resolves `true` and `$api.delete` rejects, clicking Delete Ticket calls `toast.error` once with `extractApiError` of that rejection and does not call `navigateTo`.
5. [unit] A mounted `TicketProperties` with `canAssign` true and `ticket.assignee` `null` renders no Unassign button and renders `[data-testid="assignee-change"]`.
6. [unit] A mounted `TicketProperties` with `canAssign` true and `ticket.assignee` `{ kind: 'user', id: 'u2', name: 'Bob' }` renders an Unassign button.
7. [unit] A mounted `TicketProperties` in project `web` with `canLabel` true and `allLabels` `[]` renders `[data-testid="ticket-labels-none"]` with `t('tickets.labels.noneInProject')` and a link to `/web/labels` reading `t('tickets.labels.manage')`, and renders no label select.
8. [unit] A mounted `TicketProperties` with `canLabel` true and one label in `allLabels` renders the label select and no `[data-testid="ticket-labels-none"]`.

### US-005

1. [unit] In a mounted `TicketProperties` with `canLink` true, entering `not a url` as the link URL disables the Add Link button and shows `t('tickets.links.invalidUrl')` in `[data-testid="ticket-link-url-error"]`.
2. [unit] In a mounted `TicketProperties` with `canLink` true, entering `https://example.com/pull/1` enables Add Link and shows no `[data-testid="ticket-link-url-error"]`.
3. [unit] In that mount, clicking Add Link with `https://example.com/pull/1` calls `$api.post` with the body `{ url: 'https://example.com/pull/1', linkType: 'pr' }`.
4. [unit] In a mounted `TicketProperties` with `canLink` true and a blank link URL, Add Link is disabled and no `[data-testid="ticket-link-url-error"]` renders.
5. [unit] `isHttpUrl` returns `true` for `https://example.com/pull/1` and for `http://10.0.0.5/x`.
6. [unit] `isHttpUrl` returns `false` for `http://localhost:8030/x`, whose host has no top-level domain (the API rejects it too).
7. [unit] `isHttpUrl` returns `false` for `ftp://example.com/a` and for `javascript:alert(1)`.
8. [unit] `isHttpUrl` returns `false` for `example.com/pull/1`, which has no scheme.
9. [unit] `isHttpUrl` returns `false` for the empty string.

### US-006

1. [unit] Opening the Verify dialog in a mounted `TicketActionPanel` (with `allowedActions: ['verify']`) renders `[data-testid="ticket-action-comment-hint"]` with `t('tickets.actions.commentRequired')` (en "A comment is required to continue.").
2. [unit] In the opened Verify dialog, a label with `for="ticket-action-comment"` reads `t('tickets.actions.commentLabel')`, and the textarea has `id="ticket-action-comment"`.
3. [unit] In the opened Verify dialog, the textarea has `aria-required="true"` and `aria-describedby="ticket-action-comment-hint"`.
4. [unit] In the opened Verify dialog with a blank comment, the Confirm button is disabled, and after the comment `ok` is entered it is enabled.
5. [unit] A mounted `CreateTicketDialog` renders the title label with `for="create-ticket-title"` and an input with `id="create-ticket-title"`.
6. [unit] A mounted `CreateTicketDialog` renders the type label with `for="create-ticket-type"` and a select with `id="create-ticket-type"`.
7. [unit] A mounted `CreateTicketDialog` renders the priority label with `for="create-ticket-priority"` and a select with `id="create-ticket-priority"`.
8. [unit] A mounted `CreateTicketDialog` (with `~/components/MarkdownEditor.vue` aliased to a stub) renders the description label with `for="create-ticket-description"`, and the `MarkdownEditor` stub receives `id="create-ticket-description"`.

### US-007

1. [integration] `POST /api/auth/login` with an email no user has answers HTTP 401 with `message` `Invalid email or password`.
2. [integration] `POST /api/auth/login` with a real user's email and a wrong password answers HTTP 401 with `message` `Invalid email or password`.
3. [integration] `POST /api/auth/login` with a disabled user's email and correct password answers HTTP 401 with `message` `Invalid email or password`.
4. [integration] `POST /api/auth/login` with a wrong password and `Accept-Language: zh` answers HTTP 401 with `message` `无效的邮箱或密码`.
5. [unit] `AuthService.login` with an unknown email rejects with an `AuthException` whose `prefix` is `auth.invalidCredentials`.
6. [unit] `AuthService.refresh` with a principal whose `revoked` is `true` still rejects with an `AuthException` whose `prefix` is `auth`.
