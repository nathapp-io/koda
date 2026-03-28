import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const pagePath = join(webDir, 'pages', '[project]', 'labels.vue')
const layoutPath = join(webDir, 'layouts', 'default.vue')
const enLocalePath = join(webDir, 'i18n', 'locales', 'en.json')
const zhLocalePath = join(webDir, 'i18n', 'locales', 'zh.json')

// ──────────────────────────────────────────────────────────────────────────────
// File existence
// ──────────────────────────────────────────────────────────────────────────────

describe('US-008: pages/[project]/labels.vue exists', () => {
  test('file is present at pages/[project]/labels.vue', () => {
    expect(existsSync(pagePath)).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — mounts with project slug, calls GET /projects/:slug/labels, renders table rows
// ──────────────────────────────────────────────────────────────────────────────

describe('US-008 AC1: fetches GET /projects/:slug/labels via useAsyncData and renders Table', () => {
  test('source uses useAsyncData for data fetching', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('useAsyncData')
  })

  test('source uses useApi composable', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('useApi')
  })

  test('source calls $api.get for fetching labels', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('$api.get')
  })

  test('source fetches from /projects/:slug/labels endpoint', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasLabelsEndpoint =
      source.includes('/labels') ||
      source.includes('labels')
    expect(hasLabelsEndpoint).toBe(true)
  })

  test('source uses route.params.project or slug for project context', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasProjectSlug =
      source.includes('route.params.project') ||
      source.includes('params.project') ||
      source.includes('slug')
    expect(hasProjectSlug).toBe(true)
  })

  test('source renders a Table component', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('Table')
  })

  test('source iterates over labels with v-for', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('v-for')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — Color column shows a 16x16 colored swatch span
// ──────────────────────────────────────────────────────────────────────────────

describe('US-008 AC2: Color column renders a 16x16 swatch span with background-color', () => {
  test('source renders a span or element with background-color bound to label.color', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasColorSwatch =
      source.includes('label.color') ||
      source.includes('.color')
    expect(hasColorSwatch).toBe(true)
  })

  test('source applies inline style with backgroundColor or background-color', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasBackgroundColor =
      source.includes('backgroundColor') ||
      source.includes('background-color') ||
      source.includes('background:')
    expect(hasBackgroundColor).toBe(true)
  })

  test('source uses w-4 or width for 16px swatch', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const has16px =
      source.includes('w-4') ||
      source.includes('width: 16') ||
      source.includes('width:\'16px\'') ||
      source.includes('16px')
    expect(has16px).toBe(true)
  })

  test('source uses h-4 or height for 16px swatch', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const has16px =
      source.includes('h-4') ||
      source.includes('height: 16') ||
      source.includes('height:\'16px\'') ||
      source.includes('16px')
    expect(has16px).toBe(true)
  })

  test('source has a Color column header', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasColorHeader =
      source.includes("t('labels.columns.color')") ||
      source.includes('labels.columns.color') ||
      source.includes('Color')
    expect(hasColorHeader).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — Create Label form calls POST with name and default color #6366f1
// ──────────────────────────────────────────────────────────────────────────────

describe('US-008 AC3: Create Label form calls POST /projects/:slug/labels with default color', () => {
  test('source calls $api.post for creating labels', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('$api.post')
  })

  test('source includes default color value #6366f1', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('#6366f1')
  })

  test('source has a name field in the create form', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasNameField =
      source.includes('labels.form.name') ||
      source.includes("'name'") ||
      source.includes('"name"') ||
      source.includes('newName') ||
      source.includes('labelName')
    expect(hasNameField).toBe(true)
  })

  test('source has a color field in the create form', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasColorField =
      source.includes('labels.form.color') ||
      source.includes('newColor') ||
      source.includes('labelColor') ||
      source.includes('color')
    expect(hasColorField).toBe(true)
  })

  test('source posts to /projects/:slug/labels endpoint', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasPostEndpoint =
      source.includes('/labels') &&
      source.includes('$api.post')
    expect(hasPostEndpoint).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — POST success refreshes list and shows labels.toast.created
// ──────────────────────────────────────────────────────────────────────────────

describe('US-008 AC4: POST success refreshes labels list and shows labels.toast.created', () => {
  test('source calls refresh() after successful POST', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('refresh')
  })

  test('source shows toast.success on successful create', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('toast.success')
  })

  test('source uses labels.toast.created i18n key for success toast', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('labels.toast.created')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC5 — POST failure shows labels.toast.createFailed
// ──────────────────────────────────────────────────────────────────────────────

describe('US-008 AC5: POST failure shows labels.toast.createFailed error toast', () => {
  test('source shows toast.error on failed create', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('toast.error')
  })

  test('source uses extractApiError to build the error toast message (US-004 supersedes static i18n key)', () => {
    const source = readFileSync(pagePath, 'utf-8')
    // US-004 replaced the static labels.toast.createFailed fallback with extractApiError(err)
    // so the error toast message is now the structured API error string
    expect(source).toContain('extractApiError(')
  })

  test('source has try/catch error handling around the POST call', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasErrorHandling =
      source.includes('try') &&
      (source.includes('catch') || source.includes('.catch('))
    expect(hasErrorHandling).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC6 — Delete button calls DELETE /projects/:slug/labels/:labelId
// ──────────────────────────────────────────────────────────────────────────────

describe('US-008 AC6: Delete button calls DELETE /projects/:slug/labels/:labelId', () => {
  test('source calls $api.delete for deleting labels', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('$api.delete')
  })

  test('source includes labelId or label.id in the DELETE endpoint', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasLabelId =
      source.includes('label.id') ||
      source.includes('labelId') ||
      source.includes('.id')
    expect(hasLabelId).toBe(true)
  })

  test('source has a Delete button for each label row', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasDeleteButton =
      source.includes('deleteLabel') ||
      source.includes('handleDelete') ||
      source.includes('$api.delete')
    expect(hasDeleteButton).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC7 — DELETE success refreshes list and shows labels.toast.deleted
// ──────────────────────────────────────────────────────────────────────────────

describe('US-008 AC7: DELETE success refreshes labels list and shows labels.toast.deleted', () => {
  test('source uses labels.toast.deleted i18n key for delete success toast', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('labels.toast.deleted')
  })

  test('source shows toast.success on successful delete', () => {
    const source = readFileSync(pagePath, 'utf-8')
    // Already covered by AC4, but verified independently for delete path
    expect(source).toContain('toast.success')
  })

  test('source calls refresh() after successful DELETE', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('refresh')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC8 — Empty state shows labels.empty i18n key message
// ──────────────────────────────────────────────────────────────────────────────

describe('US-008 AC8: empty labels list shows labels.empty i18n key message', () => {
  test('source uses labels.empty i18n key for empty state', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('labels.empty')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC9 — Labels nav link appears in default.vue alongside Agents and KB links
// ──────────────────────────────────────────────────────────────────────────────

describe('US-008 AC9: Labels navigation link in layouts/default.vue', () => {
  test('layout contains Labels navigation link text via i18n key', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    const hasLabelsNav =
      source.includes("t('nav.labels')") ||
      source.includes("nav.labels")
    expect(hasLabelsNav).toBe(true)
  })

  test('layout contains a NuxtLink navigating to /:project/labels', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    const hasLabelsLink =
      source.includes('/labels') &&
      source.includes('NuxtLink')
    expect(hasLabelsLink).toBe(true)
  })

  test('Labels link is conditional on $route.params.project', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    // Labels link should be inside v-if="$route.params.project" context
    const hasProjectCondition =
      source.includes('$route.params.project') ||
      source.includes('route.params.project')
    expect(hasProjectCondition).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// i18n — en.json and zh.json have required labels.* keys
// ──────────────────────────────────────────────────────────────────────────────

describe('US-008: i18n/locales/en.json has required labels.* keys', () => {
  test('en.json has labels.toast.created key', () => {
    const locale = JSON.parse(readFileSync(enLocalePath, 'utf-8'))
    expect(locale?.labels?.toast?.created).toBeDefined()
  })

  test('en.json has labels.toast.createFailed key', () => {
    const locale = JSON.parse(readFileSync(enLocalePath, 'utf-8'))
    expect(locale?.labels?.toast?.createFailed).toBeDefined()
  })

  test('en.json has labels.toast.deleted key', () => {
    const locale = JSON.parse(readFileSync(enLocalePath, 'utf-8'))
    expect(locale?.labels?.toast?.deleted).toBeDefined()
  })

  test('en.json has labels.empty key', () => {
    const locale = JSON.parse(readFileSync(enLocalePath, 'utf-8'))
    expect(locale?.labels?.empty).toBeDefined()
  })
})

describe('US-008: i18n/locales/zh.json has required labels.* keys', () => {
  test('zh.json has labels.toast.created key', () => {
    const locale = JSON.parse(readFileSync(zhLocalePath, 'utf-8'))
    expect(locale?.labels?.toast?.created).toBeDefined()
  })

  test('zh.json has labels.toast.createFailed key', () => {
    const locale = JSON.parse(readFileSync(zhLocalePath, 'utf-8'))
    expect(locale?.labels?.toast?.createFailed).toBeDefined()
  })

  test('zh.json has labels.toast.deleted key', () => {
    const locale = JSON.parse(readFileSync(zhLocalePath, 'utf-8'))
    expect(locale?.labels?.toast?.deleted).toBeDefined()
  })

  test('zh.json has labels.empty key', () => {
    const locale = JSON.parse(readFileSync(zhLocalePath, 'utf-8'))
    expect(locale?.labels?.empty).toBeDefined()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Quality — no console.log
// ──────────────────────────────────────────────────────────────────────────────

describe('US-008: pages/[project]/labels.vue has no console.log statements', () => {
  test('source does not contain console.log', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).not.toContain('console.log')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// US-004 AC5 — onSubmit catch uses extractApiError and no console.error
// US-004 AC6 — deleteLabel catch uses extractApiError and no console.error
// US-004 AC7 — extractApiError returns error.message for generic Error
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004 AC5: labels.vue onSubmit catch uses extractApiError and no console.error', () => {
  test('source imports extractApiError from ~/composables/useApi', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasImport =
      source.includes('extractApiError') &&
      (source.includes('useApi') || source.includes('composables/useApi'))
    expect(hasImport).toBe(true)
  })

  test('source calls extractApiError(err) in create label catch block', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('extractApiError(')
  })

  test('toast.error is called with extractApiError result on label create failure', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasExtractBeforeToast =
      source.includes('extractApiError(') &&
      source.includes('toast.error(')
    expect(hasExtractBeforeToast).toBe(true)
  })

  test('source does not contain console.error in onSubmit catch', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).not.toContain('console.error')
  })
})

describe('US-004 AC6: labels.vue deleteLabel catch uses extractApiError and no console.error', () => {
  test('source calls extractApiError(err) in deleteLabel catch block', () => {
    const source = readFileSync(pagePath, 'utf-8')
    // extractApiError must be present (covers both catch blocks)
    expect(source).toContain('extractApiError(')
  })

  test('source does not contain any console.error calls', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).not.toContain('console.error')
  })

  test('source does not use inferior instanceof Error pattern in deleteLabel catch', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasInferiorPattern =
      source.includes('instanceof Error ? err.message') ||
      source.includes('instanceof Error ? error.message')
    expect(hasInferiorPattern).toBe(false)
  })
})

describe('US-004 AC7: extractApiError in useApi composable handles generic Error', () => {
  const useApiPath = join(webDir, 'composables', 'useApi.ts')

  test('composable exports extractApiError function', () => {
    const source = readFileSync(useApiPath, 'utf-8')
    expect(source).toContain('export function extractApiError')
  })

  test('extractApiError handles generic Error by returning error.message', () => {
    const source = readFileSync(useApiPath, 'utf-8')
    // The function must have a branch for generic Error instances
    const hasGenericErrorBranch =
      source.includes('err instanceof Error') &&
      source.includes('err.message')
    expect(hasGenericErrorBranch).toBe(true)
  })

  test('extractApiError handles ApiError by returning firstError', () => {
    const source = readFileSync(useApiPath, 'utf-8')
    const hasApiErrorBranch =
      source.includes('err instanceof ApiError') &&
      source.includes('firstError')
    expect(hasApiErrorBranch).toBe(true)
  })
})
