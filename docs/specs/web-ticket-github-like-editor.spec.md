# SPEC: Web Tickets and Comments GitHub-Like Markdown Experience

## Summary
Align ticket authoring and discussion UX with GitHub Issues by fixing type/priority selection reliability, matching ticket type options to API enums, and introducing a reusable markdown write/preview editor for ticket description and comments across create and edit flows.

## Motivation
Ticket create currently exposes incomplete type options and has unstable select behavior. Description and comments are plain textarea-only, which limits readability and editing ergonomics. There is no consistent markdown write/preview flow, and edit support for ticket description/comment body is missing in the UI.

## Design
Implementation approach: component-level refactor in Vue with shared reusable markdown editor component/composable, synchronous form validation and client-side preview rendering.

Exact types/functions/integration points to modify:
1. Enum source alignment
- Source-of-truth enum: `apps/api/src/common/enums.ts` (`TicketType`: BUG, ENHANCEMENT, TASK, QUESTION).
- Web option source must be centralized (shared constant/composable) and consumed by ticket create/edit forms.

2. Create ticket flow
- `apps/web/components/CreateTicketDialog.vue`
- Replace hardcoded type validation list with API-aligned set.
- Keep priority values aligned with current `Priority` enum.
- Ensure both `type` and `priority` selects are fully controlled and submit selected values.

3. Reusable markdown editor
- Add shared component for write/preview behavior:
```ts
interface MarkdownEditorProps {
  modelValue: string
  placeholder?: string
  previewMode?: 'write' | 'preview'
}
```
- Component behavior:
1. Write tab for markdown source
2. Preview tab for rendered markdown
3. Preserve line breaks and fenced code blocks

4. Ticket description edit flow
- Ticket detail route: `apps/web/pages/[project]/tickets/[ref].vue`
- Add edit action that updates ticket content using `PATCH /projects/:slug/tickets/:ref`.
- Editable fields in scope: `title`, `description`, `priority`.

5. Comment create/edit flow
- `apps/web/components/CommentThread.vue`
- Create flow uses markdown editor instead of raw textarea.
- Add per-comment edit action for body update using `PATCH /comments/:id`.

Existing pattern to follow:
- Use existing form stack (`vee-validate` + `zod`) and existing API/error handling pattern (`useApi`, `extractApiError`, localized toasts).

Failure handling:
- Fail-closed on invalid ticket type/priority selections (block submit with validation message).
- Fail-open on markdown preview render errors by showing plain text preview fallback.
- API update failures keep editor state intact and show localized error toast.

## Stories
1. **US-001: Centralize ticket type/priority option sources and fix create-form select behavior** — no dependencies
### Context Files (optional)
- `apps/web/components/CreateTicketDialog.vue`
- `apps/api/src/common/enums.ts`
- `apps/web/i18n/locales/en.json`
- `apps/web/i18n/locales/zh.json`

2. **US-002: Build reusable markdown write/preview editor component** — no dependencies
### Context Files (optional)
- `apps/web/components/ui/textarea/Textarea.vue`
- `apps/web/components/MarkdownEditor.vue`

3. **US-003: Apply markdown editor to ticket create and ticket edit description flows** — depends on US-001, US-002
### Context Files (optional)
- `apps/web/components/CreateTicketDialog.vue`
- `apps/web/pages/[project]/tickets/[ref].vue`

4. **US-004: Apply markdown editor to comment create and add comment edit flow** — depends on US-002
### Context Files (optional)
- `apps/web/components/CommentThread.vue`

## Acceptance Criteria
### US-001
- When ticket type options render in `CreateTicketDialog.vue`, then selectable values are `BUG`, `ENHANCEMENT`, `TASK`, and `QUESTION`.
- Given user selects a ticket type, when form submits, then payload field `type` equals the selected value.
- Given user selects priority, when form submits, then payload field `priority` equals the selected value.
- Given selected type is not in allowed enum set, when submit is attempted, then validation blocks request.
- Given selected type is not in allowed enum set, when submit is attempted, then localized type error text is shown.

### US-002
- When markdown editor renders in write mode, then it exposes editable markdown source bound to `modelValue`.
- When user switches editor to preview mode, then rendered output reflects current markdown source.
- Given markdown preview renderer throws, when preview is requested, then component shows plain-text fallback instead of breaking UI.
- Given parent uses `v-model`, when editor content changes, then component emits updated `modelValue`.

### US-003
- When create-ticket dialog description field is shown, then it uses markdown editor write/preview UI instead of plain textarea-only input.
- Given ticket detail page enters edit state, when user updates description and saves, then client calls `PATCH /projects/:slug/tickets/:ref` with updated `description`.
- Given ticket detail page enters edit state, when user updates title and saves, then client calls `PATCH /projects/:slug/tickets/:ref` with updated `title`.
- Given ticket detail page enters edit state, when user updates priority and saves, then client calls `PATCH /projects/:slug/tickets/:ref` with updated `priority`.
- Given ticket edit save succeeds, when request resolves, then ticket detail view refreshes.
- Given ticket edit save succeeds, when request resolves, then description panel displays updated rendered markdown.
- Given ticket edit save fails, when request rejects, then edit state and unsaved draft remain available to user.

### US-004
- When comment create form renders in `CommentThread.vue`, then comment body input uses markdown editor write/preview UI.
- Given user edits existing comment body and saves, when request is sent, then client calls `PATCH /comments/:id` with updated `body`.
- Given comment edit save succeeds, when request resolves, then updated comment body is shown in thread render.
- Given comment edit save fails, when request rejects, then inline edit draft is preserved.
- Given comment edit save fails, when request rejects, then localized error toast is shown.
