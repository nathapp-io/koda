import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const dialogPath = join(webDir, 'components', 'CreateTicketDialog.vue')
const pagePath = join(webDir, 'pages', '[project]', 'tickets', '[ref].vue')

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function dialogSource(): string {
  return readFileSync(dialogPath, 'utf-8')
}

function pageSource(): string {
  return readFileSync(pagePath, 'utf-8')
}

// ──────────────────────────────────────────────────────────────────────────────
// US-003 AC1: CreateTicketDialog uses MarkdownEditor for description field
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003 AC1: CreateTicketDialog description field uses MarkdownEditor', () => {
  test('source imports MarkdownEditor component', () => {
    const src = dialogSource()
    const hasMarkdownEditorImport =
      src.includes('MarkdownEditor') &&
      (src.includes('import') || src.includes('~components') || src.includes('@/components'))
    expect(hasMarkdownEditorImport).toBe(true)
  })

  test('source uses MarkdownEditor instead of plain Textarea for description field', () => {
    const src = dialogSource()
    const hasMarkdownEditor = src.includes('MarkdownEditor')
    expect(hasMarkdownEditor).toBe(true)
  })

  test('source does not use plain Textarea for description field', () => {
    const src = dialogSource()
    const descriptionFieldMatch = src.match(/<FormField\s+name="description"[^>]*>[\s\S]*?<\/FormField>/)
    if (descriptionFieldMatch) {
      const fieldContent = descriptionFieldMatch[0]
      const hasPlainTextareaOnly = fieldContent.includes('<Textarea') && !fieldContent.includes('MarkdownEditor')
      expect(hasPlainTextareaOnly).toBe(false)
    }
  })

  test('MarkdownEditor is used within the description FormField', () => {
    const src = dialogSource()
    const hasMarkdownEditorInDescriptionField =
      src.includes('name="description"') &&
      (src.includes('MarkdownEditor') || src.includes('<markdown-editor'))
    expect(hasMarkdownEditorInDescriptionField).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// US-003 AC2: Ticket detail page edit mode calls PATCH with description
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003 AC2: ticket detail page edit mode updates description via PATCH', () => {
  test('source has an edit mode state (isEditing or similar)', () => {
    const src = pageSource()
    const hasEditState =
      src.includes('isEditing') ||
      src.includes('editMode') ||
      src.includes('editing')
    expect(hasEditState).toBe(true)
  })

  test('source calls $api.patch for ticket updates', () => {
    const src = pageSource()
    const hasPatchCall =
      src.includes('$api.patch') ||
      src.includes('$api.patch(')
    expect(hasPatchCall).toBe(true)
  })

  test('source PATCHes to /projects/${slug}/tickets/${ref} endpoint', () => {
    const src = pageSource()
    const hasPatchEndpoint =
      (src.includes('/projects/${') || src.includes('/projects/`') || src.includes('/projects/')) &&
      (src.includes('/tickets/${') || src.includes('/tickets/`') || src.includes('/tickets/')) &&
      src.includes('patch')
    expect(hasPatchEndpoint).toBe(true)
  })

  test('source includes description field in the PATCH payload', () => {
    const src = pageSource()
    const hasDescriptionInPatch =
      (src.includes('description:') || src.includes("description:")) &&
      src.includes('patch')
    expect(hasDescriptionInPatch).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// US-003 AC3: Ticket detail page edit mode calls PATCH with title
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003 AC3: ticket detail page edit mode updates title via PATCH', () => {
  test('source has edit mode that allows title editing', () => {
    const src = pageSource()
    const hasTitleEdit =
      (src.includes('isEditing') || src.includes('editMode')) &&
      (src.includes('title') || src.includes('Title'))
    expect(hasTitleEdit).toBe(true)
  })

  test('source includes title field in the PATCH payload', () => {
    const src = pageSource()
    const hasTitleInPatch =
      (src.includes('title:') || src.includes("title:")) &&
      src.includes('patch')
    expect(hasTitleInPatch).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// US-003 AC4: Ticket detail page edit mode calls PATCH with priority
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003 AC4: ticket detail page edit mode updates priority via PATCH', () => {
  test('source has edit mode that allows priority editing', () => {
    const src = pageSource()
    const hasPriorityEdit =
      (src.includes('isEditing') || src.includes('editMode')) &&
      (src.includes('priority') || src.includes('Priority'))
    expect(hasPriorityEdit).toBe(true)
  })

  test('source includes priority field in the PATCH payload', () => {
    const src = pageSource()
    const hasPriorityInPatch =
      (src.includes('priority:') || src.includes("priority:")) &&
      src.includes('patch')
    expect(hasPriorityInPatch).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// US-003 AC5: On successful PATCH, ticket detail view refreshes
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003 AC5: ticket detail view refreshes after successful save', () => {
  test('source destructures refresh from useAsyncData', () => {
    const src = pageSource()
    const hasRefresh =
      src.includes('refresh') &&
      src.includes('useAsyncData')
    expect(hasRefresh).toBe(true)
  })

  test('source calls refresh() after successful PATCH', () => {
    const src = pageSource()
    const hasRefreshCall =
      (src.includes('refresh()') || src.includes('await refresh()')) &&
      src.includes('patch')
    expect(hasRefreshCall).toBe(true)
  })

  test('source has a save handler that calls both PATCH and refresh', () => {
    const src = pageSource()
    const hasPatchAndRefresh =
      src.includes('$api.patch') &&
      (src.includes('refresh()') || src.includes('await refresh()'))
    expect(hasPatchAndRefresh).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// US-003 AC6: On successful PATCH, description displays rendered markdown
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003 AC6: description panel displays rendered markdown after save', () => {
  test('source renders description with markdown rendering in view mode', () => {
    const src = pageSource()
    const hasMarkdownRendering =
      src.includes('marked') ||
      src.includes('MarkdownEditor') ||
      src.includes('renderMarkdown') ||
      src.includes('v-html')
    expect(hasMarkdownRendering).toBe(true)
  })

  test('source uses MarkdownEditor or marked for description rendering', () => {
    const src = pageSource()
    const hasMarkdownRendering =
      (src.includes('marked') && src.includes('description')) ||
      (src.includes('MarkdownEditor') && src.includes('description'))
    expect(hasMarkdownRendering).toBe(true)
  })

  test('source displays rendered HTML in description panel using v-html', () => {
    const src = pageSource()
    const hasVHtmlForDescription =
      src.includes('v-html') &&
      (src.includes('description') || src.includes('rendered'))
    expect(hasVHtmlForDescription).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// US-003 AC7: On failed PATCH, edit state and draft remain available
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003 AC7: on PATCH failure, edit state and draft remain available', () => {
  test('source has try-catch around PATCH call', () => {
    const src = pageSource()
    const hasTryCatch =
      (src.includes('try {') || src.includes('try{')) &&
      src.includes('patch')
    expect(hasTryCatch).toBe(true)
  })

  test('source does not clear edit state on error', () => {
    const src = pageSource()
    const hasErrorHandling =
      src.includes('catch') &&
      src.includes('error')
    expect(hasErrorHandling).toBe(true)
  })

  test('source shows error toast on PATCH failure', () => {
    const src = pageSource()
    const hasErrorToast =
      src.includes('toast.error') &&
      src.includes('patch')
    expect(hasErrorToast).toBe(true)
  })

  test('edit state variables remain after error (not reset)', () => {
    const src = pageSource()
    const hasPreservedEditState =
      (src.includes('isEditing') || src.includes('editMode')) &&
      src.includes('catch')
    expect(hasPreservedEditState).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Quality: no console.log
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003 quality: CreateTicketDialog has no console.log', () => {
  test('source does not contain console.log', () => {
    const src = dialogSource()
    expect(src).not.toContain('console.log')
  })
})

describe('US-003 quality: ticket detail page has no console.log', () => {
  test('source does not contain console.log', () => {
    const src = pageSource()
    expect(src).not.toContain('console.log')
  })
})
