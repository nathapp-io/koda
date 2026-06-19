import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const componentPath = join(webDir, 'components', 'CreateAgentDialog.vue')

function getSource(): string {
  return readFileSync(componentPath, 'utf-8')
}

describe('CreateAgentDialog.vue exists', () => {
  test('file is present at components/CreateAgentDialog.vue', () => {
    expect(existsSync(componentPath)).toBe(true)
  })
})

describe('CreateAgentDialog: required props', () => {
  test('source defines an open prop', () => {
    const source = getSource()
    expect(source).toContain('open')
    expect(source).toMatch(/defineProps/)
  })

  test('open prop is typed as boolean', () => {
    const source = getSource()
    expect(source).toMatch(/open\s*:\s*boolean/)
  })
})

describe('CreateAgentDialog: emits', () => {
  test("source defines update:open emit", () => {
    const source = getSource()
    expect(source).toContain('defineEmits')
    expect(source).toContain('update:open')
  })

  test("source defines created emit", () => {
    const source = getSource()
    expect(source).toContain("'created'")
  })
})

describe('CreateAgentDialog: form validation with vee-validate', () => {
  test('source imports useForm from vee-validate', () => {
    const source = getSource()
    expect(source).toContain("import { useForm } from 'vee-validate'")
  })

  test('source imports toTypedSchema from @vee-validate/zod', () => {
    const source = getSource()
    expect(source).toContain("import { toTypedSchema } from '@vee-validate/zod'")
  })

  test('source imports zod', () => {
    const source = getSource()
    expect(source).toContain("from 'zod'")
  })

  test('source uses toTypedSchema with z.object', () => {
    const source = getSource()
    expect(source).toMatch(/toTypedSchema\s*\(\s*z\.object\s*\(/)
  })
})

describe('CreateAgentDialog: form fields', () => {
  test('source has name field with required validation', () => {
    const source = getSource()
    expect(source).toMatch(/FormField\s+name="name"/)
    expect(source).toMatch(/name\s*:\s*z\.string\(\)\.min\(1/)
  })

  test('source has slug field with regex pattern validation', () => {
    const source = getSource()
    expect(source).toMatch(/FormField\s+name="slug"/)
    expect(source).toContain("regex(/^[a-z0-9-]+$/")
  })

  test('source has roles field requiring at least one selection', () => {
    const source = getSource()
    expect(source).toMatch(/FormField\s+name="roles"/)
    expect(source).toContain('z.array(z.string()).min(1')
  })

  test('source has capabilities field as optional array', () => {
    const source = getSource()
    expect(source).toMatch(/FormField\s+name="capabilities"/)
    expect(source).toMatch(/capabilities:\s*z\.array\s*\(\s*z\.string\(\)\s*\)\s*\.default\s*\(\s*\[\s*\]\s*\)/)
  })

  test('source has maxConcurrentTickets field defaulting to 3', () => {
    const source = getSource()
    expect(source).toMatch(/FormField\s+name="maxConcurrentTickets"/)
    expect(source).toMatch(/maxConcurrentTickets:\s*z\.number\(\)[\s\S]*?\.default\s*\(\s*3\s*\)/)
  })
})

describe('CreateAgentDialog: slug auto-derivation', () => {
  test('source derives slug from name via a deriveSlug function', () => {
    const source = getSource()
    expect(source).toContain('deriveSlug')
  })

  test('deriveSlug converts to lowercase', () => {
    const source = getSource()
    expect(source).toContain('toLowerCase()')
  })

  test('deriveSlug replaces spaces with hyphens', () => {
    const source = getSource()
    expect(source).toMatch(/replace\s*\(\s*\/\\s\+\/g\s*,\s*['"]-['"]\s*\)/)
  })

  test('deriveSlug strips non-alphanumeric characters', () => {
    const source = getSource()
    expect(source).toContain('[^a-z0-9-]')
  })

  test('source watches name to auto-derive slug', () => {
    const source = getSource()
    expect(source).toContain('watch(')
    expect(source).toContain('values.name')
  })

  test('source respects manual slug edits via isSlugManuallyEdited flag', () => {
    const source = getSource()
    expect(source).toContain('isSlugManuallyEdited')
  })
})

describe('CreateAgentDialog: capabilities tag input', () => {
  test('source uses a capabilitiesTags ref for tag state', () => {
    const source = getSource()
    expect(source).toContain('capabilitiesTags')
  })

  test('source has addCapability function', () => {
    const source = getSource()
    expect(source).toContain('function addCapability(')
  })

  test('source has removeCapability function', () => {
    const source = getSource()
    expect(source).toContain('function removeCapability(')
  })

  test('source handles backspace to remove last tag', () => {
    const source = getSource()
    expect(source).toContain('handleBackspace')
  })
})

describe('CreateAgentDialog: uses AGENT_ROLES constant', () => {
  test('source imports AGENT_ROLES from lib/agent-roles', () => {
    const source = getSource()
    expect(source).toMatch(/import\s*\{\s*AGENT_ROLES\s*\}\s*from\s*['"]~\/lib\/agent-roles['"]/)
  })

  test('availableRoles is assigned from AGENT_ROLES', () => {
    const source = getSource()
    expect(source).toMatch(/availableRoles\s*=\s*AGENT_ROLES/)
  })
})

describe('CreateAgentDialog: API submission', () => {
  test('source uses $api.post to create an agent', () => {
    const source = getSource()
    expect(source).toMatch(/\$api\.post\s*\(\s*['"]\/agents['"]/)
  })

  test('source shows success toast after creation', () => {
    const source = getSource()
    expect(source).toContain('toast.success(')
    expect(source).toContain('agents.toast.created')
  })

  test('source shows error toast on failure', () => {
    const source = getSource()
    expect(source).toContain('toast.error(')
    expect(source).toContain('agents.toast.createFailed')
  })

  test('source wraps API call in try-catch', () => {
    const source = getSource()
    expect(source).toContain('try {')
    expect(source).toContain('catch')
  })
})

describe('CreateAgentDialog: API key reveal', () => {
  test('source stores returned apiKey in a ref', () => {
    const source = getSource()
    expect(source).toContain('apiKey')
    expect(source).toContain('ref(')
  })

  test('source shows a key-reveal view when apiKey is set', () => {
    const source = getSource()
    expect(source).toContain('v-if="apiKey"')
  })

  test('source has a copyToClipboard function', () => {
    const source = getSource()
    expect(source).toContain('copyToClipboard')
    expect(source).toContain('clipboard')
  })

  test('source has a handleDone function that resets state and emits created', () => {
    const source = getSource()
    expect(source).toContain('handleDone')
    expect(source).toContain("emit('created')")
  })
})

describe('CreateAgentDialog: no console.log', () => {
  test('source does not contain console.log', () => {
    const source = getSource()
    expect(source).not.toContain('console.log')
  })
})
