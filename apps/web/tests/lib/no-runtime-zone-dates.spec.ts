import { describe, expect, test } from '@jest/globals'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const webRoot = path.resolve(__dirname, '../..')
const productionDirectories = ['components', 'pages', 'layouts', 'composables', 'lib']
const runtimeZoneDate = /\.toLocale(Date|Time)?String\(/
const formatterImport = /(?:from\s*|import\s*)['"][^'"\n]*\/format-date-time['"]/

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(absolute)
    return entry.isFile() && /\.(?:vue|ts)$/.test(entry.name) ? [absolute] : []
  })
}

describe('runtime-zone date formatting boundary', () => {
  test('production source uses only the shared date formatter and local-dates import boundary', () => {
    const violations: string[] = []
    for (const directory of productionDirectories) {
      for (const file of sourceFiles(path.join(webRoot, directory))) {
        const relative = path.relative(webRoot, file).split(path.sep).join('/')
        const source = readFileSync(file, 'utf8')
        if (relative !== 'lib/format-date-time.ts' && runtimeZoneDate.test(source)) {
          violations.push(`${relative}: runtime-zone date formatting`)
        }
        if (relative !== 'lib/local-dates.ts' && formatterImport.test(source)) {
          violations.push(`${relative}: direct format-date-time import`)
        }
      }
    }
    expect(violations).toEqual([])
  })
})
