import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const dialogPath = join(webDir, 'components', 'CreateProjectDialog.vue')

// ──────────────────────────────────────────────────────────────────────────────
// File existence
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003: CreateProjectDialog.vue exists', () => {
  test('file is present at components/CreateProjectDialog.vue', () => {
    expect(existsSync(dialogPath)).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC5 — CreateProjectDialog has name, slug, key fields with VeeValidate+Zod
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003 AC5: CreateProjectDialog uses Dialog component', () => {
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
})

describe('US-003 AC5: VeeValidate + Zod form validation', () => {
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

  test('source has name field in schema', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toMatch(/name\s*:\s*z\.string\(\)/)
  })

  test('source has slug field in schema', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toMatch(/slug\s*:\s*z\.string\(\)/)
  })

  test('source has key field in schema', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toContain('key: z')
    expect(source).toContain('.string()')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC6 — Slug auto-derives from name input
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003 AC6: slug auto-derives from name', () => {
  test('source watches name field to auto-derive slug', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    // Must have a watch on name that sets slug
    const hasWatch = source.includes('watch(') || source.includes('watchEffect(')
    expect(hasWatch).toBe(true)
  })

  test('source applies toLowerCase to derive slug', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toContain('toLowerCase()')
  })

  test('source replaces spaces with hyphens for slug', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    // /\s+/g, '-' or similar pattern
    const hasSpaceReplace =
      source.includes("replace(/ /g, '-')") ||
      source.includes("replace(/\\s+/g, '-')") ||
      source.includes("replace(/[ ]+/g, '-')") ||
      source.includes('/\\s+/g') ||
      (source.includes('replace') && source.includes("'-'"))
    expect(hasSpaceReplace).toBe(true)
  })

  test('source strips non-alphanumeric characters for slug', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    // regex to strip non-alphanumeric/hyphen chars
    const hasStripNonAlpha =
      source.includes('/[^a-z0-9-]/g') ||
      source.includes('/[^a-zA-Z0-9-]/g') ||
      source.includes('[^a-z0-9') ||
      source.includes('[^\\w')
    expect(hasStripNonAlpha).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC7 — Key field auto-uppercases and validates /^[A-Z]+$/, min 2 max 6 chars
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003 AC7: key field auto-uppercases', () => {
  test('source calls toUpperCase() for key field', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toContain('toUpperCase()')
  })
})

describe('US-003 AC7: key field validates /^[A-Z]+$/ with min 2 max 6 chars', () => {
  test('source validates key with regex /^[A-Z]+$/', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    // z.string().regex(/^[A-Z]+$/) or similar
    const hasRegexValidation =
      source.includes('^[A-Z]+$') ||
      source.includes('/^[A-Z]') ||
      source.includes("regex(/^[A-Z]")
    expect(hasRegexValidation).toBe(true)
  })

  test('source validates key min length of 2', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toMatch(/\.min\s*\(\s*2/)
  })

  test('source validates key max length of 6', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toMatch(/\.max\s*\(\s*6/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC8 — Successful create: toast.success, emits 'created'
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003 AC8: successful create emits created and shows toast.success', () => {
  test('source imports toast from vue-sonner', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toContain('vue-sonner')
    expect(source).toContain('toast')
  })

  test('source calls toast.success on successful create', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toContain('toast.success(')
  })

  test("source emits 'created' event", () => {
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
})

// ──────────────────────────────────────────────────────────────────────────────
// AC9 — Failed create: toast.error with message
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003 AC9: failed create shows toast.error', () => {
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
// API integration — uses useApi for POST /projects
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003: CreateProjectDialog calls POST /projects via useApi', () => {
  test('source imports or calls useApi', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toContain('useApi')
  })

  test('source calls $api.post to create project', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).toMatch(/\$api\.post\s*\(\s*['"]\/projects['"]/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Quality — no console.log
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003: CreateProjectDialog.vue has no console.log statements', () => {
  test('source does not contain console.log', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    expect(source).not.toContain('console.log')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// US-003: Form reset after successful submission
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003 AC5: resetForm() is called on successful submit for name field', () => {
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

describe('US-003 AC6: resetForm() is called on successful submit for slug field', () => {
  test('source calls resetForm() which resets slug field', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasResetFormCall = source.includes('resetForm()')
    expect(hasResetFormCall).toBe(true)
  })
})

describe('US-003 AC7: resetForm() is called on successful submit for key field', () => {
  test('source calls resetForm() which resets key field', () => {
    const source = readFileSync(dialogPath, 'utf-8')
    const hasResetFormCall = source.includes('resetForm()')
    expect(hasResetFormCall).toBe(true)
  })
})
