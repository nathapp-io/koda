import { describe, test, expect } from '@jest/globals'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '..')
const targetDirs = [join(webDir, 'pages'), join(webDir, 'components')]
const bannedPattern = /import\s*\{\s*toast\s*\}\s*from\s*['"]vue-sonner['"]/m

function collectVueFiles(dirPath: string): string[] {
  const entries = readdirSync(dirPath, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectVueFiles(fullPath))
      continue
    }
    if (entry.isFile() && fullPath.endsWith('.vue')) {
      files.push(fullPath)
    }
  }

  return files
}

describe('toast import pattern', () => {
  test('pages and components do not directly import named toast from vue-sonner', () => {
    const offenders: string[] = []

    for (const dir of targetDirs) {
      const files = collectVueFiles(dir)
      for (const filePath of files) {
        const source = readFileSync(filePath, 'utf-8')
        if (bannedPattern.test(source)) {
          offenders.push(filePath.replace(`${webDir}/`, ''))
        }
      }
    }

    expect(offenders).toEqual([])
  })
})
