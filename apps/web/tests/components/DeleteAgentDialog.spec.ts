import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const componentPath = join(webDir, 'components', 'DeleteAgentDialog.vue')

function getSource(): string {
  return readFileSync(componentPath, 'utf-8')
}

describe('DeleteAgentDialog.vue exists', () => {
  test('file is present at components/DeleteAgentDialog.vue', () => {
    expect(existsSync(componentPath)).toBe(true)
  })
})

describe('DeleteAgentDialog: required props', () => {
  test('source defines an open prop', () => {
    const source = getSource()
    expect(source).toContain('open')
    expect(source).toMatch(/defineProps/)
  })

  test('open prop is typed as boolean', () => {
    const source = getSource()
    expect(source).toMatch(/open\s*:\s*boolean/)
  })

  test('source defines an agent prop', () => {
    const source = getSource()
    const hasAgentProp =
      source.match(/props.*agent/) ||
      source.match(/defineProps.*agent/) ||
      source.includes(':agent=')
    expect(hasAgentProp).not.toBeNull()
  })

  test('agent prop has id, name, slug, roles, capabilities, and status fields', () => {
    const source = getSource()
    expect(source).toContain('id')
    expect(source).toContain('name')
    expect(source).toContain('slug')
    expect(source).toContain('roles')
    expect(source).toContain('capabilities')
    expect(source).toContain('status')
  })
})

describe('DeleteAgentDialog: emits', () => {
  test("source defines update:open emit", () => {
    const source = getSource()
    expect(source).toContain('defineEmits')
    expect(source).toContain('update:open')
  })

  test("source defines deleted emit", () => {
    const source = getSource()
    expect(source).toContain("'deleted'")
  })
})

describe('DeleteAgentDialog: displays agent name in confirm message', () => {
  test('source references agent.name in the confirm message', () => {
    const source = getSource()
    expect(source).toContain('agent.name')
  })

  test('source uses i18n key for the confirm message', () => {
    const source = getSource()
    expect(source).toContain('agents.deleteAgent.confirm')
  })
})

describe('DeleteAgentDialog: API deletion', () => {
  test('source uses $api.delete for deletion', () => {
    const source = getSource()
    expect(source).toMatch(/\$api\.delete\s*\(/)
  })

  test('source constructs delete URL with agent.slug', () => {
    const source = getSource()
    expect(source).toContain('agent.slug')
    expect(source).toContain('/agents/')
  })

  test('source wraps deletion in try-catch', () => {
    const source = getSource()
    expect(source).toContain('try {')
    expect(source).toContain('catch')
  })
})

describe('DeleteAgentDialog: success handling', () => {
  test('source shows success toast after deletion', () => {
    const source = getSource()
    expect(source).toMatch(/toast\.success/)
    expect(source).toContain('agents.toast.deleted')
  })

  test("source emits 'deleted' on success", () => {
    const source = getSource()
    const emitsDeleted =
      source.includes("emit('deleted')") ||
      source.includes('emit("deleted")')
    expect(emitsDeleted).toBe(true)
  })

  test("source closes dialog via update:open emit on success", () => {
    const source = getSource()
    const closesDialog =
      source.includes("emit('update:open'") ||
      source.includes('emit("update:open"')
    expect(closesDialog).toBe(true)
  })
})

describe('DeleteAgentDialog: error handling', () => {
  test('source shows error toast on deletion failure', () => {
    const source = getSource()
    expect(source).toMatch(/toast\.error/)
    expect(source).toContain('agents.toast.deleteFailed')
  })
})

describe('DeleteAgentDialog: submitting state', () => {
  test('source tracks isSubmitting state', () => {
    const source = getSource()
    expect(source).toContain('isSubmitting')
  })

  test('delete button is disabled when isSubmitting is true', () => {
    const source = getSource()
    expect(source).toMatch(/:disabled=["']isSubmitting["']/)
  })

  test('source uses finally block to reset isSubmitting', () => {
    const source = getSource()
    expect(source).toContain('finally {')
    expect(source).toContain('isSubmitting.value = false')
  })
})

describe('DeleteAgentDialog: dialog structure', () => {
  test('source uses Dialog component with open prop binding', () => {
    const source = getSource()
    expect(source).toContain('Dialog')
    expect(source).toContain(':open=')
  })

  test('source has a cancel button', () => {
    const source = getSource()
    const hasCancelButton = source.includes('Cancel') || source.includes('cancel')
    expect(hasCancelButton).toBe(true)
  })

  test('source has a destructive delete button', () => {
    const source = getSource()
    expect(source).toContain('variant="destructive"')
  })
})

describe('DeleteAgentDialog: uses composables', () => {
  test('source calls useI18n()', () => {
    const source = getSource()
    expect(source).toContain('useI18n()')
  })

  test('source calls useAppToast()', () => {
    const source = getSource()
    expect(source).toContain('useAppToast()')
  })

  test('source calls useApi()', () => {
    const source = getSource()
    expect(source).toContain('useApi()')
  })
})

describe('DeleteAgentDialog: no console.log', () => {
  test('source does not contain console.log', () => {
    const source = getSource()
    expect(source).not.toContain('console.log')
  })
})
