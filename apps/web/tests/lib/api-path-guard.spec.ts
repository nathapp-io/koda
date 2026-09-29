import { describe, expect, it } from '@jest/globals'
import { readdirSync, readFileSync } from 'fs'
import { join, relative } from 'path'

const webDir = join(__dirname, '../..')

/** Directories whose API paths must go through apiPath. */
const GUARDED_DIRS = ['components', 'composables', 'pages']

const API_ROOT = String.raw`(?:api\/)?(?:projects|agents|comments|admin|code-intel)\/`
/** An API path written as an untagged template literal with an interpolation. */
const RAW_TEMPLATE = new RegExp(String.raw`(?<!apiPath)\`\/${API_ROOT}[^\`]*\$\{`)
/** An API path built by string concatenation. */
const CONCAT = new RegExp(String.raw`['"]\/${API_ROOT}['"]\s*\+`)
/** A value encoded by hand inside apiPath, which would be encoded twice. */
const DOUBLE_ENCODED = /apiPath`[^`]*encodeURIComponent\(/

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(vue|ts)$/.test(entry.name) && !entry.name.endsWith('.spec.ts') ? [path] : []
  })
}

function offenders(dirs: string[]): string[] {
  return dirs
    .flatMap((dir) => sourceFiles(join(webDir, dir)))
    .flatMap((file) =>
      readFileSync(file, 'utf-8')
        .split('\n')
        .flatMap((line, index) =>
          RAW_TEMPLATE.test(line) || CONCAT.test(line) || DOUBLE_ENCODED.test(line)
            ? [`${relative(webDir, file)}:${index + 1}: ${line.trim()}`]
            : [],
        ),
    )
}

describe('API paths go through apiPath', () => {
  it('the patterns catch what they are meant to catch', () => {
    expect(RAW_TEMPLATE.test('$api.get(`/projects/${slug}/labels`)')).toBe(true)
    expect(RAW_TEMPLATE.test('$api.get(apiPath`/projects/${slug}/labels`)')).toBe(false)
    expect(RAW_TEMPLATE.test('router.push(`/${slug}/tickets/${ref}`)')).toBe(false)
    expect(CONCAT.test("$api.delete('/agents/' + props.agent.slug)")).toBe(true)
    expect(DOUBLE_ENCODED.test('apiPath`/projects/${encodeURIComponent(slug)}`')).toBe(true)
  })

  it('no guarded file interpolates an API path by hand', () => {
    expect(offenders(GUARDED_DIRS)).toEqual([])
  })
})
