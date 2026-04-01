# SPEC: Web Labels Color Picker and Color Validation

## Summary
Upgrade label color input from plain text to a dedicated color-picker experience with validated hex support, while preserving existing create/delete flows and table rendering. This improves usability and prevents invalid color values from reaching the API.

## Motivation
Current label creation relies on free-text color input, which is error-prone and does not guide users toward valid values. Invalid color strings can create inconsistent label visuals and unreliable rendering behavior.

## Design
Implementation approach: synchronous Vue form enhancement in `apps/web/pages/[project]/labels.vue`, using existing `vee-validate` + `zod` form stack.

Exact types/functions/integration points to modify:
1. `apps/web/pages/[project]/labels.vue`
- Replace current color text-only control with a color-picker UX.
- Introduce dual representation:
```ts
interface LabelColorFormState {
  colorHex: string
}
```
- Support both interactions:
1. native picker selection updates `colorHex`
2. manual hex typing (optional companion input) updates `colorHex`
- Normalize and validate via:
```ts
function normalizeHexColor(value: string): string
```
Behavior: uppercase hex, ensure leading `#`, expand 3-digit hex to 6-digit.

2. Validation schema
- Enforce accepted color format as `^#[0-9A-F]{6}$` after normalization.
- Keep default color fallback `#6366F1` when user provides no value.

3. Rendering integration
- Label table swatch continues to bind inline style from saved `label.color`.
- Add safe display fallback for invalid persisted color values (render neutral swatch color).

Existing pattern to follow:
- Keep existing `useAsyncData` + `refresh()` + toast behavior in current labels page.

Failure handling:
- Fail-closed for invalid color in submit flow: show validation error and block POST.
- Fail-open for existing invalid DB colors in list view: render neutral fallback swatch instead of crashing.

## Stories
1. **US-001: Add color picker input UX for label creation** — no dependencies
### Context Files (optional)
- `apps/web/pages/[project]/labels.vue`

2. **US-002: Hex normalization and validation in label form** — depends on US-001
### Context Files (optional)
- `apps/web/pages/[project]/labels.vue`
- `apps/web/i18n/locales/en.json`
- `apps/web/i18n/locales/zh.json`

3. **US-003: Safe color rendering and create flow integration** — depends on US-002
### Context Files (optional)
- `apps/web/pages/[project]/labels.vue`

## Acceptance Criteria
### US-001
- When the label create form renders, then color input includes a native color picker control.
- When user selects a color from picker, then form state `colorHex` is updated to a hex value.
- When user changes `colorHex`, then the create-form color swatch preview element updates its `background-color` style to match `colorHex`.
- When user submits without editing color, then default form value is `#6366F1`.

### US-002
- Given user enters `6366f1`, when `normalizeHexColor` runs, then output is `#6366F1`.
- Given user enters `#abc`, when `normalizeHexColor` runs, then output is `#AABBCC`.
- Given normalized value does not match `^#[0-9A-F]{6}$`, when submit is attempted, then form shows validation error and blocks request.
- Given valid color input, when submit occurs, then `POST /projects/:slug/labels` receives normalized `color`.

### US-003
- Given label row contains valid color value, when table renders, then swatch background uses that color.
- Given label row contains invalid persisted color value, when table renders, then swatch uses neutral fallback color.
- When create label succeeds, then form resets to initial values.
- When create label succeeds, then `refresh()` is invoked.
- When delete label succeeds, then `refresh()` is invoked.
- When delete label succeeds, then a localized success toast is shown.
