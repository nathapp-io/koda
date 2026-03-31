# SPEC: Koda Web Bugfix Batch — PR #3

## Summary

Two web bugs. Bug #25 is a navigation regression now resolved by the API fix in PR #27 (ref field); the web task is to verify the code path and add a test. Bug #24 is a missing Label Management page — implement it following the `agents.vue` pattern.

---

## Design

### Bug #25 — Ticket navigation uses `ticket.ref` (already correct, API now returns it)

`apps/web/pages/[project]/index.vue` line 40:
```ts
router.push(`/${slug}/tickets/${ticket.ref}`)
```

`ticket.ref` was `undefined` because the list API didn't return `ref`. PR #27 (US-004) added `ref` to `TicketResponseDto` and `findAll()`, so this is now populated. The task is to:
1. Confirm no other code path in the web constructs ticket URLs using `ticket.id` or `ticket.number` instead of `ticket.ref`
2. Add a unit/component test for `handleOpenTicket` asserting `router.push` receives a URL containing `NAX-1` (not `undefined`)

File to test: `apps/web/pages/[project]/index.vue` — `handleOpenTicket(ticket)` function.

---

### Bug #24 — Add Label Management page

No label management UI exists. Create `apps/web/pages/[project]/labels.vue` following the exact pattern of `apps/web/pages/[project]/agents.vue`.

**API endpoints (all scoped to project slug):**
- `GET  /projects/:slug/labels`                 → list labels
- `POST /projects/:slug/labels`                 → create label `{ name: string, color?: string }`
- `PATCH /projects/:slug/labels/:labelId`       → update label `{ name?: string, color?: string }`
- `DELETE /projects/:slug/labels/:labelId`      → delete label

**Page requirements:**
1. List all labels in a `<Table>` with columns: Color (swatch), Name, Actions
2. Inline "Create Label" form (or dialog) with fields: Name (required), Color (optional hex, default `#6366f1`)
3. Delete button per row — calls DELETE endpoint, refreshes list
4. (Optional) Inline edit — clicking label name opens an edit dialog. If too complex, skip for now.
5. Connect to sidebar navigation — add a "Labels" link in the project sidebar (wherever Agents/KB are linked)

**Color swatch:** render a small `<span>` with `background-color: label.color` (16×16px colored dot).

**Pattern to follow:** `apps/web/pages/[project]/agents.vue` — same `useAsyncData`, `$api`, toast patterns.

**i18n keys needed** (add to `apps/web/locales/en.json` and `apps/web/locales/zh.json`):
```json
"labels": {
  "title": "Labels",
  "columns": { "color": "Color", "name": "Name", "actions": "Actions" },
  "create": { "title": "Create Label", "name": "Name", "color": "Color", "submit": "Create" },
  "toast": { "created": "Label created", "deleted": "Label deleted", "createFailed": "Failed to create label", "deleteFailed": "Failed to delete label" },
  "empty": "No labels yet"
}
```

**Sidebar link:** Add a "Labels" entry alongside the Agents/KB links in the project layout or sidebar component.

---

## Stories

### US-007: Verify ticket navigation uses ref field (fix #25)

**Bug: #25**

#### Acceptance Criteria

1. `handleOpenTicket` in `apps/web/pages/[project]/index.vue` calls `router.push` with `/${slug}/tickets/${ticket.ref}` where `ticket.ref` is a non-undefined string (e.g. `'NAX-1'`)
2. No other component constructs ticket URLs using `ticket.id` or `ticket.number` as the path segment
3. A unit test exists for `handleOpenTicket` that passes a mock ticket with `ref: 'NAX-1'` and asserts `router.push` was called with `'/nax/tickets/NAX-1'`

#### Context Files

- `apps/web/pages/[project]/index.vue` — contains `handleOpenTicket`, verify no code change needed
- `apps/web/pages/[project]/index.spec.ts` (create if missing) — add unit test

---

### US-008: Add Label Management page (fix #24)

**Bug: #24**

#### Acceptance Criteria

1. `apps/web/pages/[project]/labels.vue` exists and renders a list of labels fetched from `GET /projects/:slug/labels`
2. Each row shows a color swatch (colored dot using `label.color`), the label name, and a Delete button
3. A "Create Label" form/section is present with Name (required) and Color (optional) fields; submitting calls `POST /projects/:slug/labels` and refreshes the list
4. Deleting a label calls `DELETE /projects/:slug/labels/:labelId` and refreshes the list
5. Success/error toasts shown for create and delete actions
6. i18n keys added to both `en.json` and `zh.json` under `labels.*`
7. A "Labels" navigation link is added to the project sidebar/layout so the page is reachable

#### Context Files

- `apps/web/pages/[project]/agents.vue` — pattern to follow exactly
- `apps/web/pages/[project]/labels.vue` — create this file
- `apps/web/locales/en.json` — add `labels.*` i18n keys
- `apps/web/locales/zh.json` — add `labels.*` i18n keys (same English values acceptable)
- `apps/web/layouts/default.vue` OR the sidebar component — add Labels nav link
- `apps/web/pages/[project]/labels.spec.ts` — add unit tests for list, create, delete

## Implementation Order

```
US-007 (verify nav fix)   → simple/fast, do first
US-008 (label page)       → medium, do second
```
