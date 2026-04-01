# SPEC: Web Agents I18n and Capabilities Array UX

## Summary
Fix agent-management UX issues by removing hardcoded UI text, adding missing translation keys, and enforcing a reliable string-array contract for capabilities from input to API payload. This ensures the agents page behaves consistently across locales and prevents malformed capability data from being submitted.

## Motivation
The current agent UI has multiple hardcoded labels/messages and partially translated dialogs, which breaks i18n quality. Capabilities handling is currently string-joined in hidden input flow, which is fragile and can drift from the API expectation of `string[]`.

## Design
Implementation approach: synchronous UI/form refactor in Vue components using existing `vee-validate` and `zod` patterns; no backend changes.

Exact types/functions/integration points to modify:
1. `apps/web/components/CreateAgentDialog.vue`
- Convert capabilities form model from comma string intermediary to explicit `string[]` form value.
- Normalize tag input via deterministic parser:
```ts
function normalizeCapabilities(input: string[]): string[]
```
Behavior: trim whitespace, drop empty values, deduplicate case-insensitively, preserve first-seen casing.
- Ensure submit payload to `POST /agents` contains `capabilities: string[]`.

2. `apps/web/components/EditAgentCapabilitiesDialog.vue`
- Reuse the same normalization behavior before patch call.
- Ensure update payload to `PATCH /agents/:slug/update-capabilities` contains `capabilities: string[]`.

3. `apps/web/components/RotateKeyDialog.vue` and related agent dialogs
- Replace hardcoded strings with `t('...')` keys.

4. Locale files
- `apps/web/i18n/locales/en.json`
- `apps/web/i18n/locales/zh.json`
- Add missing keys under `agents.*` and `common.*` for dialog titles, confirmation copy, rotating state, reveal message, and done action.

Existing pattern to follow:
- Use the same i18n + toast style already used in `apps/web/pages/agents.vue` and `apps/web/components/EditAgentRolesDialog.vue`.

Failure handling:
- Fail-closed on invalid capabilities (do not submit when normalized array contains invalid entries after schema validation).
- Fail-open in local development for missing translation keys (render key string so UI remains usable).
- Release acceptance for this spec is fail-closed on translation coverage: all newly introduced agent/common keys must exist in both `en.json` and `zh.json`.
- API call errors continue using `extractApiError()` or existing toast error key patterns.

## Stories
1. **US-001: Agent i18n key coverage and hardcoded text removal** — no dependencies
### Context Files (optional)
- `apps/web/components/RotateKeyDialog.vue`
- `apps/web/components/CreateAgentDialog.vue`
- `apps/web/components/DeleteAgentDialog.vue`
- `apps/web/i18n/locales/en.json`
- `apps/web/i18n/locales/zh.json`

2. **US-002: Capabilities input/output contract as string array** — depends on US-001
### Context Files (optional)
- `apps/web/components/CreateAgentDialog.vue`
- `apps/web/components/EditAgentCapabilitiesDialog.vue`

3. **US-003: Capabilities tag UX normalization and validation** — depends on US-002
### Context Files (optional)
- `apps/web/components/CreateAgentDialog.vue`
- `apps/web/components/EditAgentCapabilitiesDialog.vue`

## Acceptance Criteria
### US-001
- When `RotateKeyDialog.vue` renders, then dialog title is read from `t('agents.rotateKey.*')` instead of a hardcoded literal.
- When `RotateKeyDialog.vue` renders, then confirmation copy is read from `t('agents.rotateKey.*')` instead of a hardcoded literal.
- When `RotateKeyDialog.vue` renders, then action button labels are read from i18n keys instead of hardcoded literals.
- Given `apps/web/i18n/locales/en.json`, when agent-dialog keys are added, then matching keys exist in `apps/web/i18n/locales/zh.json`.
- When create-agent key reveal is shown, then warning text is rendered via an i18n key.
- When create-agent key reveal is shown, then copy button text is rendered via an i18n key.
- When create-agent key reveal is shown, then done button text is rendered via an i18n key.
- When delete-agent dialog is shown, then dialog title is rendered via an i18n key.
- When delete-agent dialog is shown, then confirmation body is rendered via an i18n key.

### US-002
- When create-agent submit runs in `CreateAgentDialog.vue`, then request body field `capabilities` is emitted as `string[]`.
- When edit-capabilities submit runs in `EditAgentCapabilitiesDialog.vue`, then request body field `capabilities` is emitted as `string[]`.
- Given empty capabilities input, when submit occurs, then payload sends `capabilities: []`.
- Given preloaded agent capabilities, when edit dialog opens, then tags are initialized as array values without comma-splitting ambiguity.

### US-003
- Given tag input containing duplicates with case differences, when `normalizeCapabilities` runs, then output keeps one entry for that capability.
- Given tag input with leading/trailing spaces, when `normalizeCapabilities` runs, then output values are trimmed.
- Given user presses Enter on a blank capability input, when handler runs, then no tag is appended.
- Given user removes a capability tag, when form submits, then removed capability is absent from API payload.
