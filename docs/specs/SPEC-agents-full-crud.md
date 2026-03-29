# SPEC: Agents Management — Full CRUD

**Issue:** #63
**Branch:** `feat/agents-management-page`
**Depends on:** SPEC-agents-page-relocation (US-001 must be complete before starting this spec)

## Summary

Expand `pages/agents.vue` from a read-only status-toggle table into a full admin management panel. Agents can be created (API key revealed once), have their roles and capabilities edited inline, have their API key rotated (key shown once with copy-to-clipboard), and be deleted with a confirmation step.

## Motivation

The following API endpoints exist and are unused by the web UI:
- `POST /agents` — create agent
- `PATCH /agents/:slug/update-roles` — update roles
- `PATCH /agents/:slug/update-capabilities` — update capabilities
- `POST /agents/:slug/rotate-key` — rotate API key
- `DELETE /agents/:slug` — delete agent

There is also no "Create Agent" button, making the web UI unusable as an admin panel.

## Design

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
| `pages/agents.vue` | Parent page — table + page-level actions |
| `components/CreateAgentDialog.vue` | Modal form: name, slug (auto-derived), roles, capabilities, maxConcurrentTickets. On success: show API key once |
| `components/EditAgentRolesDialog.vue` | Modal: checkbox group for VERIFIER/DEVELOPER/REVIEWER |
| `components/EditAgentCapabilitiesDialog.vue` | Modal: tag input for free-text capabilities |
| `components/RotateKeyDialog.vue` | Confirm dialog → on confirm: show new API key with copy-to-clipboard |
| `components/DeleteAgentDialog.vue` | Confirm dialog → on confirm: DELETE /agents/:slug |

### API key display rule

API key is only available from the server in two moments:
1. `POST /agents` → response includes `apiKey`
2. `POST /agents/:slug/rotate-key` → response includes `apiKey`

After either, show the key in a read-only `Input` with a "Copy" button. Warn the user it cannot be retrieved again.

### Form validation (CreateAgentDialog)

- `name`: required, min 1 char
- `slug`: required, auto-derived from name (kebab-case), user-editable, pattern `/^[a-z0-9-]+$/`
- `roles`: at least one role required
- `capabilities`: optional
- `maxConcurrentTickets`: integer ≥ 1, default 3

### i18n keys to add (en.json)

```json
{
  "agents": {
    "createAgent": "Create Agent",
    "form": {
      "title": "Create Agent",
      "name": "Name",
      "slug": "Slug",
      "roles": "Roles",
      "capabilities": "Capabilities",
      "maxConcurrentTickets": "Max Concurrent Tickets",
      "creating": "Creating...",
      "create": "Create"
    },
    "apiKeyReveal": {
      "title": "Agent Created",
      "message": "Copy this API key now. It will not be shown again.",
      "copy": "Copy",
      "copied": "Copied!"
    },
    "rotateKey": {
      "title": "Rotate API Key",
      "confirm": "This will invalidate the current key immediately. Continue?",
      "newKey": "New API Key",
      "rotate": "Rotate Key"
    },
    "deleteAgent": {
      "title": "Delete Agent",
      "confirm": "Are you sure you want to delete {name}? This cannot be undone.",
      "delete": "Delete"
    },
    "editRoles": {
      "title": "Edit Roles"
    },
    "editCapabilities": {
      "title": "Edit Capabilities",
      "placeholder": "Type and press Enter"
    },
    "toast": {
      "created": "Agent created successfully",
      "rolesUpdated": "Roles updated",
      "capabilitiesUpdated": "Capabilities updated",
      "keyRotated": "API key rotated",
      "deleted": "Agent deleted",
      "createFailed": "Failed to create agent",
      "updateFailed": "Failed to update agent",
      "deleteFailed": "Failed to delete agent"
    },
    "actions": {
      "editRoles": "Edit Roles",
      "editCapabilities": "Edit Capabilities",
      "rotateKey": "Rotate Key",
      "delete": "Delete"
    }
  }
}
```

### Pattern references

- Follow `CreateProjectDialog.vue` for form + vee-validate + toTypedSchema + zod pattern
- Follow `KbAddDocumentDialog.vue` for modal + form + toast pattern
- Follow existing `DropdownMenu` usage in `pages/agents.vue` for the actions column

## Stories

### US-001: CreateAgentDialog — form + API key reveal

Create `apps/web/components/CreateAgentDialog.vue`. Wire up "Create Agent" button in `pages/agents.vue`.

**Context Files:**
- `apps/web/pages/agents.vue` — parent page to add button + open state
- `apps/web/components/CreateProjectDialog.vue` — form pattern to follow (vee-validate + toTypedSchema + zod)
- `apps/web/components/KbAddDocumentDialog.vue` — modal + submit + toast pattern
- `apps/web/composables/useApi.ts` — `$api.post` usage
- `apps/web/i18n/locales/en.json` — add new i18n keys
- `apps/web/i18n/locales/zh.json` — mirror new i18n keys

**Dependencies:** none (page already exists from SPEC-agents-page-relocation)

### US-002: EditAgentRolesDialog + EditAgentCapabilitiesDialog

Create `apps/web/components/EditAgentRolesDialog.vue` (checkbox group for VERIFIER/DEVELOPER/REVIEWER) and `apps/web/components/EditAgentCapabilitiesDialog.vue` (tag input: type + Enter to add, click badge to remove). Wire both into the actions dropdown in `pages/agents.vue`.

**Context Files:**
- `apps/web/pages/agents.vue` — actions dropdown to extend
- `apps/web/components/CreateAgentDialog.vue` — modal pattern (from US-001)
- `apps/web/composables/useApi.ts` — `$api.patch` usage
- `apps/web/i18n/locales/en.json` — add editRoles/editCapabilities keys
- `apps/web/i18n/locales/zh.json` — mirror

**Dependencies:** US-001

### US-003: RotateKeyDialog + DeleteAgentDialog

Create `apps/web/components/RotateKeyDialog.vue` (confirm → call `POST /agents/:slug/rotate-key` → show new key with copy button) and `apps/web/components/DeleteAgentDialog.vue` (confirm → call `DELETE /agents/:slug` → remove from list). Wire both into the actions dropdown in `pages/agents.vue`.

**Context Files:**
- `apps/web/pages/agents.vue` — actions dropdown to extend
- `apps/web/components/CreateAgentDialog.vue` — modal + API key reveal pattern (from US-001)
- `apps/web/composables/useApi.ts` — `$api.post`, `$api.delete` usage
- `apps/web/i18n/locales/en.json` — add rotateKey/deleteAgent keys
- `apps/web/i18n/locales/zh.json` — mirror

**Dependencies:** US-001

## Acceptance Criteria

### US-001
- `components/CreateAgentDialog.vue` renders a Dialog with fields: name (text), slug (text, auto-derived from name as kebab-case, editable), roles (multi-checkbox: VERIFIER/DEVELOPER/REVIEWER), capabilities (tag input), maxConcurrentTickets (number, default 3)
- Slug auto-derives from name field on input (e.g. "Subrina Coder" → "subrina-coder") but allows manual override
- Form submission calls `$api.post('/agents', { name, slug, roles, capabilities, maxConcurrentTickets })`
- On success, the dialog transitions to an API key reveal view showing a read-only `Input` with the returned `apiKey` value and a "Copy" button
- Clicking "Copy" copies `apiKey` to clipboard and shows "Copied!" text on the button for 2 seconds
- The API key reveal view shows a warning message indicating the key cannot be retrieved again
- Closing the dialog after key reveal calls `refresh()` on the agent list and emits `'created'`
- On API error, `toast.error()` is called with the extracted error message via `extractApiError`
- `pages/agents.vue` has a "Create Agent" button in the `PageHeader` area that opens `CreateAgentDialog`

### US-002
- `components/EditAgentRolesDialog.vue` renders a Dialog pre-populated with the agent's current roles as checked checkboxes
- Submitting `EditAgentRolesDialog` calls `$api.patch('/agents/${agent.slug}/update-roles', { roles: string[] })`
- On success, `toast.success()` is shown and the agent list is refreshed
- `components/EditAgentCapabilitiesDialog.vue` renders a Dialog with current capabilities as removable Badge tags and an Input for adding new ones (press Enter to add)
- Submitting `EditAgentCapabilitiesDialog` calls `$api.patch('/agents/${agent.slug}/update-capabilities', { capabilities: string[] })`
- On success, `toast.success()` is shown and the agent list is refreshed
- The actions dropdown in `pages/agents.vue` includes "Edit Roles" and "Edit Capabilities" items that open the respective dialogs with the correct agent

### US-003
- `components/RotateKeyDialog.vue` renders a confirmation Dialog; on confirm, calls `$api.post('/agents/${agent.slug}/rotate-key', {})`
- On rotate-key success, the dialog transitions to an API key reveal view (same pattern as CreateAgentDialog: read-only input + copy button + "cannot retrieve again" warning)
- `components/DeleteAgentDialog.vue` renders a confirmation Dialog with agent name in the message; on confirm, calls `$api.delete('/agents/${agent.slug}')`
- On delete success, `toast.success()` is shown, the dialog closes, and the agent list refreshes (the deleted agent no longer appears)
- On any API error in either dialog, `toast.error()` is called with the extracted error message
- The actions dropdown in `pages/agents.vue` includes "Rotate Key" and "Delete" items that open the respective dialogs with the correct agent
