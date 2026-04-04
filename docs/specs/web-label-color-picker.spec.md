# SPEC: Web Labels Color Picker and Color Validation

## Summary
Upgrade label color input from plain text to a dedicated color-picker experience with validated hex support, while preserving existing create/delete flows and table rendering. This improves usability and prevents invalid color values from reaching the API.

## Motivation
Current label creation relies on free-text color input, which is error-prone and does not guide users toward valid values. Invalid color strings can create inconsistent label visuals and unreliable rendering behavior.

## Design
Implementation approach: extract color-picker UX into a **shared, reusable Vue component** (`apps/web/components/ColorPicker.vue`), then integrate it into the labels page form using the existing `vee-validate` + `zod` stack.

### New file: `apps/web/components/ColorPicker.vue`

Shared component contract:

```ts
// Props
interface ColorPickerProps {
  modelValue: string       // current hex color — v-model compatible
  defaultColor?: string    // fallback when modelValue is empty (default: '#6366F1')
}

// Emits
interface ColorPickerEmits {
  'update:modelValue': [value: string]  // emits normalized hex on every change
}
```

Internal behavior:
- Renders a native `<input type="color">` control bound to `modelValue`
- Renders a companion hex text input displaying `modelValue`
- Renders a color swatch preview (`div` with inline `background-color`)
- On native picker change: normalizes and emits updated hex
- On text input change: normalizes and emits updated hex
- Normalization via:
```ts
function normalizeHexColor(value: string): string
```
Behavior: uppercase hex, ensure leading `#`, expand 3-digit hex to 6-digit.

### Modified file: `apps/web/pages/[project]/labels.vue`
- Replace current color text-only `<Input>` with `<ColorPicker>` component.
- Introduce form field:
```ts
interface LabelColorFormState {
  colorHex: string
}
```

### Validation schema (labels form)
- Enforce accepted color format as `^#[0-9A-F]{6}$` after normalization.
- Keep default color fallback `#6366F1` when user provides no value.

### Rendering integration (labels table)
- Label table swatch continues to bind inline style from saved `label.color`.
- Add safe display fallback for invalid persisted color values (render neutral swatch color).

Existing pattern to follow:
- Keep existing `useAsyncData` + `refresh()` + toast behavior in current labels page.

Failure handling:
- Fail-closed for invalid color in submit flow: show validation error and block POST.
- Fail-open for existing invalid DB colors in list view: render neutral fallback swatch instead of crashing.

## Stories
1. **US-001: Create shared ColorPicker component** — no dependencies
### Context Files (optional)
- `apps/web/components/ColorPicker.vue` *(new file)*

2. **US-002: Add color picker input UX for label creation** — depends on US-001
### Context Files (optional)
- `apps/web/pages/[project]/labels.vue`
- `apps/web/components/ColorPicker.vue`

3. **US-003: Hex normalization and validation in label form** — depends on US-002
### Context Files (optional)
- `apps/web/pages/[project]/labels.vue`
- `apps/web/i18n/locales/en.json`
- `apps/web/i18n/locales/zh.json`

4. **US-004: Safe color rendering and create flow integration** — depends on US-003
### Context Files (optional)
- `apps/web/pages/[project]/labels.vue`

## Acceptance Criteria
### US-001
- When `ColorPicker` is rendered with a `modelValue`, then it shows a native color picker input, a hex text input, and a color swatch preview.
- When user selects a color from the native picker, then component emits `update:modelValue` with a normalized uppercase hex value.
- When user types in the hex text input, then component emits `update:modelValue` with the normalized value.
- When `modelValue` changes, then the swatch preview `background-color` updates to match.
- When `modelValue` is empty and `defaultColor` is not provided, then component uses `#6366F1` as fallback.
- When `modelValue` is empty and `defaultColor` is provided, then component uses `defaultColor` as fallback.

### US-002
- When the label create form renders, then the color `FormField` uses the `ColorPicker` component instead of a plain text input.
- When user selects a color from the `ColorPicker`, then form state `colorHex` is updated to the emitted normalized hex value.
- When user submits without editing color, then default form value is `#6366F1`.

### US-003
- Given user enters `6366f1`, when `normalizeHexColor` runs, then output is `#6366F1`.
- Given user enters `#abc`, when `normalizeHexColor` runs, then output is `#AABBCC`.
- Given normalized value does not match `^#[0-9A-F]{6}$`, when submit is attempted, then form shows validation error and blocks request.
- Given valid color input, when submit occurs, then `POST /projects/:slug/labels` receives normalized `color`.

### US-004
- Given label row contains valid color value, when table renders, then swatch background uses that color.
- Given label row contains invalid persisted color value, when table renders, then swatch uses neutral fallback color.
- When create label succeeds, then form resets to initial values.
- When create label succeeds, then `refresh()` is invoked.
- When delete label succeeds, then `refresh()` is invoked.
- When delete label succeeds, then a localized success toast is shown.
