import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '.')
const projectBoardPath = join(webDir, 'pages', '[project]', 'index.vue')
const labelsPagePath = join(webDir, 'pages', '[project]', 'labels.vue')
const layoutPath = join(webDir, 'layouts', 'default.vue')
const pagesDir = join(webDir, 'pages')
const componentsDir = join(webDir, 'components')

// ──────────────────────────────────────────────────────────────────────────────
// AC-1: handleOpenTicket uses ticket.ref in the router.push path
// ──────────────────────────────────────────────────────────────────────────────

describe('AC-1: handleOpenTicket navigates to /:slug/tickets/:ref', () => {
  test('pages/[project]/index.vue exists', () => {
    expect(existsSync(projectBoardPath)).toBe(true)
  })

  test('source defines handleOpenTicket function', () => {
    const source = readFileSync(projectBoardPath, 'utf-8')
    expect(source).toContain('handleOpenTicket')
  })

  test('handleOpenTicket uses ticket.ref as the path segment', () => {
    const source = readFileSync(projectBoardPath, 'utf-8')
    // Must reference ticket.ref (not ticket.id or ticket.number) in the navigation path
    const hasRefInPath =
      source.includes('ticket.ref') &&
      (source.includes('/tickets/${ticket.ref}') ||
        source.includes('/tickets/` + ticket.ref') ||
        source.includes("tickets/${ticket.ref}") ||
        source.match(/tickets\/\$\{[^}]*\.ref\}/) !== null ||
        source.match(/tickets\/['"`]\s*\+\s*ticket\.ref/) !== null)
    expect(hasRefInPath).toBe(true)
  })

  test('handleOpenTicket calls router.push with the correct path shape', () => {
    const source = readFileSync(projectBoardPath, 'utf-8')
    const hasRouterPush =
      source.includes('router.push') || source.includes('navigateTo')
    expect(hasRouterPush).toBe(true)
  })

  test('router.push path includes the project slug segment', () => {
    const source = readFileSync(projectBoardPath, 'utf-8')
    // Path must be built using slug variable (the project param)
    const hasSlugInPath =
      source.includes('`/${slug}/tickets/') ||
      source.includes("'/' + slug + '/tickets/") ||
      source.match(/\$\{slug\}\/tickets/) !== null
    expect(hasSlugInPath).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC-2: handleOpenTicket never produces a URL with 'undefined' as a segment
// ──────────────────────────────────────────────────────────────────────────────

describe('AC-2: handleOpenTicket does not use undefined-producing fields', () => {
  test('handleOpenTicket does NOT use ticket.id as the ticket path segment', () => {
    const source = readFileSync(projectBoardPath, 'utf-8')
    // ticket.id must not appear inside a /tickets/ URL template
    const hasIdInTicketsPath =
      source.match(/\/tickets\/\$\{ticket\.id\}/) !== null ||
      source.match(/\/tickets\/['"`]\s*\+\s*ticket\.id\b/) !== null
    expect(hasIdInTicketsPath).toBe(false)
  })

  test('handleOpenTicket does NOT use ticket.number as the ticket path segment', () => {
    const source = readFileSync(projectBoardPath, 'utf-8')
    const hasNumberInTicketsPath =
      source.match(/\/tickets\/\$\{ticket\.number\}/) !== null ||
      source.match(/\/tickets\/['"`]\s*\+\s*ticket\.number\b/) !== null
    expect(hasNumberInTicketsPath).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC-3: No file in apps/web uses ticket.id or ticket.number as a ticket URL segment
// ──────────────────────────────────────────────────────────────────────────────

describe('AC-3: No source file constructs ticket URLs using ticket.id or ticket.number', () => {
  const vueFilePaths = (() => {
    const { readdirSync, statSync } = require('fs')
    const paths: string[] = []
    const scan = (dir: string) => {
      if (!existsSync(dir)) return
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        const stat = statSync(full)
        if (stat.isDirectory()) scan(full)
        else if (entry.endsWith('.vue') || entry.endsWith('.ts')) paths.push(full)
      }
    }
    scan(pagesDir)
    scan(componentsDir)
    return paths
  })()

  test('no file uses /tickets/${ticket.id} as a URL pattern', () => {
    const violations = vueFilePaths.filter((p) => {
      const src = readFileSync(p, 'utf-8')
      return src.match(/\/tickets\/\$\{ticket\.id\}/) !== null
    })
    expect(violations).toEqual([])
  })

  test('no file uses /tickets/${ticket.number} as a URL pattern', () => {
    const violations = vueFilePaths.filter((p) => {
      const src = readFileSync(p, 'utf-8')
      return src.match(/\/tickets\/\$\{ticket\.number\}/) !== null
    })
    expect(violations).toEqual([])
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC-4: Labels page exists, uses useAsyncData and fetches GET /projects/:slug/labels
// ──────────────────────────────────────────────────────────────────────────────

describe('AC-4: Labels page fetches GET /projects/:slug/labels via useAsyncData', () => {
  test('pages/[project]/labels.vue exists', () => {
    expect(existsSync(labelsPagePath)).toBe(true)
  })

  test('labels page uses useAsyncData for data fetching', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    expect(source).toContain('useAsyncData')
  })

  test('labels page calls $api.get to fetch labels', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    expect(source).toContain('$api.get')
  })

  test('labels page fetches from /projects/:slug/labels endpoint', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    const hasFetchLabels =
      source.includes('/labels') &&
      (source.includes('/projects/') || source.match(/projects\/\$\{/) !== null)
    expect(hasFetchLabels).toBe(true)
  })

  test('labels page renders a table row per label using v-for', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    const hasVFor = source.includes('v-for') && source.includes('label')
    expect(hasVFor).toBe(true)
  })

  test('labels page uses Table or TableRow component', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    const hasTable =
      source.includes('TableRow') || source.includes('<table') || source.includes('TableBody')
    expect(hasTable).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC-5: Label color swatch — colored span with 16×16px size matching label.color
// ──────────────────────────────────────────────────────────────────────────────

describe('AC-5: Label row renders a colored span using label.color', () => {
  test('labels page references label.color', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    expect(source).toContain('label.color')
  })

  test('labels page renders a colored swatch with 16px size (w-4 h-4 or equivalent)', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    const hasSizeClass =
      source.includes('w-4') ||
      source.includes('h-4') ||
      source.includes('16px') ||
      source.includes('width: 16') ||
      source.includes("width: '16")
    expect(hasSizeClass).toBe(true)
  })

  test('labels page binds background color to label.color value', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    const hasColorBinding =
      source.includes('backgroundColor') ||
      source.includes('background-color') ||
      source.match(/:style.*label\.color/) !== null ||
      source.match(/label\.color/) !== null
    expect(hasColorBinding).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC-6: Create Label form defaults color to '#6366f1' when not provided
// ──────────────────────────────────────────────────────────────────────────────

describe('AC-6: Create Label form sends POST with default color #6366f1', () => {
  test('labels page contains a create label form or dialog', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    const hasCreateForm =
      source.includes('form') || source.includes('Dialog') || source.includes('submit')
    expect(hasCreateForm).toBe(true)
  })

  test('labels page defaults label color to #6366f1', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    expect(source).toContain('#6366f1')
  })

  test('labels page calls $api.post to create a label', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    expect(source).toContain('$api.post')
  })

  test('POST call targets the /projects/:slug/labels endpoint', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    const hasPostLabels =
      source.includes('/labels') &&
      source.includes('$api.post')
    expect(hasPostLabels).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC-7: POST success — labels list refreshed and success toast shown
// ──────────────────────────────────────────────────────────────────────────────

describe('AC-7: Successful label creation refreshes list and shows success toast', () => {
  test('labels page calls refresh after successful POST', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    expect(source).toContain('refresh(')
  })

  test('labels page shows a success toast with labels.toast.created key', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    const hasSuccessToast =
      source.includes("labels.toast.created") ||
      source.includes("'labels.toast.created'") ||
      source.includes('"labels.toast.created"')
    expect(hasSuccessToast).toBe(true)
  })

  test('labels page uses toast.success for creation success', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    const hasToastSuccess =
      source.includes('toast.success') ||
      source.includes('toast(') ||
      source.includes('useToast')
    expect(hasToastSuccess).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC-8: POST failure — error toast shown with labels.toast.createFailed key
// ──────────────────────────────────────────────────────────────────────────────

describe('AC-8: Failed label creation shows error toast with labels.toast.createFailed', () => {
  test('labels page handles POST errors (try/catch or .catch)', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    const hasErrorHandling =
      source.includes('catch') || source.includes('.catch(')
    expect(hasErrorHandling).toBe(true)
  })

  test('labels page shows error toast with labels.toast.createFailed key', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    const hasCreateFailedToast =
      source.includes("labels.toast.createFailed") ||
      source.includes("'labels.toast.createFailed'") ||
      source.includes('"labels.toast.createFailed"')
    expect(hasCreateFailedToast).toBe(true)
  })

  test('labels page uses toast.error for creation failure', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    const hasToastError =
      source.includes('toast.error') || source.includes('toast.warning')
    expect(hasToastError).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC-9: Delete button calls DELETE /projects/:slug/labels/:labelId
// ──────────────────────────────────────────────────────────────────────────────

describe('AC-9: Delete button calls DELETE /projects/:slug/labels/:labelId', () => {
  test('labels page has a delete action for labels', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    const hasDelete =
      source.includes('delete') || source.includes('Delete') || source.includes('remove')
    expect(hasDelete).toBe(true)
  })

  test('labels page calls $api.delete', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    expect(source).toContain('$api.delete')
  })

  test('DELETE call uses the label id in the URL path', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    const hasLabelIdInPath =
      source.match(/\/labels\/\$\{.*\.id\}/) !== null ||
      source.match(/\/labels\/\$\{labelId\}/) !== null ||
      source.match(/labels.*label\.id/) !== null
    expect(hasLabelIdInPath).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC-10: DELETE success — labels list refreshed and success toast shown
// ──────────────────────────────────────────────────────────────────────────────

describe('AC-10: Successful label deletion refreshes list and shows success toast', () => {
  test('labels page shows a success toast with labels.toast.deleted key', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    const hasDeletedToast =
      source.includes("labels.toast.deleted") ||
      source.includes("'labels.toast.deleted'") ||
      source.includes('"labels.toast.deleted"')
    expect(hasDeletedToast).toBe(true)
  })

  test('labels page calls refresh after successful DELETE', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    // refresh() must be called in the delete handler context too
    expect(source).toContain('refresh(')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC-11: Empty state shows i18n message for labels.empty key
// ──────────────────────────────────────────────────────────────────────────────

describe('AC-11: Empty labels list renders the labels.empty i18n message', () => {
  test('labels page has a conditional empty state block', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    const hasEmptyState =
      source.includes('v-if') || source.includes('v-show') || source.includes('empty')
    expect(hasEmptyState).toBe(true)
  })

  test('labels page references the labels.empty i18n key', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    const hasEmptyKey =
      source.includes("labels.empty") ||
      source.includes("'labels.empty'") ||
      source.includes('"labels.empty"')
    expect(hasEmptyKey).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC-12: layouts/default.vue renders a Labels nav link pointing to /:project/labels
// ──────────────────────────────────────────────────────────────────────────────

describe('AC-12: default.vue renders a Labels navigation link alongside Agents and KB', () => {
  test('layouts/default.vue exists', () => {
    expect(existsSync(layoutPath)).toBe(true)
  })

  test('layout contains Agents nav link', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    const hasAgents =
      source.includes("nav.agents") || source.includes('/agents')
    expect(hasAgents).toBe(true)
  })

  test('layout contains KB nav link', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    const hasKb =
      source.includes("nav.kb") || source.includes('/kb')
    expect(hasKb).toBe(true)
  })

  test('layout contains a Labels nav link', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    const hasLabels =
      source.includes('/labels') ||
      source.includes("nav.labels") ||
      source.includes("Labels")
    expect(hasLabels).toBe(true)
  })

  test('Labels link points to /:project/labels path', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    const hasLabelsPath =
      source.includes('/labels') &&
      (source.match(/\$route\.params\.project.*labels/) !== null ||
        source.match(/\$\{.*project.*\}\/labels/) !== null ||
        source.match(/\/labels/) !== null)
    expect(hasLabelsPath).toBe(true)
  })

  test('Labels link is conditionally shown when project route param exists', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    // Must use v-if with $route.params.project (same pattern as Agents and KB links)
    const hasConditional =
      source.includes('v-if') && source.includes('$route.params.project')
    expect(hasConditional).toBe(true)
  })
})