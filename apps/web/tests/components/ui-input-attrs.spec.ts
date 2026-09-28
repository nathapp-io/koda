import { describe, expect, it } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const source = readFileSync(join(__dirname, '../../components/ui/input/Input.vue'), 'utf-8')

describe('ui/input Input.vue attribute handling', () => {
  it('turns off automatic attribute inheritance', () => {
    expect(source).toMatch(/defineOptions\(\{ inheritAttrs: false \}\)/)
  })

  it('still strips model bindings and class from the forwarded attrs', () => {
    expect(source).toMatch(/class: _c, modelValue: _mv, 'onUpdate:modelValue': _up/)
    expect(source).toContain('v-bind="forwardedAttrs"')
  })

  it('still merges the caller class into the root class', () => {
    expect(source).toContain('$attrs.class')
  })
})
