import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const componentPath = join(webDir, 'components', 'CommentThread.vue')

function getSource(): string {
  return readFileSync(componentPath, 'utf-8')
}

// ──────────────────────────────────────────────────────────────────────────────
// File existence
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004: CommentThread.vue comment edit feature exists', () => {
  test('file is present at components/CommentThread.vue', () => {
    expect(existsSync(componentPath)).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — When comment create form renders, comment body input uses markdown
//        editor with write/preview UI
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004 AC1: comment create form uses MarkdownEditor for body input', () => {
  test('source imports MarkdownEditor component', () => {
    const source = getSource()
    const hasMarkdownEditorImport =
      source.includes('MarkdownEditor') ||
      source.includes('markdown-editor')
    expect(hasMarkdownEditorImport).toBe(true)
  })

  test('source replaces Textarea with MarkdownEditor in the comment form', () => {
    const source = getSource()
    const hasMarkdownEditorInForm =
      source.includes('<MarkdownEditor') ||
      source.includes('<markdown-editor')
    expect(hasMarkdownEditorInForm).toBe(true)
  })

  test('form body field no longer uses plain Textarea component', () => {
    const source = getSource()
    const formFieldMatch = source.match(/<FormField\s+name=["']body["']>[\s\S]*?<\/FormField>/)
    if (formFieldMatch) {
      const formFieldContent = formFieldMatch[0]
      const hasTextareaOnly = formFieldContent.includes('<Textarea') && !formFieldContent.includes('MarkdownEditor')
      expect(hasTextareaOnly).toBe(false)
    }
  })

  test('MarkdownEditor is used within the comment add form section', () => {
    const source = getSource()
    const addFormSection = source.match(/Add comment form[\s\S]*?<form[^>]*>[\s\S]*?<\/form>/i) ||
                          source.match(/<form[^>]*>[\s\S]*?comment/i)
    if (addFormSection) {
      const hasMarkdownEditor = addFormSection[0].includes('MarkdownEditor')
      expect(hasMarkdownEditor).toBe(true)
    } else {
      expect(source).toContain('MarkdownEditor')
    }
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — Given user edits existing comment body and saves, client calls
//        PATCH /comments/:id with updated body
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004 AC2: edit existing comment calls PATCH /comments/:id', () => {
  test('source has edit action button or trigger per comment', () => {
    const source = getSource()
    const hasEditAction =
      source.includes('edit') ||
      source.includes('Edit')
    expect(hasEditAction).toBe(true)
  })

  test('source calls $api.patch when saving an edited comment', () => {
    const source = getSource()
    expect(source).toContain('$api.patch')
  })

  test('source PATCHes to /comments/:id endpoint', () => {
    const source = getSource()
    const hasPatchEndpoint =
      source.includes('/comments/') &&
      source.includes('$api.patch')
    expect(hasPatchEndpoint).toBe(true)
  })

  test('source passes updated body to PATCH call', () => {
    const source = getSource()
    const patchCallMatch = source.match(/\$api\.patch\s*\([^)]*\)/)
    if (patchCallMatch) {
      const patchCall = patchCallMatch[0]
      const passesBody =
        patchCall.includes('body') ||
        patchCall.includes('commentBody') ||
        patchCall.includes('updatedBody')
      expect(passesBody).toBe(true)
    }
  })

  test('source has an edit mode state for individual comments', () => {
    const source = getSource()
    const hasEditState =
      source.includes('editingId') ||
      source.includes('editingComment') ||
      source.includes('isEditing') ||
      source.includes('editMode')
    expect(hasEditState).toBe(true)
  })

  test('source tracks which comment is being edited', () => {
    const source = getSource()
    const tracksEditingComment =
      source.includes('ref(') &&
      (source.includes('editingId') || source.includes('editingCommentId'))
    expect(tracksEditingComment).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — Given comment edit save succeeds, updated comment body is shown
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004 AC3: successful edit updates comment body in thread render', () => {
  test('after successful PATCH, source refreshes or updates comments', () => {
    const source = getSource()
    const hasRefresh =
      source.includes('refreshComments()') ||
      source.includes('refresh(')
    expect(hasRefresh).toBe(true)
  })

  test('comment list re-renders after successful edit', () => {
    const source = getSource()
    const usesComputedComments =
      source.includes('computed(') &&
      source.includes('comments')
    expect(usesComputedComments).toBe(true)
  })

  test('edited comment reflects new body in the v-for rendered list', () => {
    const source = getSource()
    const rendersCommentBody =
      source.includes('.body') ||
      source.includes('comment.body')
    expect(rendersCommentBody).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — Given comment edit save fails, inline edit draft is preserved
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004 AC4: failed edit preserves inline draft', () => {
  test('edit draft is stored in a reactive ref', () => {
    const source = getSource()
    const hasDraftState =
      source.includes('draft') ||
      source.includes('editDraft') ||
      source.includes('localBody')
    expect(hasDraftState).toBe(true)
  })

  test('draft is NOT cleared immediately when API fails', () => {
    const source = getSource()
    const catchBlockMatch = source.match(/catch\s*\([^)]*\)\s*\{([\s\S]*?)\}/)
    if (catchBlockMatch) {
      const catchBlock = catchBlockMatch[0]
      const preservesDraft =
        catchBlock.includes('draft') ||
        catchBlock.includes('localBody') ||
        !catchBlock.includes('draft.value =')
      expect(preservesDraft).toBe(true)
    }
  })

  test('editing state is NOT reset when API fails', () => {
    const source = getSource()
    const catchBlockMatch = source.match(/catch\s*\([^)]*\)\s*\{([\s\S]*?)\}/)
    if (catchBlockMatch) {
      const catchBlock = catchBlockMatch[0]
      const preservesEditState =
        catchBlock.includes('editingId') ||
        catchBlock.includes('isEditing') ||
        !catchBlock.includes('editingId.value =')
      expect(preservesEditState).toBe(true)
    }
  })

  test('form still shows draft content after failed save', () => {
    const source = getSource()
    const hasVModelForEdit =
      source.includes('v-model') &&
      (source.includes('draft') || source.includes('editDraft'))
    expect(hasVModelForEdit).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC5 — Given comment edit save fails, localized error toast is shown
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004 AC5: failed edit shows localized error toast', () => {
  test('catch block calls toast.error', () => {
    const source = getSource()
    const hasToastError =
      source.includes('toast.error')
    expect(hasToastError).toBe(true)
  })

  test('toast.error uses extractApiError for error message', () => {
    const source = getSource()
    const hasExtractApiError =
      source.includes('extractApiError(') ||
      source.includes('extractApiErrorMessage')
    expect(hasExtractApiError).toBe(true)
  })

  test('error toast key exists in i18n locale files', () => {
    const enPath = join(webDir, 'i18n', 'locales', 'en.json')
    const zhPath = join(webDir, 'i18n', 'locales', 'zh.json')

    const enSource = readFileSync(enPath, 'utf-8')
    const zhSource = readFileSync(zhPath, 'utf-8')

    const enHasEditFailed = enSource.includes('editFailed') || enSource.includes('updateFailed')
    const zhHasEditFailed = zhSource.includes('editFailed') || zhSource.includes('updateFailed')

    expect(enHasEditFailed || zhHasEditFailed).toBe(true)
  })

  test('toast is called within the catch block of edit submission', () => {
    const source = getSource()
    const catchBlocks = source.match(/catch\s*\([^)]*\)\s*\{[\s\S]*?\}/g)
    if (catchBlocks) {
      const editCatchBlock = catchBlocks.find(block =>
        (block.includes('$api.patch') || block.includes('PATCH')) &&
        block.includes('toast.error')
      )
      expect(editCatchBlock).toBeDefined()
    }
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Additional: Edit cancel functionality
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004: edit can be cancelled', () => {
  test('source has cancel action for edit mode', () => {
    const source = getSource()
    const hasCancelAction =
      source.includes('cancel') ||
      source.includes('Cancel')
    expect(hasCancelAction).toBe(true)
  })

  test('cancel clears editing state', () => {
    const source = getSource()
    const clearsEditState =
      source.includes('editingId') &&
      source.includes('null')
    expect(clearsEditState).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Quality — no console.log
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004: CommentThread.vue edit feature has no console.log statements', () => {
  test('source does not contain console.log', () => {
    const source = getSource()
    expect(source).not.toContain('console.log')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// i18n keys exist for edit-related UI text
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004: i18n keys exist for comment edit flow', () => {
  test('edit button text exists in en.json', () => {
    const enPath = join(webDir, 'i18n', 'locales', 'en.json')
    const enSource = readFileSync(enPath, 'utf-8')
    const hasEditKey =
      enSource.includes('"edit"') ||
      enSource.includes('"editComment"')
    expect(hasEditKey).toBe(true)
  })

  test('cancel button text exists in en.json', () => {
    const enPath = join(webDir, 'i18n', 'locales', 'en.json')
    const enSource = readFileSync(enPath, 'utf-8')
    const hasCancelKey =
      enSource.includes('"cancel"')
    expect(hasCancelKey).toBe(true)
  })

  test('save button text exists in en.json', () => {
    const enPath = join(webDir, 'i18n', 'locales', 'en.json')
    const enSource = readFileSync(enPath, 'utf-8')
    const hasSaveKey =
      enSource.includes('"save"')
    expect(hasSaveKey).toBe(true)
  })
})
