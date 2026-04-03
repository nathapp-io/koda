import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const componentPath = join(webDir, 'components', 'DeleteAgentDialog.vue')

function getSource(): string {
  return readFileSync(componentPath, 'utf-8')
}

describe('US-001-B AC1: DeleteAgentDialog DialogTitle uses t("agents.deleteAgent.title")', () => {
  test('source uses t("agents.deleteAgent.title") for DialogTitle', () => {
    const source = getSource()
    expect(source).toContain("t('agents.deleteAgent.title')")
  })

  test('source does not contain hardcoded "Delete Agent" string literal in DialogTitle', () => {
    const source = getSource()
    const dialogTitleMatch = source.match(/<DialogTitle>.*?<\/DialogTitle>/s)
    if (dialogTitleMatch) {
      const dialogTitleContent = dialogTitleMatch[0]
      const hasHardcodedDeleteAgent = /<DialogTitle>\s*Delete Agent\s*<\/DialogTitle>/.test(dialogTitleContent)
      expect(hasHardcodedDeleteAgent).toBe(false)
    }
  })
})

describe('US-001-B AC2: DeleteAgentDialog confirmation body uses t("agents.deleteAgent.confirm") with agent name interpolation', () => {
  test('source uses t("agents.deleteAgent.confirm") for confirmation body', () => {
    const source = getSource()
    expect(source).toContain("t('agents.deleteAgent.confirm')")
  })

  test('source does not contain hardcoded confirmation body text', () => {
    const source = getSource()
    const hasHardcodedConfirm = source.includes('Are you sure you want to delete agent')
    expect(hasHardcodedConfirm).toBe(false)
  })
})

describe('US-001-B AC3: DeleteAgentDialog delete button label uses t("agents.deleteAgent.deleting") when isSubmitting=true', () => {
  test('source uses t("agents.deleteAgent.deleting") for delete button when submitting', () => {
    const source = getSource()
    expect(source).toContain("t('agents.deleteAgent.deleting')")
  })

  test('source does not contain hardcoded "Deleting..." string', () => {
    const source = getSource()
    const hasHardcodedDeleting = source.includes("'Deleting...'") || source.includes('"Deleting..."')
    expect(hasHardcodedDeleting).toBe(false)
  })
})

describe('US-001-B AC4: DeleteAgentDialog delete button label uses t("agents.actions.delete") when isSubmitting=false', () => {
  test('source uses t("agents.actions.delete") for delete button when idle', () => {
    const source = getSource()
    expect(source).toContain("t('agents.actions.delete')")
  })

  test('source does not contain hardcoded "Delete" string in button', () => {
    const source = getSource()
    const hardcodedDeleteButton = /<Button[^>]*>[\s]*Delete[\s]*<\/Button>/.test(source)
    expect(hardcodedDeleteButton).toBe(false)
  })
})

describe('US-001-B AC5: DeleteAgentDialog cancel button uses t("common.cancel")', () => {
  test('source uses t("common.cancel") for cancel button', () => {
    const source = getSource()
    expect(source).toContain("t('common.cancel')")
  })

  test('source does not contain hardcoded "Cancel" string in cancel button', () => {
    const source = getSource()
    const cancelButtonMatch = source.match(/<Button[^>]*variant=["']outline["'][^>]*>.*?Cancel.*?<\/Button>/s)
    if (cancelButtonMatch) {
      const hasHardcodedCancel = /Cancel(?!\w)/.test(cancelButtonMatch[0])
      expect(hasHardcodedCancel).toBe(false)
    }
  })
})
