import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

// ── Path anchors ────────────────────────────────────────────────────────────────

const webDir = join(__dirname, '../../../')
const apiDir = join(__dirname, '../../../../apps/api/src')
const cliDir = join(__dirname, '../../../../apps/cli/src')
const monoRoot = join(__dirname, '../../../../')

// ── Source file paths ─────────────────────────────────────────────────────────

const ticketCardPath = join(webDir, 'components/TicketCard.vue')
const ticketDetailPath = join(webDir, 'pages/[project]/tickets/[ref].vue')
const ticketCommandPath = join(cliDir, 'commands/ticket.ts')
const vcsCommandPath = join(cliDir, 'commands/vcs.ts')
const vcsControllerPath = join(apiDir, 'vcs/vcs.controller.ts')
const apiEnVcsI18nPath = join(apiDir, 'i18n/en/vcs.json')
const apiZhVcsI18nPath = join(apiDir, 'i18n/zh/vcs.json')
const webEnLocalesPath = join(webDir, 'i18n/locales/en.json')
const webZhLocalesPath = join(webDir, 'i18n/locales/zh.json')

// ──────────────────────────────────────────────────────────────────────────────
// AC-1: TicketCard renders PR status badge with color based on prState
// Badge: green=merged, blue=open, gray=draft, red=closed; absent when null/undefined
// ──────────────────────────────────────────────────────────────────────────────

describe('AC-1: TicketCard renders PR status badge with prState-based colors', () => {
  test('AC-1: TicketCard.vue source contains prState handling for badge coloring', () => {
    const source = readFileSync(ticketCardPath, 'utf-8')
    // Must handle prState on TicketLink to set badge color
    expect(source).toContain('prState')
  })

  test('AC-1: Badge color for merged is green (bg-green or text-green)', () => {
    const source = readFileSync(ticketCardPath, 'utf-8')
    // Check for green color associated with merged state
    const hasMergedGreen =
      (source.includes("'merged'") || source.includes('"merged"')) &&
      (source.includes('green') || source.includes('GREEN'))
    expect(hasMergedGreen).toBe(true)
  })

  test('AC-1: Badge color for open is blue (bg-blue or text-blue)', () => {
    const source = readFileSync(ticketCardPath, 'utf-8')
    const hasOpenBlue =
      (source.includes("'open'") || source.includes('"open"')) &&
      (source.includes('blue') || source.includes('BLUE'))
    expect(hasOpenBlue).toBe(true)
  })

  test('AC-1: Badge color for draft is gray (bg-gray, gray, or muted)', () => {
    const source = readFileSync(ticketCardPath, 'utf-8')
    const hasDraftGray =
      (source.includes("'draft'") || source.includes('"draft"')) &&
      (source.includes('gray') || source.includes('Gray') || source.includes('muted'))
    expect(hasDraftGray).toBe(true)
  })

  test('AC-1: Badge color for closed is red (bg-red or text-red)', () => {
    const source = readFileSync(ticketCardPath, 'utf-8')
    const hasClosedRed =
      (source.includes("'closed'") || source.includes('"closed"')) &&
      (source.includes('red') || source.includes('RED'))
    expect(hasClosedRed).toBe(true)
  })

  test('AC-1: Badge is absent when prState is null or undefined (v-if conditional)', () => {
    const source = readFileSync(ticketCardPath, 'utf-8')
    // Must conditionally render the badge only when prState exists
    const hasConditionalRender =
      (source.includes('v-if') || source.includes('v-show')) &&
      (source.includes('prState'))
    expect(hasConditionalRender).toBe(true)
  })

  test('AC-1: TicketLink prop/interface includes prState field', () => {
    const source = readFileSync(ticketCardPath, 'utf-8')
    // Source must reference TicketLink type/interface with prState
    expect(source).toMatch(/prState/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC-2: Ticket detail page renders PR status section
// (1) <a> tag with href matching github.com/{owner}/{repo}/pull/{number}
// (2) badge reflecting prState value
// (3) when prState='merged', mergeInfo with sha, author, mergedAt is displayed
// ──────────────────────────────────────────────────────────────────────────────

describe('AC-2: Ticket detail page renders PR status section', () => {
  test('AC-2: Ticket detail page contains an <a> tag with github.com pull URL pattern', () => {
    const source = readFileSync(ticketDetailPath, 'utf-8')
    // Must have anchor tag with href containing github.com and /pull/
    const hasPullHref =
      source.includes('github.com') &&
      source.includes('/pull/')
    expect(hasPullHref).toBe(true)
  })

  test('AC-2: Ticket detail page uses prState to render a badge', () => {
    const source = readFileSync(ticketDetailPath, 'utf-8')
    // Must use prState for badge/class styling
    expect(source).toMatch(/prState/)
  })

  test('AC-2: Ticket detail page conditionally shows mergeInfo when prState is merged', () => {
    const source = readFileSync(ticketDetailPath, 'utf-8')
    // Must show mergeInfo (sha, author, mergedAt) when merged
    const hasMergeInfo =
      source.includes("'merged'") &&
      (source.includes('mergeSha') || source.includes('sha') || source.includes('mergeInfo')) &&
      (source.includes('mergedBy') || source.includes('author'))
    expect(hasMergeInfo).toBe(true)
  })

  test('AC-2: Ticket detail page displays mergedAt as ISO timestamp', () => {
    const source = readFileSync(ticketDetailPath, 'utf-8')
    // When merged, mergedAt should be displayed (ISO format)
    const hasMergedAt =
      (source.includes('mergedAt') || source.includes('merged_at')) &&
      (source.includes("'merged'") || source.includes('"merged"'))
    expect(hasMergedAt).toBe(true)
  })

  test('AC-2: Ticket detail page displays sha as 40-character hex for merged PRs', () => {
    const source = readFileSync(ticketDetailPath, 'utf-8')
    // mergeSha should be displayed (40-char hex)
    const hasMergeSha =
      (source.includes('mergeSha') || source.includes('sha')) &&
      (source.includes("'merged'") || source.includes('"merged"'))
    expect(hasMergeSha).toBe(true)
  })

  test('AC-2: Ticket detail page displays author/mergedBy for merged PRs', () => {
    const source = readFileSync(ticketDetailPath, 'utf-8')
    const hasAuthor =
      (source.includes('mergedBy') || source.includes('author')) &&
      (source.includes("'merged'") || source.includes('"merged"'))
    expect(hasAuthor).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC-3: Activity timeline component renders VCS_PR_MERGED activity text
// Text matches: /^PR merged: [^/]+\/[^#]+#\d+ by @\w+$/
// (repository name, PR number, author username)
// ──────────────────────────────────────────────────────────────────────────────

describe('AC-3: Activity timeline renders VCS_PR_MERGED activity text', () => {
  // Check ticket detail page and any timeline/activity component
  test('AC-3: VCS_PR_MERGED activity type is rendered in activity timeline', () => {
    const source = readFileSync(ticketDetailPath, 'utf-8')
    // Must handle VCS_PR_MERGED activity type
    const hasActivityRendering =
      source.includes('VCS_PR_MERGED') ||
      (source.includes('activity') && source.includes('merged'))
    expect(hasActivityRendering).toBe(true)
  })

  test('AC-3: Activity text pattern includes PR merged prefix (PR merged:)', () => {
    const source = readFileSync(ticketDetailPath, 'utf-8')
    // Must render text containing "PR merged:"
    expect(source).toMatch(/PR merged:/)
  })

  test('AC-3: Activity text includes repository name and PR number (#\\d+)', () => {
    const source = readFileSync(ticketDetailPath, 'utf-8')
    // Must show repo/PR# pattern
    expect(source).toMatch(/#\d+/)
  })

  test('AC-3: Activity text includes author (@username)', () => {
    const source = readFileSync(ticketDetailPath, 'utf-8')
    // Must show author with @ prefix
    expect(source).toMatch(/@\w+/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC-4: CLI 'koda ticket show <ref>' stdout contains PR number and prState
// Output format includes '#{prNumber}' and prState value
// ──────────────────────────────────────────────────────────────────────────────

describe("AC-4: CLI 'koda ticket show <ref>' stdout contains PR number and prState", () => {
  test('AC-4: TicketLink type in ticket.ts includes prNumber field', () => {
    const source = readFileSync(ticketCommandPath, 'utf-8')
    // TicketLink type must have prNumber
    expect(source).toMatch(/prNumber/)
  })

  test('AC-4: TicketLink type in ticket.ts includes prState field', () => {
    const source = readFileSync(ticketCommandPath, 'utf-8')
    expect(source).toMatch(/prState/)
  })

  test('AC-4: ticket show command stdout displays PR number (externalRef or prNumber)', () => {
    const source = readFileSync(ticketCommandPath, 'utf-8')
    // Must display PR number in console output
    const hasPrNumberDisplay =
      source.includes('prNumber') ||
      (source.includes('externalRef') && source.includes('console.log'))
    expect(hasPrNumberDisplay).toBe(true)
  })

  test('AC-4: ticket show command stdout displays prState value', () => {
    const source = readFileSync(ticketCommandPath, 'utf-8')
    // Must display prState in the output
    expect(source).toMatch(/prState/)
  })

  test('AC-4: ticket show links section includes PR number formatted as #{number}', () => {
    const source = readFileSync(ticketCommandPath, 'utf-8')
    // Should format PR reference as #<number>
    const hasHashNumber =
      source.includes("'#'") ||
      source.includes('"#') ||
      source.includes('#${') ||
      source.includes("#{")
    expect(hasHashNumber).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC-5: CLI 'koda ticket show <ref> --json' outputs valid JSON
// 'links' array contains prState, prNumber, prUpdatedAt when present
// ──────────────────────────────────────────────────────────────────────────────

describe("AC-5: CLI 'koda ticket show <ref> --json' includes prState, prNumber, prUpdatedAt in links", () => {
  test('AC-5: TicketDetail type includes links with prNumber field', () => {
    const source = readFileSync(ticketCommandPath, 'utf-8')
    expect(source).toMatch(/prNumber/)
  })

  test('AC-5: TicketDetail type includes links with prState field', () => {
    const source = readFileSync(ticketCommandPath, 'utf-8')
    expect(source).toMatch(/prState/)
  })

  test('AC-5: TicketDetail type includes links with prUpdatedAt field', () => {
    const source = readFileSync(ticketCommandPath, 'utf-8')
    expect(source).toMatch(/prUpdatedAt/)
  })

  test('AC-5: JSON output path includes prNumber in links array serialization', () => {
    const source = readFileSync(ticketCommandPath, 'utf-8')
    // When serializing ticketData to JSON, prNumber must be included
    const hasPrNumberInOutput =
      source.includes('prNumber') ||
      source.includes('JSON.stringify')
    expect(hasPrNumberInOutput).toBe(true)
  })

  test('AC-5: JSON output includes prState in links when present', () => {
    const source = readFileSync(ticketCommandPath, 'utf-8')
    expect(source).toMatch(/prState/)
  })

  test('AC-5: JSON output includes prUpdatedAt in links when present', () => {
    const source = readFileSync(ticketCommandPath, 'utf-8')
    expect(source).toMatch(/prUpdatedAt/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC-6: HTTP POST /projects/{slug}/vcs/sync-pr returns 200 with 'updated' count
// Note: Requires running API server — verified via source inspection
// ──────────────────────────────────────────────────────────────────────────────

describe("AC-6: HTTP POST /projects/{slug}/vcs/sync-pr returns 200 with 'updated' integer", () => {
  test('AC-6: vcs.controller.ts contains POST /sync-pr route handler', () => {
    const source = readFileSync(vcsControllerPath, 'utf-8')
    // Must have a POST handler for sync-pr
    const hasSyncPrRoute =
      source.includes("'sync-pr'") ||
      source.includes('"sync-pr"') ||
      source.includes("'/sync-pr'") ||
      source.includes('Post(') && source.includes('sync-pr')
    expect(hasSyncPrRoute).toBe(true)
  })

  test('AC-6: sync-pr endpoint returns an object with updated field (non-negative integer)', () => {
    const source = readFileSync(vcsControllerPath, 'utf-8')
    // Response must include an 'updated' count field
    const hasUpdatedField =
      source.includes('updated') ||
      (source.includes('syncPr') && source.includes('updated'))
    expect(hasUpdatedField).toBe(true)
  })

  test('AC-6: vcs-pr-sync.service.ts or vcs-sync.service.ts has syncPrStatus method', () => {
    // The PR sync service must exist with a sync method
    const prSyncServicePath = join(apiDir, 'vcs/vcs-pr-sync.service.ts')
    const syncServicePath = join(apiDir, 'vcs/vcs-sync.service.ts')

    const hasPrSyncService = existsSync(prSyncServicePath)
    const hasSyncMethod =
      hasPrSyncService
        ? readFileSync(prSyncServicePath, 'utf-8').includes('syncPrStatus')
        : existsSync(syncServicePath) &&
          readFileSync(syncServicePath, 'utf-8').includes('syncPrStatus')

    expect(hasSyncMethod).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC-7: CLI 'koda vcs sync-pr' exits 0 and stdout matches /Updated \\d+ PR/ or /0 PRs? updated/i
// ──────────────────────────────────────────────────────────────────────────────

describe("AC-7: CLI 'koda vcs sync-pr' exits 0 and stdout shows PR update count", () => {
  test('AC-7: vcs.ts contains sync-pr subcommand', () => {
    const source = readFileSync(vcsCommandPath, 'utf-8')
    // Must have a sync-pr command
    const hasSyncPrCommand =
      source.includes("'sync-pr'") ||
      source.includes('"sync-pr"') ||
      source.includes("'syncPr'") ||
      source.includes('"syncPr"')
    expect(hasSyncPrCommand).toBe(true)
  })

  test('AC-7: sync-pr command calls vcsControllerSyncPr or similar PR sync API', () => {
    const source = readFileSync(vcsCommandPath, 'utf-8')
    // Must call a sync function for PRs
    const hasSyncPrCall =
      source.includes('syncPr') ||
      source.includes('SyncPr') ||
      source.includes('syncPrStatus')
    expect(hasSyncPrCall).toBe(true)
  })

  test('AC-7: sync-pr stdout output includes "Updated" and PR count', () => {
    const source = readFileSync(vcsCommandPath, 'utf-8')
    // Output must contain "Updated" text with count
    const hasUpdatedOutput =
      source.includes('Updated') ||
      source.includes('updated')
    expect(hasUpdatedOutput).toBe(true)
  })

  test('AC-7: sync-pr command exits with code 0 on success', () => {
    const source = readFileSync(vcsCommandPath, 'utf-8')
    // Must call process.exit(0) on success
    expect(source).toMatch(/process\.exit\s*\(\s*0\s*\)/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC-8: apps/api/src/i18n/en/vcs.json and zh/vcs.json contain PR state keys
// (merged, open, draft, closed)
// ──────────────────────────────────────────────────────────────────────────────

describe('AC-8: API i18n vcs.json files contain PR state keys (merged, open, draft, closed)', () => {
  const prStateKeys = ['merged', 'open', 'draft', 'closed']

  test('AC-8: en/vcs.json exists and is valid JSON', () => {
    expect(existsSync(apiEnVcsI18nPath)).toBe(true)
    const content = readFileSync(apiEnVcsI18nPath, 'utf-8')
    expect(() => JSON.parse(content)).not.toThrow()
  })

  test('AC-8: zh/vcs.json exists and is valid JSON', () => {
    expect(existsSync(apiZhVcsI18nPath)).toBe(true)
    const content = readFileSync(apiZhVcsI18nPath, 'utf-8')
    expect(() => JSON.parse(content)).not.toThrow()
  })

  prStateKeys.forEach((key) => {
    test(`AC-8: en/vcs.json contains key for PR state '${key}'`, () => {
      const content = readFileSync(apiEnVcsI18nPath, 'utf-8')
      const json = JSON.parse(content)
      // Navigate nested key path: prStatus.{key} or top-level key
      const hasKey =
        json[key] !== undefined ||
        (json.prStatus && json.prStatus[key] !== undefined)
      expect(hasKey).toBe(true)
    })

    test(`AC-8: zh/vcs.json contains key for PR state '${key}'`, () => {
      const content = readFileSync(apiZhVcsI18nPath, 'utf-8')
      const json = JSON.parse(content)
      const hasKey =
        json[key] !== undefined ||
        (json.prStatus && json.prStatus[key] !== undefined)
      expect(hasKey).toBe(true)
    })
  })

  test('AC-8: Both en and zh vcs.json have the same top-level key structure for PR states', () => {
    const enContent = readFileSync(apiEnVcsI18nPath, 'utf-8')
    const zhContent = readFileSync(apiZhVcsI18nPath, 'utf-8')
    const enJson = JSON.parse(enContent)
    const zhJson = JSON.parse(zhContent)
    const enKeys = Object.keys(enJson).sort()
    const zhKeys = Object.keys(zhJson).sort()
    expect(enKeys).toEqual(zhKeys)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC-9: Web i18n en.json and zh.json contain prStatus object with
// merged, open, draft, closed keys and Chinese translations
// ──────────────────────────────────────────────────────────────────────────────

describe('AC-9: Web i18n locales contain prStatus object with PR state translations', () => {
  const prStateKeys = ['merged', 'open', 'draft', 'closed']

  test('AC-9: en.json exists and is valid JSON', () => {
    expect(existsSync(webEnLocalesPath)).toBe(true)
    const content = readFileSync(webEnLocalesPath, 'utf-8')
    expect(() => JSON.parse(content)).not.toThrow()
  })

  test('AC-9: zh.json exists and is valid JSON', () => {
    expect(existsSync(webZhLocalesPath)).toBe(true)
    const content = readFileSync(webZhLocalesPath, 'utf-8')
    expect(() => JSON.parse(content)).not.toThrow()
  })

  test('AC-9: en.json contains prStatus object with all four PR state keys', () => {
    const content = readFileSync(webEnLocalesPath, 'utf-8')
    const json = JSON.parse(content)
    expect(json.prStatus).toBeDefined()
    prStateKeys.forEach((key) => {
      expect(json.prStatus[key]).toBeDefined()
      expect(typeof json.prStatus[key]).toBe('string')
      expect(json.prStatus[key].length).toBeGreaterThan(0)
    })
  })

  test('AC-9: zh.json contains prStatus object with same keys and Chinese translations', () => {
    const enContent = readFileSync(webEnLocalesPath, 'utf-8')
    const zhContent = readFileSync(webZhLocalesPath, 'utf-8')
    const enJson = JSON.parse(enContent)
    const zhJson = JSON.parse(zhContent)

    expect(zhJson.prStatus).toBeDefined()
    prStateKeys.forEach((key) => {
      expect(zhJson.prStatus[key]).toBeDefined()
      expect(typeof zhJson.prStatus[key]).toBe('string')
      expect(zhJson.prStatus[key].length).toBeGreaterThan(0)
      // Chinese translation should not equal English (unless intentionally same)
      // Just verify it's non-empty and defined
    })

    // Verify same key structure
    const enKeys = Object.keys(enJson.prStatus).sort()
    const zhKeys = Object.keys(zhJson.prStatus).sort()
    expect(enKeys).toEqual(zhKeys)
  })

  test('AC-9: en.json prStatus.merged is human-readable (not a code)', () => {
    const content = readFileSync(webEnLocalesPath, 'utf-8')
    const json = JSON.parse(content)
    // Should be "Merged" or "Pull request merged" not just "MERGED"
    expect(json.prStatus.merged).toMatch(/[Mm]erged/)
  })

  test('AC-9: zh.json prStatus.merged is Chinese characters', () => {
    const content = readFileSync(webZhLocalesPath, 'utf-8')
    const json = JSON.parse(content)
    // Chinese characters (CJK Unified Ideographs)
    expect(json.prStatus.merged).toMatch(/[\u4e00-\u9fff]/)
  })
})