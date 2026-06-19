import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const componentPath = join(webDir, 'components', 'KbAddDocumentDialog.vue')

function getSource(): string {
  return readFileSync(componentPath, 'utf-8')
}

describe('KbAddDocumentDialog.vue exists', () => {
  test('file is present at components/KbAddDocumentDialog.vue', () => {
    expect(existsSync(componentPath)).toBe(true)
  })
})

describe('KbAddDocumentDialog: required props', () => {
  test('source defines projectSlug prop', () => {
    const source = getSource()
    expect(source).toContain('projectSlug')
    expect(source).toMatch(/defineProps/)
  })

  test('projectSlug prop is typed as string', () => {
    const source = getSource()
    expect(source).toMatch(/projectSlug\s*:\s*string/)
  })
})

describe('KbAddDocumentDialog: emits', () => {
  test("source defines 'added' emit", () => {
    const source = getSource()
    expect(source).toContain('defineEmits')
    expect(source).toContain("'added'")
  })

  test("source emits 'added' after successful submission", () => {
    const source = getSource()
    const hasEmitAdded =
      source.includes("emit('added')") ||
      source.includes('emit("added")')
    expect(hasEmitAdded).toBe(true)
  })
})

describe('KbAddDocumentDialog: uses composables', () => {
  test('source calls useApi()', () => {
    const source = getSource()
    expect(source).toContain('useApi()')
  })

  test('source calls useI18n()', () => {
    const source = getSource()
    expect(source).toContain('useI18n()')
  })

  test('source calls useAppToast()', () => {
    const source = getSource()
    expect(source).toContain('useAppToast()')
  })
})

describe('KbAddDocumentDialog: form state', () => {
  test('source has a reactive form object with sourceId, source, and content', () => {
    const source = getSource()
    expect(source).toContain('reactive(')
    expect(source).toContain('sourceId')
    expect(source).toContain('content')
  })

  test('source defaults source field to "manual"', () => {
    const source = getSource()
    expect(source).toContain("'manual'")
  })

  test('source has a reset function that clears the form', () => {
    const source = getSource()
    expect(source).toContain('function reset()')
    expect(source).toContain("form.sourceId = ''")
    expect(source).toContain("form.content = ''")
  })
})

describe('KbAddDocumentDialog: validation', () => {
  test('source validates that sourceId is not empty before submit', () => {
    const source = getSource()
    expect(source).toContain('sourceId')
    expect(source).toContain('.trim()')
  })

  test('source validates that content is not empty before submit', () => {
    const source = getSource()
    expect(source).toContain('content')
    expect(source).toContain('.trim()')
  })

  test('source shows a validation error toast when fields are empty', () => {
    const source = getSource()
    expect(source).toContain('toast.error(')
    expect(source).toContain('kb.validation.sourceIdRequired')
  })
})

describe('KbAddDocumentDialog: API call', () => {
  test('source posts to /projects/:projectSlug/kb/documents', () => {
    const source = getSource()
    expect(source).toMatch(/\$api\.post\s*\(/)
    expect(source).toContain('/kb/documents')
    expect(source).toContain('projectSlug')
  })

  test('source posts sourceId, source, and content in the request body', () => {
    const source = getSource()
    expect(source).toContain('sourceId: form.sourceId')
    expect(source).toContain('source: form.source')
    expect(source).toContain('content: form.content')
  })
})

describe('KbAddDocumentDialog: success handling', () => {
  test('source shows success toast after document is added', () => {
    const source = getSource()
    expect(source).toContain('toast.success(')
    expect(source).toContain('kb.toast.docAdded')
  })

  test('source closes the dialog on success', () => {
    const source = getSource()
    expect(source).toContain('open.value = false')
  })

  test('source resets form on success', () => {
    const source = getSource()
    expect(source).toContain('reset()')
  })
})

describe('KbAddDocumentDialog: error handling', () => {
  test('source wraps API call in try-catch', () => {
    const source = getSource()
    expect(source).toContain('try {')
    expect(source).toContain('catch')
  })

  test('source shows error toast on API failure', () => {
    const source = getSource()
    expect(source).toContain('kb.toast.addFailed')
  })
})

describe('KbAddDocumentDialog: loading state', () => {
  test('source tracks loading state with a ref', () => {
    const source = getSource()
    expect(source).toContain('loading')
    expect(source).toContain('ref(false)')
  })

  test('source uses finally block to reset loading', () => {
    const source = getSource()
    expect(source).toContain('finally {')
    expect(source).toContain('loading.value = false')
  })
})

describe('KbAddDocumentDialog: dialog structure', () => {
  test('source uses Dialog component', () => {
    const source = getSource()
    expect(source).toContain('Dialog')
    expect(source).toContain('DialogContent')
    expect(source).toContain('DialogHeader')
    expect(source).toContain('DialogTitle')
  })

  test('source uses DialogTrigger with an add button', () => {
    const source = getSource()
    expect(source).toContain('DialogTrigger')
    expect(source).toContain('kb.documents.addButton')
  })

  test('source has source type selector with manual, doc, and ticket options', () => {
    const source = getSource()
    expect(source).toContain("'manual'")
    expect(source).toContain("'doc'")
    expect(source).toContain("'ticket'")
  })
})

describe('KbAddDocumentDialog: no console.log', () => {
  test('source does not contain console.log', () => {
    const source = getSource()
    expect(source).not.toContain('console.log')
  })
})
