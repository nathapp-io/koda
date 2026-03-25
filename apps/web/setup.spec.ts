import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { existsSync } from 'fs'
import { join } from 'path'

describe('US-001-1: Install npm dependencies and Shadcn components', () => {
  const webDir = __dirname
  const packageJsonPath = join(webDir, 'package.json')
  const componentNames = [
    'button',
    'card',
    'badge',
    'dialog',
    'input',
    'textarea',
    'select',
    'label',
    'form',
    'table',
    'separator',
    'avatar',
    'sonner',
    'dropdown-menu'
  ]

  test('dependencies: vee-validate @vee-validate/zod vue-sonner are installed in package.json', () => {
    const packageJsonContent = readFileSync(packageJsonPath, 'utf-8')
    const packageJson = JSON.parse(packageJsonContent)

    expect(packageJson.dependencies).toHaveProperty('vee-validate')
    expect(packageJson.dependencies).toHaveProperty('@vee-validate/zod')
    expect(packageJson.dependencies).toHaveProperty('vue-sonner')
  })

  test('shadcn components exist in components/ui/ directory', () => {
    const componentUiDir = join(webDir, 'components', 'ui')

    componentNames.forEach((componentName) => {
      const componentPath = join(componentUiDir, componentName)
      expect(existsSync(componentPath)).toBe(true)
    })
  })

  test('all 14 shadcn components have index files', () => {
    const componentUiDir = join(webDir, 'components', 'ui')

    componentNames.forEach((componentName) => {
      const indexPath = join(componentUiDir, componentName, 'index.ts')
      expect(existsSync(indexPath)).toBe(true)
    })
  })
})
