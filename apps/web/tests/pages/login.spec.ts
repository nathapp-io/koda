import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const loginPath = join(webDir, 'pages', 'login.vue')

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — pages/login.vue uses VeeValidate with toTypedSchema wrapping a Zod schema
// ──────────────────────────────────────────────────────────────────────────────

describe('AC2: pages/login.vue exists', () => {
  test('file is present at pages/login.vue', () => {
    expect(existsSync(loginPath)).toBe(true)
  })
})

describe('AC2: pages/login.vue uses VeeValidate', () => {
  test('source imports useForm from vee-validate', () => {
    const source = readFileSync(loginPath, 'utf-8')
    expect(source).toContain('useForm')
    expect(source).toContain('vee-validate')
  })

  test('source imports toTypedSchema from @vee-validate/zod', () => {
    const source = readFileSync(loginPath, 'utf-8')
    expect(source).toContain('toTypedSchema')
    expect(source).toContain('@vee-validate/zod')
  })

  test('source uses toTypedSchema() wrapping a zod object', () => {
    const source = readFileSync(loginPath, 'utf-8')
    expect(source).toContain('toTypedSchema(')
    expect(source).toContain('z.object(')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — Email field validated as z.string().email()
// ──────────────────────────────────────────────────────────────────────────────

describe('AC3: email field validated as z.string().email()', () => {
  test('source uses z.string().email() for the email field', () => {
    const source = readFileSync(loginPath, 'utf-8')
    expect(source).toContain('z.string().email()')
  })

  test('source references an email field in the zod schema', () => {
    const source = readFileSync(loginPath, 'utf-8')
    expect(source).toMatch(/email\s*:\s*z\.string\(\)\.email\(\)/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — Password field validated as z.string().min(8)
// ──────────────────────────────────────────────────────────────────────────────

describe('AC4: password field validated as z.string().min(8)', () => {
  test('source uses z.string().min(8) for the password field', () => {
    const source = readFileSync(loginPath, 'utf-8')
    expect(source).toContain('z.string().min(8)')
  })

  test('source references a password field in the zod schema', () => {
    const source = readFileSync(loginPath, 'utf-8')
    expect(source).toMatch(/password\s*:\s*z\.string\(\)\.min\(8\)/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC5 — definePageMeta({ layout: 'auth' }) present
// ──────────────────────────────────────────────────────────────────────────────

describe("AC5: definePageMeta({ layout: 'auth' }) present", () => {
  test('source calls definePageMeta', () => {
    const source = readFileSync(loginPath, 'utf-8')
    expect(source).toContain('definePageMeta(')
  })

  test("source sets layout: 'auth' in definePageMeta", () => {
    const source = readFileSync(loginPath, 'utf-8')
    expect(source).toMatch(/definePageMeta\s*\(\s*\{[^}]*layout\s*:\s*['"]auth['"]/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC6 — toast.success shown on successful login
// ──────────────────────────────────────────────────────────────────────────────

describe('AC6: toast.success shown on successful login', () => {
  test('source imports toast from vue-sonner', () => {
    const source = readFileSync(loginPath, 'utf-8')
    expect(source).toContain('vue-sonner')
    expect(source).toContain('toast')
  })

  test('source calls toast.success on login success', () => {
    const source = readFileSync(loginPath, 'utf-8')
    expect(source).toContain('toast.success(')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC7 — toast.error shown on API failure
// ──────────────────────────────────────────────────────────────────────────────

describe('AC7: toast.error shown on API failure', () => {
  test('source calls toast.error on login failure', () => {
    const source = readFileSync(loginPath, 'utf-8')
    expect(source).toContain('toast.error(')
  })

  test('source has try/catch or error handling around login call', () => {
    const source = readFileSync(loginPath, 'utf-8')
    const hasTryCatch = source.includes('try {') || source.includes('try{')
    const hasCatchCallback = source.includes('.catch(')
    expect(hasTryCatch || hasCatchCallback).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC8 — No console.log statements
// ──────────────────────────────────────────────────────────────────────────────

describe('AC8: no console.log statements in pages/login.vue', () => {
  test('source does not contain console.log', () => {
    const source = readFileSync(loginPath, 'utf-8')
    expect(source).not.toContain('console.log')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Integration: useAuth().login() is called on submit
// ──────────────────────────────────────────────────────────────────────────────

describe('Integration: useAuth composable called on form submit', () => {
  test('source imports or calls useAuth', () => {
    const source = readFileSync(loginPath, 'utf-8')
    expect(source).toContain('useAuth')
  })

  test('source calls login() method from useAuth', () => {
    const source = readFileSync(loginPath, 'utf-8')
    expect(source).toContain('.login(')
  })

  test('source uses handleSubmit from vee-validate to wrap form submission', () => {
    const source = readFileSync(loginPath, 'utf-8')
    expect(source).toContain('handleSubmit')
  })
})
