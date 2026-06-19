import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const componentPath = join(webDir, 'components', 'KbResultCard.vue')

function getSource(): string {
  return readFileSync(componentPath, 'utf-8')
}

describe('KbResultCard.vue exists', () => {
  test('file is present at components/KbResultCard.vue', () => {
    expect(existsSync(componentPath)).toBe(true)
  })
})

describe('KbResultCard: required props', () => {
  test('source defines required id prop', () => {
    const source = getSource()
    expect(source).toContain('id')
    expect(source).toMatch(/defineProps/)
  })

  test('source defines required source prop', () => {
    const source = getSource()
    expect(source).toContain('source')
  })

  test('source defines required sourceId prop', () => {
    const source = getSource()
    expect(source).toContain('sourceId')
  })

  test('source defines required content prop', () => {
    const source = getSource()
    expect(source).toContain('content')
  })

  test('source defines required score prop as number', () => {
    const source = getSource()
    expect(source).toContain('score')
    expect(source).toMatch(/score\s*:\s*number/)
  })

  test('source defines required similarity prop with union type', () => {
    const source = getSource()
    expect(source).toContain('similarity')
    expect(source).toContain('high')
    expect(source).toContain('medium')
    expect(source).toContain('low')
  })

  test('source defines required createdAt prop as string', () => {
    const source = getSource()
    expect(source).toContain('createdAt')
    expect(source).toMatch(/createdAt\s*:\s*string/)
  })
})

describe('KbResultCard: similarity config', () => {
  test('source defines a similarityConfig object', () => {
    const source = getSource()
    expect(source).toContain('similarityConfig')
  })

  test('similarityConfig has a high entry with label HIGH', () => {
    const source = getSource()
    expect(source).toContain("label: 'HIGH'")
  })

  test('similarityConfig has a medium entry with label MED', () => {
    const source = getSource()
    expect(source).toContain("label: 'MED'")
  })

  test('similarityConfig has a low entry with label LOW', () => {
    const source = getSource()
    expect(source).toContain("label: 'LOW'")
  })
})

describe('KbResultCard: renders score and similarity', () => {
  test('source renders score with toFixed(2)', () => {
    const source = getSource()
    expect(source).toContain('score.toFixed(2)')
  })

  test('source applies similarity-specific CSS classes', () => {
    const source = getSource()
    expect(source).toContain('similarityConfig[similarity]')
  })
})

describe('KbResultCard: renders content', () => {
  test('source renders sourceId in the template', () => {
    const source = getSource()
    expect(source).toContain('{{ sourceId }}')
  })

  test('source renders content snippet in the template', () => {
    const source = getSource()
    expect(source).toContain('{{ content }}')
  })

  test('source applies line-clamp-2 to truncate content snippet', () => {
    const source = getSource()
    expect(source).toContain('line-clamp-2')
  })
})

describe('KbResultCard: renders meta information', () => {
  test('source renders source badge', () => {
    const source = getSource()
    expect(source).toContain('{{ source }}')
  })

  test('source formats createdAt as a localized date', () => {
    const source = getSource()
    expect(source).toContain('createdAt')
    expect(source).toContain('toLocaleDateString()')
  })
})

describe('KbResultCard: no console.log', () => {
  test('source does not contain console.log', () => {
    const source = getSource()
    expect(source).not.toContain('console.log')
  })
})
