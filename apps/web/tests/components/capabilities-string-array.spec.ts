import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const createDialogPath = join(webDir, 'components', 'CreateAgentDialog.vue')
const editDialogPath = join(webDir, 'components', 'EditAgentCapabilitiesDialog.vue')

function getCreateDialogSource(): string {
  return readFileSync(createDialogPath, 'utf-8')
}

function getEditDialogSource(): string {
  return readFileSync(editDialogPath, 'utf-8')
}

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — CreateAgentDialog: capabilities field in zod schema is z.array(z.string()).default([])
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002 AC1: CreateAgentDialog capabilities field uses z.array(z.string()).default([]) in zod schema', () => {
  test('source defines capabilities as z.array(z.string()) in the schema', () => {
    const source = getCreateDialogSource()
    const hasArraySchema = source.match(/capabilities:\s*z\.array\s*\(\s*z\.string\s*\(\s*\)\s*\)/)
    expect(hasArraySchema).not.toBeNull()
  })

  test('source defines capabilities with .default([]) in the schema', () => {
    const source = getCreateDialogSource()
    const hasDefaultEmptyArray = source.match(/capabilities:\s*z\.array\s*\([^)]*\)\s*\.default\s*\(\s*\[\s*\]\s*\)/)
    expect(hasDefaultEmptyArray).not.toBeNull()
  })

  test('source does NOT use z.string().optional() for capabilities', () => {
    const source = getCreateDialogSource()
    const hasStringOptional = source.match(/capabilities:\s*z\.string\(\)\s*\.optional\s*\(\s*\)/)
    expect(hasStringOptional).toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — CreateAgentDialog: no hidden input workaround for capabilities
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002 AC1: CreateAgentDialog removes hidden input workaround for capabilities', () => {
  test('source does NOT contain a hidden input for capabilities', () => {
    const source = getCreateDialogSource()
    const hasHiddenInput = source.match(/<input[^>]*type=["']hidden["'][^>]*>/)
    expect(hasHiddenInput).toBeNull()
  })

  test('source does NOT join capabilitiesTags with comma in setFieldValue', () => {
    const source = getCreateDialogSource()
    const hasJoinComma = source.match(/setFieldValue\s*\(\s*['"]capabilities['"]\s*,\s*[^)]*\.join\s*\(\s*['],[^)]*\)/)
    expect(hasJoinComma).toBeNull()
  })

  test('source sets capabilities field value directly with the tags array', () => {
    const source = getCreateDialogSource()
    const setsWithTags = source.match(/setFieldValue\s*\(\s*['"]capabilities['"]\s*,\s*tags\s*\)/)
    expect(setsWithTags).not.toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — CreateAgentDialog: initialValues.capabilities is []
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002 AC1: CreateAgentDialog initialValues.capabilities is []', () => {
  test('source has initialValues with capabilities: []', () => {
    const source = getCreateDialogSource()
    const hasEmptyArrayInit = source.match(/initialValues:\s*\{[^}]*capabilities:\s*\[\s*\][^}]*\}/s)
    expect(hasEmptyArrayInit).not.toBeNull()
  })

  test('source does NOT have initialValues with capabilities: empty string', () => {
    const source = getCreateDialogSource()
    const hasEmptyStringInit = source.match(/initialValues:[^}]*capabilities:\s*['""][\s]*['""]/s)
    expect(hasEmptyStringInit).toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — CreateAgentDialog: onSubmit passes string array to $api.post
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002 AC1: CreateAgentDialog onSubmit passes string array to $api.post for capabilities', () => {
  test('source calls $api.post with formValues that include capabilities array', () => {
    const source = getCreateDialogSource()
    const hasPostCall = source.match(/\$api\.post\s*\(\s*['"]\/agents['"]\s*,\s*formValues/)
    expect(hasPostCall).not.toBeNull()
  })

  test('source does NOT cast capabilities to comma-joined string before submit', () => {
    const source = getCreateDialogSource()
    const hasCommaJoinInSubmit = source.match(/formValues.*capabilities.*\.join\s*\(\s*['"],[\s]*['"]/)
    expect(hasCommaJoinInSubmit).toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — CreateAgentDialog: empty capabilities submits []
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002 AC2: CreateAgentDialog with no capability tags submits capabilities: []', () => {
  test('capabilitiesTags starts as empty array ref', () => {
    const source = getCreateDialogSource()
    const hasEmptyArrayRef = source.match(/capabilitiesTags\s*=\s*ref\s*\(\s*\[\s*\]\s*\)/)
    expect(hasEmptyArrayRef).not.toBeNull()
  })

  test('watcher syncs empty capabilitiesTags to empty array in form field', () => {
    const source = getCreateDialogSource()
    const hasWatcherWithTags = source.match(/watch\s*\(\s*capabilitiesTags[\s\S]*?setFieldValue\s*\(\s*['"]capabilities['"]\s*,\s*tags\s*\)/)
    expect(hasWatcherWithTags).not.toBeNull()
  })

  test('clearCapabilitiesTags resets to empty array when dialog closes', () => {
    const source = getCreateDialogSource()
    const clearsOnClose = source.match(/capabilitiesTags\s*\.\s*value\s*=\s*\[\s*\]/)
    expect(clearsOnClose).not.toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — EditAgentCapabilitiesDialog: zod schema uses z.array(z.string()).default([])
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002 AC3: EditAgentCapabilitiesDialog capabilities field uses z.array(z.string()).default([]) in zod schema', () => {
  test('source defines capabilities as z.array(z.string()) in the schema', () => {
    const source = getEditDialogSource()
    const hasArraySchema = source.match(/capabilities:\s*z\.array\s*\(\s*z\.string\s*\(\s*\)\s*\)/)
    expect(hasArraySchema).not.toBeNull()
  })

  test('source defines capabilities with .default([]) in the schema', () => {
    const source = getEditDialogSource()
    const hasDefaultEmptyArray = source.match(/capabilities:\s*z\.array\s*\([^)]*\)\s*\.default\s*\(\s*\[\s*\]\s*\)/)
    expect(hasDefaultEmptyArray).not.toBeNull()
  })

  test('source does NOT use z.string().optional() for capabilities', () => {
    const source = getEditDialogSource()
    const hasStringOptional = source.match(/capabilities:\s*z\.string\(\)\s*\.optional\s*\(\s*\)/)
    expect(hasStringOptional).toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — EditAgentCapabilitiesDialog: v-bind="componentField" is NOT on visible Input
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002 AC3: EditAgentCapabilitiesDialog Input does not v-bind componentField', () => {
  test('source does NOT have v-bind="componentField" on the capability tag Input', () => {
    const source = getEditDialogSource()
    const inputBindMatch = source.match(/<Input[\s\S]*?v-bind=["']componentField["'][^>]*>/)
    expect(inputBindMatch).toBeNull()
  })

  test('source uses separate ref for capability input handling', () => {
    const source = getEditDialogSource()
    const hasNewCapabilityInput = source.match(/newCapabilityInput\s*=\s*ref\s*\(\s*['""][\s]*['""]\s*\)/)
    expect(hasNewCapabilityInput).not.toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — EditAgentCapabilitiesDialog: onSubmit passes string array to $api.patch
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002 AC3: EditAgentCapabilitiesDialog onSubmit passes string array to $api.patch', () => {
  test('source calls $api.patch with capabilitiesTags.value directly', () => {
    const source = getEditDialogSource()
    const hasPatchCall = source.match(/\$api\.patch\s*\([^)]*\{\s*capabilities:\s*capabilitiesTags\.value\s*\}/)
    expect(hasPatchCall).not.toBeNull()
  })

  test('source does NOT join capabilitiesTags with comma in patch body', () => {
    const source = getEditDialogSource()
    const hasJoinInPatch = source.match(/capabilities:\s*capabilitiesTags\.value\.join\s*\(\s*['"],[\s]*['"]\s*\)/)
    expect(hasJoinInPatch).toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — EditAgentCapabilitiesDialog: empty capabilities submits []
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002 AC4: EditAgentCapabilitiesDialog with no capability tags submits capabilities: []', () => {
  test('capabilitiesTags is initialized from props.agent.capabilities via ref spread', () => {
    const source = getEditDialogSource()
    const hasRefSpreadInit = source.match(/capabilitiesTags\s*=\s*ref<string\[\]>\s*\(\s*\[\s*\.\.\.\s*props\.agent\.capabilities\s*\]\s*\)/)
    expect(hasRefSpreadInit).not.toBeNull()
  })

  test('capabilitiesTags can be empty when props.agent.capabilities is empty', () => {
    const source = getEditDialogSource()
    const hasSpreadInit = source.includes('...props.agent.capabilities')
    expect(hasSpreadInit).toBe(true)
  })

  test('watcher updates capabilitiesTags when props.agent.capabilities changes', () => {
    const source = getEditDialogSource()
    const hasWatcher = source.match(/watch\s*\(\s*\(\s*\)\s*=>\s*props\.agent\.capabilities/)
    expect(hasWatcher).not.toBeNull()
  })

  test('watcher uses spread operator to copy new capabilities', () => {
    const source = getEditDialogSource()
    const hasSpreadInWatcher = source.match(/capabilitiesTags\.value\s*=\s*\[\s*\.\.\.\s*newCapabilities\s*\]/)
    expect(hasSpreadInWatcher).not.toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC5 — EditAgentCapabilitiesDialog: initializes ['foo', 'bar'] without comma-splitting
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002 AC5: EditAgentCapabilitiesDialog initializes capabilitiesTags without comma-splitting', () => {
  test('source initializes capabilitiesTags via ref with spread of props.agent.capabilities', () => {
    const source = getEditDialogSource()
    const hasRefSpreadInit = source.match(/capabilitiesTags\s*=\s*ref<string\[\]>\s*\(\s*\[\s*\.\.\.\s*props\.agent\.capabilities\s*\]\s*\)/)
    expect(hasRefSpreadInit).not.toBeNull()
  })

  test('source does NOT use .split(",") on agent capabilities', () => {
    const source = getEditDialogSource()
    const hasSplitCall = source.match(/agent\.capabilities\s*\.\s*split\s*\(\s*['"],[\s]*['"]\s*\)/)
    expect(hasSplitCall).toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC6 — EditAgentCapabilitiesDialog: ['multi-word capability'] initializes as single entry
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002 AC6: EditAgentCapabilitiesDialog handles multi-word capability as single entry', () => {
  test('source uses ref with spread operator for array initialization', () => {
    const source = getEditDialogSource()
    const noStringManipulation = source.match(/capabilitiesTags\s*=\s*ref<string\[\]>\s*\(\s*\[\s*\.\.\.\s*props\.agent\.capabilities\s*\]\s*\)/)
    expect(noStringManipulation).not.toBeNull()
  })

  test('source does NOT call .join().split() on capabilities', () => {
    const source = getEditDialogSource()
    const hasJoinThenSplit = source.match(/capabilities.*\.join\s*\([^)]*\)\s*\.split\s*\([^)]*\)/)
    expect(hasJoinThenSplit).toBeNull()
  })

  test('source does NOT use String() conversion on capabilities array items', () => {
    const source = getEditDialogSource()
    const hasStringConversion = source.match(/String\s*\(\s*props\.agent\.capabilities\s*\)/)
    expect(hasStringConversion).toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Integration: full CreateAgentDialog capabilities flow
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002: CreateAgentDialog capabilities integration', () => {
  test('capabilitiesTags is a ref<string[]>', () => {
    const source = getCreateDialogSource()
    const hasStringArrayRef = source.match(/capabilitiesTags:\s*ref\s*<\s*string\[\]\s*>\s*\(\s*\[\s*\]\s*\)/)
    expect(hasStringArrayRef).not.toBeNull()
  })

  test('addCapability pushes to capabilitiesTags array', () => {
    const source = getCreateDialogSource()
    const hasPush = source.match(/capabilitiesTags\.value\s*=\s*\[\s*\.\.\.\s*capabilitiesTags\.value\s*,\s*\w+\s*\]/)
    expect(hasPush).not.toBeNull()
  })

  test('removeCapability filters from capabilitiesTags array', () => {
    const source = getCreateDialogSource()
    const hasFilter = source.match(/capabilitiesTags\.value\s*=\s*capabilitiesTags\.value\.filter/)
    expect(hasFilter).not.toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Integration: full EditAgentCapabilitiesDialog capabilities flow
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002: EditAgentCapabilitiesDialog capabilities integration', () => {
  test('capabilitiesTags is a ref<string[]> initialized with spread of props.agent.capabilities', () => {
    const source = getEditDialogSource()
    const hasStringArrayRef = source.match(/capabilitiesTags\s*=\s*ref<string\[\]>\s*\(\s*\[\s*\.\.\.\s*props\.agent\.capabilities\s*\]\s*\)/)
    expect(hasStringArrayRef).not.toBeNull()
  })

  test('addCapability pushes to capabilitiesTags array', () => {
    const source = getEditDialogSource()
    const hasPush = source.match(/capabilitiesTags\.value\s*=\s*\[\s*\.\.\.\s*capabilitiesTags\.value\s*,\s*\w+\s*\]/)
    expect(hasPush).not.toBeNull()
  })

  test('handleRemove filters from capabilitiesTags array', () => {
    const source = getEditDialogSource()
    const hasFilter = source.match(/capabilitiesTags\.value\s*=\s*capabilitiesTags\.value\.filter/)
    expect(hasFilter).not.toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Quality: no console.log
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002: Capabilities dialogs have no console.log statements', () => {
  test('CreateAgentDialog.vue does not contain console.log', () => {
    const source = getCreateDialogSource()
    expect(source).not.toContain('console.log')
  })

  test('EditAgentCapabilitiesDialog.vue does not contain console.log', () => {
    const source = getEditDialogSource()
    expect(source).not.toContain('console.log')
  })
})
