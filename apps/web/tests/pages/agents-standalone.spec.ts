import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const standaloneAgentsPagePath = join(webDir, 'pages', 'agents.vue')
const layoutPath = join(webDir, 'layouts', 'default.vue')

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — pages/agents.vue exists and fetches from GET /agents (no project slug)
// ──────────────────────────────────────────────────────────────────────────────

describe('US-001 AC1: pages/agents.vue fetches GET /agents with useAsyncData', () => {
  test('file is present at pages/agents.vue', () => {
    expect(existsSync(standaloneAgentsPagePath)).toBe(true)
  })

  test('source uses useAsyncData with key "agents"', () => {
    const source = readFileSync(standaloneAgentsPagePath, 'utf-8')
    expect(source).toContain('useAsyncData')
    expect(source).toMatch(/['"`]agents['"`]/)
  })

  test('source fetches $api.get("/agents") without project slug', () => {
    const source = readFileSync(standaloneAgentsPagePath, 'utf-8')
    expect(source).toContain('$api.get')
    // Should be /agents, NOT /projects/${slug}/agents
    expect(source).toMatch(/['"`]\/agents['"`]/)
    expect(source).not.toMatch(/['"`]\/projects\/\$\{[^}]+\}\/agents['"`]/)
  })

  test('source does NOT fetch from project-scoped endpoint', () => {
    const source = readFileSync(standaloneAgentsPagePath, 'utf-8')
    expect(source).not.toMatch(/\/projects\/\$\{[^}]+\}\/agents/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — changeStatus calls PATCH /agents/:slug (not project-scoped)
// ──────────────────────────────────────────────────────────────────────────────

describe('US-001 AC2: changeStatus calls PATCH /agents/:slug', () => {
  test('source has changeStatus function', () => {
    const source = readFileSync(standaloneAgentsPagePath, 'utf-8')
    expect(source).toContain('changeStatus')
  })

  test('source calls $api.patch with /agents/ and agent.slug', () => {
    const source = readFileSync(standaloneAgentsPagePath, 'utf-8')
    expect(source).toContain('$api.patch')
    expect(source).toMatch(/\/agents\/\$\{[^}]*\.slug[^}]*\}/)
  })

  test('source does NOT call PATCH with project-scoped endpoint', () => {
    const source = readFileSync(standaloneAgentsPagePath, 'utf-8')
    expect(source).not.toMatch(/\/projects\/\$\{[^}]+\}\/agents\/\$\{[^}]+\.id[^}]*\}/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — breadcrumbItems handles /agents route
// ──────────────────────────────────────────────────────────────────────────────

describe('US-001 AC3: breadcrumbItems handles /agents route', () => {
  test('source handles route.path === "/agents"', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toContain('route.path')
    expect(source).toMatch(/['"`]\/agents['"`]/)
  })

  test('source returns Koda breadcrumb followed by agents label for /agents route', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    // Should have breadcrumb case for /agents
    const hasAgentsBreadcrumb =
      source.includes("'/' ") && source.includes("t('nav.agents')") ||
      source.includes('to: "/"') && source.includes("t('nav.agents')")
    expect(hasAgentsBreadcrumb).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — Global /agents NuxtLink with Bot icon visible without project context
// ──────────────────────────────────────────────────────────────────────────────

describe('US-001 AC4: global /agents NuxtLink with Bot icon visible without project context', () => {
  test('source has a NuxtLink to="/agents" outside of project-scoped template', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toMatch(/to=['"`]\/agents['"`]/)
  })

  test('source uses Bot icon for the agents link', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toContain('Bot')
    // Bot icon should appear near the /agents link
    expect(source).toMatch(/Bot.*\/agents|\/agents.*Bot/)
  })

  test('agents link with Bot icon is NOT inside v-if/v-for for projectSlug', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    // Find the Bot icon occurrence and check if it's in project-scoped section
    // The Bot for agents should be in the always-visible nav section, not in <template v-if="projectSlug">
    const lines = source.split('\n')
    let botLineIndex = -1
    let projectSlugTemplateEndIndex = -1

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('Bot') && lines[i].includes('agents')) {
        botLineIndex = i
      }
      if (lines[i].includes('v-if="projectSlug"')) {
        projectSlugTemplateEndIndex = i
      }
    }

    // Bot icon should NOT be after projectSlug v-if template that closes
    if (projectSlugTemplateEndIndex !== -1 && botLineIndex !== -1) {
      expect(botLineIndex).toBeLessThan(projectSlugTemplateEndIndex)
    }
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC5 — the standalone page itself is not project-scoped.
// Repointed by issue #252: the layout now DOES carry a project-scoped roster
// link (pinned by tests/layouts/project-agents-nav.spec.ts), so this AC reads
// pages/agents.vue — the surface it was actually about.
// ──────────────────────────────────────────────────────────────────────────────

describe('US-001 AC5: pages/agents.vue is not project-scoped', () => {
  test('the standalone page does not use a project-scoped agents route', () => {
    const source = readFileSync(standaloneAgentsPagePath, 'utf-8')
    expect(source).not.toMatch(/\/\$\{[^}]+\}\/agents/)
  })

  test('the layout keeps the global /agents link alongside the project roster link', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toMatch(/to=['"`]\/agents['"`]/)
    expect(source).toContain(':to="`/${projectSlug}/agents`"')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Quality — no console.log
// ──────────────────────────────────────────────────────────────────────────────

describe('US-001: pages/agents.vue has no console.log statements', () => {
  test('source does not contain console.log', () => {
    const source = readFileSync(standaloneAgentsPagePath, 'utf-8')
    expect(source).not.toContain('console.log')
  })
})

describe('US-001: layouts/default.vue has no console.log statements', () => {
  test('source does not contain console.log', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).not.toContain('console.log')
  })
})
