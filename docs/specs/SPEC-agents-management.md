# SPEC: Agents Management Page

**Issues:** #62, #63
**Branch:** `feat/agents-management-page`

## Summary

The agents page is incorrectly nested under `pages/[project]/agents.vue` and only supports status changes. This spec relocates it to a standalone top-level route (`/agents`) and expands it into a full admin management panel: create agent (with API key reveal), edit roles, edit capabilities, rotate API key, and delete agent.

## Motivation

- `pages/[project]/agents.vue` calls `GET /projects/${slug}/agents` which doesn't exist — the page 404s
- Agents are a system-level entity; nesting under a project route is semantically wrong
- The "Agents" nav link only appears when inside a project — hidden on the dashboard
- `POST /agents`, `PATCH /agents/:slug/update-roles`, `PATCH /agents/:slug/update-capabilities`, `POST /agents/:slug/rotate-key`, and `DELETE /agents/:slug` all exist in the API but are unused in the web UI

## Design

### Route change
`pages/[project]/agents.vue` → `pages/agents.vue` (maps to `/agents`)

### API endpoints used

| Method | Endpoint | Action |
|:-------|:---------|:-------|
| `GET` | `/agents` | List all agents |
| `POST` | `/agents` | Create agent (returns plaintext `apiKey` once) |
| `PATCH` | `/agents/:slug` | Update status |
| `PATCH` | `/agents/:slug/update-roles` | Update roles |
| `PATCH` | `/agents/:slug/update-capabilities` | Update capabilities |
| `POST` | `/agents/:slug/rotate-key` | Rotate API key (returns new `apiKey` once) |
| `DELETE` | `/agents/:slug` | Delete agent |

### Agent interface (web-side)

```typescript
interface Agent {
  id: string
  name: string
  slug: string
  roles: string[]           // 'VERIFIER' | 'DEVELOPER' | 'REVIEWER'
  capabilities: string[]    // free-text tags e.g. 'typescript', 'nestjs'
  status: 'ACTIVE' | 'PAUSED' | 'OFFLINE'
  maxConcurrentTickets: number
}
```

### Component breakdown

| Component | Purpose |
|:----------|:--------|
| `pages/agents.vue` | Parent page — table + page-level "Create Agent" button |
| `components/CreateAgentDialog.vue` | Form modal: name, slug (auto-derived), roles, capabilities, maxConcurrentTickets + API key reveal on success |
| `components/EditAgentRolesDialog.vue` | Checkbox modal for VERIFIER/DEVELOPER/REVIEWER |
| `components/EditAgentCapabilitiesDialog.vue` | Tag-input modal for free-text capabilities |
| `components/RotateKeyDialog.vue` | Confirm → rotate → API key reveal with copy-to-clipboard |
| `components/DeleteAgentDialog.vue` | Confirm → delete |

### API key display rule
Shown plaintext only on `POST /agents` and `POST /agents/:slug/rotate-key`. Render in a read-only `Input` with a Copy button (2s "Copied!" feedback). Include warning: "Copy this API key now. It will not be shown again."

### Form validation (CreateAgentDialog)
Follow `CreateProjectDialog.vue` pattern: vee-validate + toTypedSchema + zod.
- `name`: required
- `slug`: required, pattern `/^[a-z0-9-]+$/`, auto-derived from name (kebab-case) but user-editable
- `roles`: min 1 required
- `capabilities`: optional, string[]
- `maxConcurrentTickets`: integer ≥ 1, default 3

### Layout changes (`layouts/default.vue`)
- Remove `<NuxtLink :to="'/${projectSlug}/agents'">` from the `v-if="projectSlug"` block
- Add `<NuxtLink to="/agents">` in the always-visible nav section (alongside Dashboard), Bot icon
- Add breadcrumb case: `route.path === '/agents'` → `[{ label: 'Koda', to: '/' }, { label: t('nav.agents') }]`

### i18n keys to add (`en.json` + `zh.json`, under `agents`)
```json
{
  "createAgent": "Create Agent",
  "form": { "title": "Create Agent", "name": "Name", "slug": "Slug", "roles": "Roles", "capabilities": "Capabilities", "maxConcurrentTickets": "Max Concurrent Tickets", "creating": "Creating...", "create": "Create" },
  "apiKeyReveal": { "title": "Agent Created", "message": "Copy this API key now. It will not be shown again.", "copy": "Copy", "copied": "Copied!" },
  "rotateKey": { "title": "Rotate API Key", "confirm": "This will invalidate the current key immediately. Continue?", "newKey": "New API Key", "rotate": "Rotate Key" },
  "deleteAgent": { "title": "Delete Agent", "confirm": "Are you sure you want to delete {name}? This cannot be undone.", "delete": "Delete" },
  "editRoles": { "title": "Edit Roles" },
  "editCapabilities": { "title": "Edit Capabilities", "placeholder": "Type and press Enter" },
  "actions": { "editRoles": "Edit Roles", "editCapabilities": "Edit Capabilities", "rotateKey": "Rotate Key", "delete": "Delete" },
  "toast": {
    "created": "Agent created successfully",
    "rolesUpdated": "Roles updated",
    "capabilitiesUpdated": "Capabilities updated",
    "keyRotated": "API key rotated",
    "deleted": "Agent deleted",
    "createFailed": "Failed to create agent",
    "updateFailed": "Failed to update agent",
    "deleteFailed": "Failed to delete agent"
  }
}
```

## Stories

### US-001: Move agents page to standalone route + fix layout nav

Move `pages/[project]/agents.vue` → `pages/agents.vue`. Remove `route.params.project` dependency. Fix `useAsyncData` to key `'agents'` and fetch `GET /agents`. Fix `changeStatus` to call `PATCH /agents/${agent.slug}`. Update `layouts/default.vue`: remove project-scoped Agents link, add global `/agents` link, add breadcrumb case.

**Context Files:**
- `apps/web/pages/[project]/agents.vue`
- `apps/web/layouts/default.vue`
- `apps/web/composables/useApi.ts`
- `apps/web/i18n/locales/en.json`

**Dependencies:** none

### US-002: CreateAgentDialog with API key reveal

Create `components/CreateAgentDialog.vue`. Wire "Create Agent" button into `pages/agents.vue`.

**Context Files:**
- `apps/web/pages/agents.vue`
- `apps/web/components/CreateProjectDialog.vue`
- `apps/web/components/KbAddDocumentDialog.vue`
- `apps/web/composables/useApi.ts`
- `apps/web/composables/useAppToast.ts`
- `apps/web/i18n/locales/en.json`
- `apps/web/i18n/locales/zh.json`

**Dependencies:** US-001

### US-003: EditAgentRolesDialog + EditAgentCapabilitiesDialog

Create both edit dialogs. Wire "Edit Roles" and "Edit Capabilities" items into the actions dropdown per agent row.

**Context Files:**
- `apps/web/pages/agents.vue`
- `apps/web/components/CreateAgentDialog.vue`
- `apps/web/composables/useApi.ts`
- `apps/web/composables/useAppToast.ts`
- `apps/web/i18n/locales/en.json`
- `apps/web/i18n/locales/zh.json`

**Dependencies:** US-002

### US-004: RotateKeyDialog + DeleteAgentDialog

Create both destructive dialogs. Wire "Rotate Key" and "Delete" items into the actions dropdown per agent row.

**Context Files:**
- `apps/web/pages/agents.vue`
- `apps/web/components/CreateAgentDialog.vue`
- `apps/web/composables/useApi.ts`
- `apps/web/composables/useAppToast.ts`
- `apps/web/i18n/locales/en.json`
- `apps/web/i18n/locales/zh.json`

**Dependencies:** US-002

## Acceptance Criteria

### US-001
- `pages/[project]/agents.vue` does not exist; `pages/agents.vue` exists
- `useAsyncData` key is `'agents'` with no slug; fetches `$api.get('/agents')`
- `changeStatus` calls `$api.patch('/agents/' + agent.slug, { status: newStatus })`
- `layouts/default.vue` does not contain a NuxtLink to `/${projectSlug}/agents`
- `layouts/default.vue` contains `<NuxtLink to="/agents">` outside any `v-if="projectSlug"` block, using the Bot icon
- `breadcrumbItems` returns `[{ label: 'Koda', to: '/' }, { label: t('nav.agents') }]` when `route.path === '/agents'`

### US-002
- `CreateAgentDialog.vue` renders fields: name, slug (auto-derives kebab-case from name, user-editable), roles (checkboxes VERIFIER/DEVELOPER/REVIEWER, min 1), capabilities (tag input), maxConcurrentTickets (number, default 3)
- Form submits `$api.post('/agents', { name, slug, roles, capabilities, maxConcurrentTickets })`
- On success, dialog switches to key-reveal view: read-only Input with `apiKey`, Copy button (clipboard + 2s "Copied!" feedback), warning message, Done button
- Done button closes dialog and emits `'created'`; `pages/agents.vue` calls `refresh()` on `'created'`
- `pages/agents.vue` has a "Create Agent" button in the PageHeader area that opens `CreateAgentDialog`

### US-003
- `EditAgentRolesDialog.vue` pre-checks agent's current roles; submits `$api.patch('/agents/' + agent.slug + '/update-roles', { roles })`; on success emits `'updated'` and shows toast
- `EditAgentCapabilitiesDialog.vue` renders current capabilities as removable Badge tags; Enter in Input appends tag; submits `$api.patch('/agents/' + agent.slug + '/update-capabilities', { capabilities })`; on success emits `'updated'` and shows toast
- Actions dropdown in `pages/agents.vue` includes "Edit Roles" and "Edit Capabilities" per row; `refresh()` called on `'updated'`

### US-004
- `RotateKeyDialog.vue` shows confirm message; on confirm calls `$api.post('/agents/' + agent.slug + '/rotate-key', {})`; on success switches to key-reveal view (same Copy + warning pattern as CreateAgentDialog); Done emits `'rotated'`
- `DeleteAgentDialog.vue` shows confirm with agent name; on confirm calls `$api.delete('/agents/' + agent.slug)`; on success shows toast, emits `'deleted'`, closes
- Actions dropdown in `pages/agents.vue` includes "Rotate Key" and "Delete" per row; `refresh()` called on both events
