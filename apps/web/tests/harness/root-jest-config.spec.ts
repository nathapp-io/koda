import { describe, expect, test } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

/**
 * Pin for the repository-root jest entry point (`/jest.config.js`).
 *
 * The scoped quality gate resolves the monorepo orchestrator's cwd to the repository root and then runs a
 * package's scoped test command there, with absolute test paths (`bunx jest '/abs/apps/web/tests/x.spec.ts'
 * --forceExit --passWithNoTests`). Jest reads the config of the directory it starts in, so without a root
 * config that run used jest's defaults — babel-jest and no `~/…` alias — and every TypeScript spec died with
 * `SyntaxError: … Unexpected token, expected "from"` on its first `import type`. This spec keeps the root
 * config from being quietly deleted or narrowed: the web package's specs must stay a jest project there.
 *
 * The functional proof is the gate command itself (a root run over web specs is green); this test can only
 * assert the wiring, which is why it checks the declared project and not the transform.
 */
const webDir = join(__dirname, '../..')
const repoRoot = join(webDir, '..', '..')
const rootConfigPath = join(repoRoot, 'jest.config.js')

/** The root config is CommonJS; `require` is how jest itself loads it. */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const loadRootConfig = (): { projects?: string[] } => require(rootConfigPath)

describe('the repository-root jest config keeps the web package a jest project', () => {
  test('a root jest.config.js exists', () => {
    expect(existsSync(rootConfigPath)).toBe(true)
  })

  test('it declares apps/web as a project, so a root run uses the package ts-jest transform and ~/ alias', () => {
    expect(loadRootConfig().projects).toContain('<rootDir>/apps/web')
  })

  test('it declares only packages that actually configure jest (api is vitest, the runner is bun test)', () => {
    const projects = loadRootConfig().projects ?? []
    const declared = new Set(projects)
    expect(declared.has('<rootDir>/apps/web')).toBe(true)
    expect(declared.has('<rootDir>/apps/cli')).toBe(true)
    // A project entry without a jest config would make every root run fail on config validation.
    for (const project of projects) {
      const packageDir = join(repoRoot, project.replace('<rootDir>/', ''))
      expect(existsSync(join(packageDir, 'package.json'))).toBe(true)
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pkg = require(join(packageDir, 'package.json')) as { jest?: unknown }
      expect(pkg.jest).toBeDefined()
    }
    expect(readFileSync(rootConfigPath, 'utf-8')).toContain('apps/api')
  })
})
