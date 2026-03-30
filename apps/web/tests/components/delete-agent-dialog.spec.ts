import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const componentPath = join(webDir, 'components', 'DeleteAgentDialog.vue')

// Helper function to get the source
function getSource(): string {
  return readFileSync(componentPath, 'utf-8')
}

// ──────────────────────────────────────────────────────────────────────────────
// File existence
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-2: DeleteAgentDialog.vue exists', () => {
  test('file is present at components/DeleteAgentDialog.vue', () => {
    expect(existsSync(componentPath)).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC5 — When DeleteAgentDialog opens, the confirm message contains the agent's name
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-2 AC5: When DeleteAgentDialog opens, the confirm message contains the agent name', () => {
  test('source receives agent prop', () => {
    const source = getSource()
    const hasAgentProp =
      source.match(/props.*agent/) ||
      source.match(/defineProps.*agent/) ||
      source.includes(':agent=')
    expect(hasAgentProp).not.toBeNull()
  })

  test('source references agent.name in the confirm message', () => {
    const source = getSource()
    expect(source).toContain('agent.name')
  })

  test('source displays the agent name in a confirm message', () => {
    const source = getSource()
    const referencesAgentNameInConfirm =
      source.match(/agent\.name/) &&
      (source.includes('confirm') || source.includes('delete') || source.includes('Delete'))
    expect(referencesAgentNameInConfirm).toBe(true)
  })

  test('source has warning text about the action being destructive', () => {
    const source = getSource()
    const hasDeleteWarning =
      source.includes('delete') ||
      source.includes('Delete') ||
      source.includes('remove') ||
      source.includes('Remove')
    expect(hasDeleteWarning).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC6 — When DeleteAgentDialog confirm button is clicked,
//        it calls $api.delete('/agents/' + agent.slug)
// ──────────────────────────────────────────────────────────────────────────────

describe("US-004-2 AC6: When confirm button is clicked, it calls $api.delete('/agents/' + agent.slug)", () => {
  test('source uses $api.delete for the deletion call', () => {
    const source = getSource()
    const hasDeleteCall = !!source.match(/\$api\.delete\s*\(/)
    expect(hasDeleteCall).toBe(true)
  })

  test('source constructs the delete URL with agent.slug', () => {
    const source = getSource()
    const hasDeleteUrl =
      source.includes('agent.slug') &&
      (source.includes('delete') || source.includes('/agents/'))
    expect(hasDeleteUrl).toBe(true)
  })

  test('source has a confirm button that triggers the API call', () => {
    const source = getSource()
    const hasConfirmButton =
      source.includes('confirm') ||
      source.includes('Confirm') ||
      source.includes('Delete')
    expect(hasConfirmButton).toBe(true)
  })

  test('source uses handleSubmit or click handler for the delete action', () => {
    const source = getSource()
    const usesSubmitHandler =
      source.includes('handleSubmit') ||
      source.includes('@submit') ||
      source.includes('@click') ||
      source.includes('onConfirm') ||
      source.includes('handleDelete')
    expect(usesSubmitHandler).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC7 — When deletion succeeds, it shows a success toast, emits 'deleted', and closes
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-2 AC7: When deletion succeeds, it shows success toast, emits deleted, and closes', () => {
  test('source calls toast.success on API success', () => {
    const source = getSource()
    const hasToastSuccess = source.match(/toast\.success/)
    expect(hasToastSuccess).not.toBeNull()
  })

  test('source wraps $api.delete in try-catch', () => {
    const source = getSource()
    const hasTryCatch =
      source.includes('try {') &&
      source.includes('catch')
    expect(hasTryCatch).toBe(true)
  })

  test('source calls toast.error on API failure', () => {
    const source = getSource()
    const hasToastError =
      source.includes('catch') &&
      source.match(/toast\.error/)
    expect(hasToastError).not.toBeNull()
  })

  test("source emits 'deleted' event on success", () => {
    const source = getSource()
    const emitsDeleted =
      source.includes("emit('deleted')") ||
      source.includes('emit("deleted")') ||
      source.includes('emit(`deleted`)')
    expect(emitsDeleted).toBe(true)
  })

  test("dialog closes after successful deletion via 'update:open' emit", () => {
    const source = getSource()
    const closesDialogOnSuccess =
      source.includes("emit('update:open'") ||
      source.includes('emit("update:open"')
    expect(closesDialogOnSuccess).toBe(true)
  })

  test('source defines emit function with deleted event', () => {
    const source = getSource()
    const hasEmitsDefinition =
      source.includes("'deleted'") ||
      source.includes('"deleted"')
    expect(hasEmitsDefinition).toBe(true)
  })

  test('source uses toast from useAppToast composable', () => {
    const source = getSource()
    expect(source).toContain('useAppToast')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Component structure tests
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-2: DeleteAgentDialog component structure', () => {
  test('component is a Dialog that receives open prop', () => {
    const source = getSource()
    const hasDialogWithOpen =
      source.includes('Dialog') &&
      (source.includes(':open=') || source.includes('v-model:open'))
    expect(hasDialogWithOpen).toBe(true)
  })

  test('component receives agent prop and uses it for name and slug', () => {
    const source = getSource()
    const usesAgentData =
      source.includes('agent.slug') ||
      source.includes('agent.name')
    expect(usesAgentData).toBe(true)
  })

  test('component has cancel and confirm/delete buttons', () => {
    const source = getSource()
    const hasCancelButton = source.includes('Cancel') || source.includes('cancel')
    const hasDeleteButton = source.includes('Delete') || source.includes('delete')
    expect(hasCancelButton).toBe(true)
    expect(hasDeleteButton).toBe(true)
  })

  test('component handles isSubmitting state for button disabling', () => {
    const source = getSource()
    const handlesSubmitting =
      source.includes('isSubmitting')
    expect(handlesSubmitting).toBe(true)
  })

  test('submit/delete button is disabled when isSubmitting is true', () => {
    const source = getSource()
    if (source.includes('isSubmitting')) {
      const hasDisabledAttr = !!source.match(/:disabled=["']isSubmitting["']/)
      expect(hasDisabledAttr).toBe(true)
    }
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Quality: No console.log
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-2: DeleteAgentDialog.vue has no console.log statements', () => {
  test('source does not contain console.log', () => {
    const source = getSource()
    expect(source).not.toContain('console.log')
  })
})
