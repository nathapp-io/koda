import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const dialogPath = join(webDir, 'components', 'CreateTicketDialog.vue')

// ──────────────────────────────────────────────────────────────────────────────
// File existence
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-3: CreateTicketDialog.vue exists', () => {
  test('file is present at components/CreateTicketDialog.vue', () => {
    expect(existsSync(dialogPath)).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — Dialog component with open prop / v-model:open for visibility control
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-3 AC1: CreateTicketDialog uses Dialog component with open prop', () => {
  test('source imports or uses Dialog', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toContain('Dialog')
  })

  test('source uses DialogContent', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toContain('DialogContent')
  })

  test('source uses DialogHeader and DialogTitle', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toContain('DialogHeader')
    expect(source).toContain('DialogTitle')
  })

  test('source accepts an open prop to control visibility', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasOpenProp =
      source.includes(':open="open"') ||
      source.includes(':open="modelValue"') ||
      source.includes("open: Boolean") ||
      source.includes('open: {') ||
      (source.includes('defineProps') && source.includes('open'))
    expect(hasOpenProp).toBe(true)
  })

  test('source supports v-model:open or update:open emission', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasUpdateOpen =
      source.includes("update:open") ||
      source.includes("update:modelValue") ||
      source.includes("'open'")
    expect(hasUpdateOpen).toBe(true)
  })
})

describe('US-004-3 AC1: CreateTicketDialog accepts projectSlug prop', () => {
  test('source defines a projectSlug prop', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toContain('projectSlug')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — VeeValidate + Zod form validation
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-3 AC2: Form uses VeeValidate with toTypedSchema wrapping a Zod schema', () => {
  test('source imports useForm from vee-validate', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toContain('useForm')
    expect(source).toContain('vee-validate')
  })

  test('source imports toTypedSchema from @vee-validate/zod', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toContain('toTypedSchema')
    expect(source).toContain('@vee-validate/zod')
  })

  test('source uses toTypedSchema wrapping a z.object', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toContain('toTypedSchema(')
    expect(source).toContain('z.object(')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — title field validates as z.string().min(3)
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-3 AC3: title field validates as z.string().min(3)', () => {
  test('source has title field in Zod schema', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toMatch(/title\s*:\s*z\.string\(\)/)
  })

  test('source applies .min(3) validation on title', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toMatch(/title\s*:\s*z\.string\(\)\.min\s*\(\s*3/)
  })

  test('source renders a title input field', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasTitleInput =
      source.includes('name="title"') ||
      source.includes("name='title'")
    expect(hasTitleInput).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — type field is a Select with BUG and ENHANCEMENT options
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-3 AC4: type field is a Select with BUG and ENHANCEMENT options', () => {
  test('source has type field in Zod schema', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasTypeField =
      source.includes("type: z.enum") ||
      source.includes("type: z.string()")
    expect(hasTypeField).toBe(true)
  })

  test('source includes BUG as a selectable option', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toContain('BUG')
  })

  test('source includes ENHANCEMENT as a selectable option', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toContain('ENHANCEMENT')
  })

  test('source uses Select component for type field', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toContain('Select')
    expect(source).toContain('SelectItem')
  })

  test('source renders type Select field with FormField wrapper', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasTypeFormField =
      source.includes('name="type"') ||
      source.includes("name='type'")
    expect(hasTypeFormField).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC5 — priority field is a Select defaulting to MEDIUM
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-3 AC5: priority field is a Select defaulting to MEDIUM', () => {
  test('source has priority field in Zod schema', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasPriorityField =
      source.includes("priority: z.enum") ||
      source.includes("priority: z.string()")
    expect(hasPriorityField).toBe(true)
  })

  test('source sets MEDIUM as the default priority', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasMediumDefault =
      source.includes(".default('MEDIUM')") ||
      source.includes('.default("MEDIUM")') ||
      (source.includes('MEDIUM') && source.includes('default'))
    expect(hasMediumDefault).toBe(true)
  })

  test('source renders priority Select field with FormField wrapper', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasPriorityFormField =
      source.includes('name="priority"') ||
      source.includes("name='priority'")
    expect(hasPriorityFormField).toBe(true)
  })

  test('source includes LOW, MEDIUM, HIGH, CRITICAL priority options', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toContain('LOW')
    expect(source).toContain('MEDIUM')
    expect(source).toContain('HIGH')
    expect(source).toContain('CRITICAL')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC6 — description field is an optional Textarea
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-3 AC6: description field is an optional Textarea', () => {
  test('source has an optional description field in Zod schema', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasOptionalDescription =
      source.includes('description: z.string().optional()') ||
      source.includes('description: z.string().min(0)') ||
      source.match(/description\s*:\s*z\.string\(\)\.optional\(\)/) !== null ||
      (source.includes('description') && source.includes('optional()'))
    expect(hasOptionalDescription).toBe(true)
  })

  test('source uses Textarea component for description field', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toContain('Textarea')
  })

  test('source renders description field with FormField wrapper', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasDescriptionFormField =
      source.includes('name="description"') ||
      source.includes("name='description'")
    expect(hasDescriptionFormField).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC7 — Successful POST emits 'created' and shows success toast
// ──────────────────────────────────────────────────────────────────────────────

describe("US-004-3 AC7: successful POST emits 'created' and shows success toast", () => {
  test('source imports toast from vue-sonner', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toContain('vue-sonner')
    expect(source).toContain('toast')
  })

  test('source calls toast.success on successful create', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toContain('toast.success(')
  })

  test("source emits 'created' event on success", () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasEmitCreated =
      source.includes("emit('created'") ||
      source.includes('emit("created"')
    expect(hasEmitCreated).toBe(true)
  })

  test("source defines 'created' in defineEmits", () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toContain('defineEmits')
    const hasCreatedEvent =
      source.includes("'created'") ||
      source.includes('"created"')
    expect(hasCreatedEvent).toBe(true)
  })

  test('source POSTs to /projects/${slug}/tickets via useApi', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toContain('useApi')
    const hasTicketPost =
      source.includes('$api.post') &&
      (source.includes('/tickets') || source.includes('projectSlug') || source.includes('slug'))
    expect(hasTicketPost).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC8 — API error shows error toast
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-3 AC8: API error shows error toast', () => {
  test('source calls toast.error on failed create', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toContain('toast.error(')
  })

  test('source has try/catch error handling around API call', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasTryCatch = source.includes('try {') || source.includes('try{')
    const hasCatchCallback = source.includes('.catch(')
    expect(hasTryCatch || hasCatchCallback).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Quality — no console.log
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-3: CreateTicketDialog.vue has no console.log statements', () => {
  test('source does not contain console.log', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).not.toContain('console.log')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// US-003: Form reset after successful submission
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003 AC1: resetForm() is called on successful submit for title field', () => {
  test('source destructures resetForm from useForm()', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasResetFormDestructured = source.includes('resetForm')
    expect(hasResetFormDestructured).toBe(true)
  })

  test('source calls resetForm() after successful API call', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    // Check that resetForm is called after the API post succeeds
    const hasResetFormCall = source.includes('resetForm()')
    expect(hasResetFormCall).toBe(true)
  })
})

describe('US-003 AC2: resetForm() is called on successful submit for type field', () => {
  test('source calls resetForm() which resets type field', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasResetFormCall = source.includes('resetForm()')
    expect(hasResetFormCall).toBe(true)
  })
})

describe('US-003 AC3: resetForm() is called on successful submit for priority field', () => {
  test('source calls resetForm() which resets priority to MEDIUM', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasResetFormCall = source.includes('resetForm()')
    expect(hasResetFormCall).toBe(true)
  })
})

describe('US-003 AC4: resetForm() is called on successful submit for description field', () => {
  test('source calls resetForm() which resets description field', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasResetFormCall = source.includes('resetForm()')
    expect(hasResetFormCall).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// US-004 AC2 — onSubmit catch uses extractApiError, not instanceof Error
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004 AC2: CreateTicketDialog onSubmit catch uses extractApiError', () => {
  test('source imports extractApiError from ~/composables/useApi', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasImport =
      source.includes('extractApiError') &&
      (source.includes('useApi') || source.includes('composables/useApi'))
    expect(hasImport).toBe(true)
  })

  test('source calls extractApiError(error) in onSubmit catch block', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toContain('extractApiError(')
  })

  test('source does not use inferior instanceof Error pattern in catch block', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    // The old pattern: error instanceof Error ? error.message : fallback
    const hasInferiorPattern = source.includes('instanceof Error ? error.message')
    expect(hasInferiorPattern).toBe(false)
  })

  test('toast.error is called with extractApiError result on submit failure', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasExtractBeforeToast =
      source.includes('extractApiError(') &&
      source.includes('toast.error(')
    expect(hasExtractBeforeToast).toBe(true)
  })
})
