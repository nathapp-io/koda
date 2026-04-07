import { describe, test, expect } from '@jest/globals'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '..', '..', '..', '..')
const cliDir = join(__dirname, '..', '..', '..', '..', '..', 'cli')
const ticketDetailPath = join(webDir, 'pages', '[project]', 'tickets', '[ref].vue')
const enI18nPath = join(webDir, 'i18n', 'locales', 'en.json')
const zhI18nPath = join(webDir, 'i18n', 'locales', 'zh.json')
const cliTicketCommandPath = join(cliDir, 'src', 'commands', 'ticket.ts')
const cliGeneratedIndexPath = join(cliDir, 'src', 'generated', 'index.ts')
const cliConfigPath = join(cliDir, 'src', 'config')

const GITHUB_PR_URL = 'https://github.com/owner/repo/pull/123'
const GITHUB_PR_EXTERNAL_REF = 'owner/repo#123'
const TEST_REF = 'KODA-42'
const PROJECT_SLUG = 'test-project'

jest.mock('chalk', () => {
  const mockChalk = {
    cyan: { bold: (str: string) => str },
    gray: (str: string) => str,
    green: (str: string) => str,
    red: (str: string) => str,
    yellow: (str: string) => str,
  }
  return mockChalk
})

const mockData: Record<string, string> = {}

const mockStore = {
  get: jest.fn((key: string) => mockData[key] || ''),
  set: jest.fn((key: string, value: string) => {
    mockData[key] = value
  }),
}

jest.mock('conf', () => {
  return jest.fn(() => mockStore)
})

jest.mock(join(cliDir, 'src', 'generated'), () => ({
  ticketsControllerCreate: jest.fn(),
  ticketsControllerFindAll: jest.fn(),
  ticketsControllerFindByRef: jest.fn(),
  ticketsControllerUpdate: jest.fn(),
  ticketsControllerSoftDelete: jest.fn(),
  ticketsControllerAssign: jest.fn(),
  ticketsControllerVerify: jest.fn(),
  ticketsControllerStart: jest.fn(),
  ticketsControllerFix: jest.fn(),
  ticketsControllerVerifyFix: jest.fn(),
  ticketsControllerClose: jest.fn(),
  ticketsControllerReject: jest.fn(),
  ticketLinksControllerCreate: jest.fn(),
  ticketLinksControllerFindAll: jest.fn(),
  ticketLinksControllerRemove: jest.fn(),
  labelsControllerAssignLabelFromHttp: jest.fn(),
  labelsControllerRemoveLabelFromHttp: jest.fn(),
  OpenAPI: { BASE: '', TOKEN: '' },
}))

jest.mock(join(cliDir, 'src', 'generated', 'core', 'OpenAPI'), () => ({
  OpenAPI: { BASE: '', TOKEN: '' },
}))

jest.mock(join(cliDir, 'src', 'config'), () => ({
  getConfig: jest.fn(() => ({
    apiKey: mockData.apiKey || '',
    apiUrl: mockData.apiUrl || '',
  })),
  setConfig: jest.fn(),
  validateApiKey: jest.fn((key: string) => key && key.length >= 10),
  maskApiKey: jest.fn((key: string) => {
    if (key.length <= 8) return '****'
    return key.substring(0, 4) + '*'.repeat(key.length - 8) + key.substring(key.length - 4)
  }),
  resolveContext: jest.fn(),
}))

const { Command } = require('commander')
const { ticketCommand } = require(join(cliDir, 'src', 'commands', 'ticket'))
const { ticketsControllerFindByRef } = require(join(cliDir, 'src', 'generated'))
const { resolveContext } = require(join(cliDir, 'src', 'config'))

describe('AC-1: Ticket detail page renders PR badge for github TicketLink', () => {
  test('ticket detail Vue file exists', () => {
    expect(existsSync(ticketDetailPath)).toBe(true)
  })

  test('ticket detail page contains anchor with pr-badge class for github links', () => {
    const source = readFileSync(ticketDetailPath, 'utf-8')
    const hasGithubLinkBadge = source.includes('pr-badge') || (source.includes('github') && source.includes('pull'))
    expect(hasGithubLinkBadge).toBe(true)
  })

  test('ticket detail page renders anchor href with github pull URL pattern', () => {
    const source = readFileSync(ticketDetailPath, 'utf-8')
    const hasPullUrlPattern = source.includes('github.com') && source.includes('/pull/')
    expect(hasPullUrlPattern).toBe(true)
  })

  test('ticket detail page displays PR number from externalRef', () => {
    const source = readFileSync(ticketDetailPath, 'utf-8')
    const hasExternalRefDisplay = source.includes('externalRef') || source.includes('pr-badge') || source.includes('PR')
    expect(hasExternalRefDisplay).toBe(true)
  })
})

describe('AC-2: Ticket activity timeline shows VCS_PR_CREATED entry', () => {
  test('ticket detail page or related component renders VCS_PR_CREATED activity', () => {
    const source = readFileSync(ticketDetailPath, 'utf-8')
    const hasVcsPrCreatedDisplay = source.includes('VCS_PR_CREATED') || source.includes('PR created')
    expect(hasVcsPrCreatedDisplay).toBe(true)
  })

  test('activity timeline displays PR description matching owner/repo#number pattern', () => {
    const source = readFileSync(ticketDetailPath, 'utf-8')
    const hasPrDescriptionPattern = source.includes('PR created') || source.includes('owner/repo')
    expect(hasPrDescriptionPattern).toBe(true)
  })
})

describe('AC-3: koda ticket show outputs Links section with PR info', () => {
  let program: any
  let consoleLogSpy: jest.SpyInstance
  let processExitSpy: jest.SpyInstance

  beforeEach(() => {
    program = new Command()
    ticketCommand(program)

    mockData.apiKey = 'sk-test-key123'
    mockData.apiUrl = 'http://localhost:3100/api'

    delete process.env.KODA_API_KEY
    delete process.env.KODA_API_URL

    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation()
    jest.spyOn(console, 'error').mockImplementation()
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never)

    jest.clearAllMocks()
    ;(ticketsControllerFindByRef as jest.Mock).mockReset()
    ;(resolveContext as jest.Mock).mockResolvedValue({
      projectSlug: PROJECT_SLUG,
      apiKey: 'sk-test-key123',
      apiUrl: 'http://localhost:3100/api',
    })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('ticket show outputs Links section when ticket has github PR link', async () => {
    const mockTicketWithLinks = {
      id: 'ticket-1',
      number: 42,
      ref: TEST_REF,
      type: 'BUG',
      title: 'Test ticket',
      status: 'VERIFIED',
      createdAt: new Date().toISOString(),
      links: [
        {
          id: 'link-1',
          url: GITHUB_PR_URL,
          provider: 'github',
          externalRef: GITHUB_PR_EXTERNAL_REF,
          createdAt: new Date().toISOString(),
        },
      ],
    }

    ;(ticketsControllerFindByRef as jest.Mock).mockResolvedValue({
      ret: 0,
      data: mockTicketWithLinks,
    })

    const ticketCmd = program.commands.find((cmd: any) => cmd.name() === 'ticket')
    const showCmd = ticketCmd?.commands.find((cmd: any) => cmd.name() === 'show')

    await showCmd?.parseAsync([
      'node', 'test',
      '--project', PROJECT_SLUG,
      TEST_REF,
    ])

    const output = consoleLogSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n')
    expect(output).toMatch(/Links?:/i)
    expect(output).toMatch(/https:\/\/github\.com\/\w+\/\w+\/pull\/\d+/)
    expect(output).toMatch(/PR.*#\d+|owner\/repo#\d+/)
    expect(processExitSpy).toHaveBeenCalledWith(0)
  })

  test('ticket show outputs PR externalRef in Links section', async () => {
    const mockTicketWithLinks = {
      id: 'ticket-1',
      number: 42,
      ref: TEST_REF,
      type: 'BUG',
      title: 'Test ticket',
      status: 'VERIFIED',
      createdAt: new Date().toISOString(),
      links: [
        {
          id: 'link-1',
          url: GITHUB_PR_URL,
          provider: 'github',
          externalRef: GITHUB_PR_EXTERNAL_REF,
          createdAt: new Date().toISOString(),
        },
      ],
    }

    ;(ticketsControllerFindByRef as jest.Mock).mockResolvedValue({
      ret: 0,
      data: mockTicketWithLinks,
    })

    const ticketCmd = program.commands.find((cmd: any) => cmd.name() === 'ticket')
    const showCmd = ticketCmd?.commands.find((cmd: any) => cmd.name() === 'show')

    await showCmd?.parseAsync([
      'node', 'test',
      '--project', PROJECT_SLUG,
      TEST_REF,
    ])

    const output = consoleLogSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n')
    expect(output).toMatch(/owner\/repo#\d+/)
    expect(processExitSpy).toHaveBeenCalledWith(0)
  })
})

describe('AC-4: koda ticket show --json returns links array with github PR', () => {
  let program: any
  let consoleLogSpy: jest.SpyInstance
  let processExitSpy: jest.SpyInstance

  beforeEach(() => {
    program = new Command()
    ticketCommand(program)

    mockData.apiKey = 'sk-test-key123'
    mockData.apiUrl = 'http://localhost:3100/api'

    delete process.env.KODA_API_KEY
    delete process.env.KODA_API_URL

    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation()
    jest.spyOn(console, 'error').mockImplementation()
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never)

    jest.clearAllMocks()
    ;(ticketsControllerFindByRef as jest.Mock).mockReset()
    ;(resolveContext as jest.Mock).mockResolvedValue({
      projectSlug: PROJECT_SLUG,
      apiKey: 'sk-test-key123',
      apiUrl: 'http://localhost:3100/api',
    })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('ticket show --json returns links array with provider=github and matching externalRef', async () => {
    const mockTicketWithLinks = {
      id: 'ticket-1',
      number: 42,
      ref: TEST_REF,
      type: 'BUG',
      title: 'Test ticket',
      status: 'VERIFIED',
      createdAt: new Date().toISOString(),
      links: [
        {
          id: 'link-1',
          url: GITHUB_PR_URL,
          provider: 'github',
          externalRef: GITHUB_PR_EXTERNAL_REF,
          createdAt: new Date().toISOString(),
        },
      ],
    }

    ;(ticketsControllerFindByRef as jest.Mock).mockResolvedValue({
      ret: 0,
      data: mockTicketWithLinks,
    })

    const ticketCmd = program.commands.find((cmd: any) => cmd.name() === 'ticket')
    const showCmd = ticketCmd?.commands.find((cmd: any) => cmd.name() === 'show')

    await showCmd?.parseAsync([
      'node', 'test',
      '--project', PROJECT_SLUG,
      '--json',
      TEST_REF,
    ])

    const output = consoleLogSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n')
    const parsed = JSON.parse(output)

    expect(parsed).toHaveProperty('links')
    expect(Array.isArray(parsed.links)).toBe(true)
    expect(parsed.links.length).toBeGreaterThanOrEqual(1)

    const githubLink = parsed.links.find((l: any) => l.provider === 'github')
    expect(githubLink).toBeDefined()
    expect(githubLink.externalRef).toMatch(/^\w+\/\w+#\d+$/)
    expect(githubLink.url).toMatch(/^https:\/\/github\.com\/\w+\/\w+\/pull\/\d+$/)
    expect(processExitSpy).toHaveBeenCalledWith(0)
  })

  test('ticket show --json returns links array matching pattern for owner/repo#number', async () => {
    const mockTicketWithLinks = {
      id: 'ticket-1',
      number: 42,
      ref: TEST_REF,
      type: 'BUG',
      title: 'Test ticket',
      status: 'VERIFIED',
      createdAt: new Date().toISOString(),
      links: [
        {
          id: 'link-1',
          url: 'https://github.com/my-org/my-repo/pull/456',
          provider: 'github',
          externalRef: 'my-org/my-repo#456',
          createdAt: new Date().toISOString(),
        },
      ],
    }

    ;(ticketsControllerFindByRef as jest.Mock).mockResolvedValue({
      ret: 0,
      data: mockTicketWithLinks,
    })

    const ticketCmd = program.commands.find((cmd: any) => cmd.name() === 'ticket')
    const showCmd = ticketCmd?.commands.find((cmd: any) => cmd.name() === 'show')

    await showCmd?.parseAsync([
      'node', 'test',
      '--project', PROJECT_SLUG,
      '--json',
      TEST_REF,
    ])

    const output = consoleLogSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n')
    const parsed = JSON.parse(output)

    expect(parsed.links).toBeDefined()
    expect(Array.isArray(parsed.links)).toBe(true)

    const githubLink = parsed.links.find((l: any) => l.provider === 'github' && l.externalRef)
    expect(githubLink).toBeDefined()
    expect(githubLink.externalRef).toMatch(/^(\w+\/\w+)#(\d+)$/)
    expect(processExitSpy).toHaveBeenCalledWith(0)
  })
})

describe('AC-5: i18n files contain PR-related keys', () => {
  test('en.json exists and contains pr-related keys', () => {
    expect(existsSync(enI18nPath)).toBe(true)
    const source = readFileSync(enI18nPath, 'utf-8')
    const i18n = JSON.parse(source)

    const hasPrKeys = Object.keys(i18n).some((section) => {
      const sectionKeys = Object.keys(i18n[section] || {})
      return sectionKeys.some((key) =>
        /^(pr|pull|github)/i.test(key)
      )
    })
    expect(hasPrKeys).toBe(true)
  })

  test('en.json contains pr-related keys matching patterns (pr.*, pull.*, github.*)', () => {
    const source = readFileSync(enI18nPath, 'utf-8')
    const i18n = JSON.parse(source)

    const allKeys: string[] = []
    function collectKeys(obj: any, prefix: string = '') {
      for (const key of Object.keys(obj || {})) {
        const fullKey = prefix ? `${prefix}.${key}` : key
        if (typeof obj[key] === 'object' && obj[key] !== null) {
          collectKeys(obj[key], fullKey)
        } else {
          allKeys.push(fullKey)
        }
      }
    }
    collectKeys(i18n)

    const prRelatedKeys = allKeys.filter((key) => /^(pr|pull|github)/i.test(key.split('.').pop() || ''))
    expect(prRelatedKeys.length).toBeGreaterThan(0)
  })

  test('zh.json exists and contains the same pr-related key set as en.json', () => {
    expect(existsSync(zhI18nPath)).toBe(true)
    const enSource = readFileSync(enI18nPath, 'utf-8')
    const zhSource = readFileSync(zhI18nPath, 'utf-8')
    const enI18n = JSON.parse(enSource)
    const zhI18n = JSON.parse(zhSource)

    const getPrRelatedKeys = (i18nObj: any, prefix: string = ''): string[] => {
      const keys: string[] = []
      for (const key of Object.keys(i18nObj || {})) {
        const fullKey = prefix ? `${prefix}.${key}` : key
        if (typeof i18nObj[key] === 'object' && i18nObj[key] !== null) {
          keys.push(...getPrRelatedKeys(i18nObj[key], fullKey))
        } else if (/^(pr|pull|github)/i.test(key)) {
          keys.push(fullKey)
        }
      }
      return keys
    }

    const enPrKeys = getPrRelatedKeys(enI18n)
    const zhPrKeys = getPrRelatedKeys(zhI18n)

    expect(enPrKeys.length).toBeGreaterThan(0)
    expect(zhPrKeys.length).toBeGreaterThan(0)
    expect(zhPrKeys.sort()).toEqual(enPrKeys.sort())
  })
})