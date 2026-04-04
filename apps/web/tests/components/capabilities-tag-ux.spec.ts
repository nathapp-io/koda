import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const createDialogPath = join(webDir, 'components', 'CreateAgentDialog.vue')
const editDialogPath = join(webDir, 'components', 'EditAgentCapabilitiesDialog.vue')
const utilsPath = join(webDir, 'lib', 'utils.ts')

function getCreateDialogSource(): string {
  return readFileSync(createDialogPath, 'utf-8')
}

function getEditDialogSource(): string {
  return readFileSync(editDialogPath, 'utf-8')
}

function getUtilsSource(): string {
  return readFileSync(utilsPath, 'utf-8')
}

// ──────────────────────────────────────────────────────────────────────────────
// US-003-B AC1: CreateAgentDialog addCapability rejects case-insensitive duplicates
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003-B AC1: CreateAgentDialog addCapability rejects case-insensitive duplicates', () => {
  test('normalizeCapabilities is imported in CreateAgentDialog.vue', () => {
    const source = getCreateDialogSource()
    const importsNormalize = source.includes("normalizeCapabilities") || source.match(/import\s*\{[^}]*normalizeCapabilities[^}]*\}\s*from\s*['"]~\/lib\/utils['"]/)
    expect(importsNormalize).toBeTruthy()
  })

  test('addCapability function uses normalizeCapabilities for deduplication', () => {
    const source = getCreateDialogSource()
    const addCapabilityMatch = source.match(/function addCapability\([\s\S]*?^\}/m)
    expect(addCapabilityMatch).not.toBeNull()
    const addCapabilityBody = addCapabilityMatch![0]
    const usesNormalize = addCapabilityBody.includes('normalizeCapabilities')
    expect(usesNormalize).toBe(true)
  })

  test('addCapability does NOT use case-sensitive includes for duplicate check', () => {
    const source = getCreateDialogSource()
    const addCapabilityMatch = source.match(/function addCapability\([\s\S]*?^\}/m)
    expect(addCapabilityMatch).not.toBeNull()
    const addCapabilityBody = addCapabilityMatch![0]
    const usesCaseSensitiveIncludes = addCapabilityBody.match(/capabilitiesTags\.value\.includes\s*\(\s*value\s*\)/)
    expect(usesCaseSensitiveIncludes).toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// US-003-B AC2: EditAgentCapabilitiesDialog addCapability rejects empty trimmed input
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003-B AC2: EditAgentCapabilitiesDialog addCapability rejects empty trimmed input', () => {
  test('addCapability trims input value before checking', () => {
    const source = getEditDialogSource()
    const addCapabilityMatch = source.match(/function addCapability\([\s\S]*?^\}/m)
    expect(addCapabilityMatch).not.toBeNull()
    const addCapabilityBody = addCapabilityMatch![0]
    expect(addCapabilityBody).toContain('.trim()')
  })

  test('addCapability checks for empty string after trim', () => {
    const source = getEditDialogSource()
    const addCapabilityMatch = source.match(/function addCapability\([\s\S]*?^\}/m)
    expect(addCapabilityMatch).not.toBeNull()
    const addCapabilityBody = addCapabilityMatch![0]
    const hasEmptyCheck = addCapabilityBody.match(/if\s*\(\s*value\s*&&/)
    expect(hasEmptyCheck).not.toBeNull()
  })

  test('addCapability does not add to capabilitiesTags when trimmed value is empty', () => {
    const source = getEditDialogSource()
    const addCapabilityMatch = source.match(/function addCapability\([\s\S]*?^\}/m)
    expect(addCapabilityMatch).not.toBeNull()
    const addCapabilityBody = addCapabilityMatch![0]
    expect(addCapabilityBody).toContain('if (value')
    expect(addCapabilityBody).toContain('capabilitiesTags.value')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// US-003-B AC3: EditAgentCapabilitiesDialog addCapability rejects case-insensitive duplicates
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003-B AC3: EditAgentCapabilitiesDialog addCapability rejects case-insensitive duplicates', () => {
  test('normalizeCapabilities is imported in EditAgentCapabilitiesDialog.vue', () => {
    const source = getEditDialogSource()
    const importsNormalize = source.includes("normalizeCapabilities") || source.match(/import\s*\{[^}]*normalizeCapabilities[^}]*\}\s*from\s*['"]~\/lib\/utils['"]/)
    expect(importsNormalize).toBeTruthy()
  })

  test('addCapability function uses normalizeCapabilities for deduplication', () => {
    const source = getEditDialogSource()
    const addCapabilityMatch = source.match(/function addCapability\([\s\S]*?^\}/m)
    expect(addCapabilityMatch).not.toBeNull()
    const addCapabilityBody = addCapabilityMatch![0]
    const usesNormalize = addCapabilityBody.includes('normalizeCapabilities')
    expect(usesNormalize).toBe(true)
  })

  test('addCapability does NOT use case-sensitive includes for duplicate check', () => {
    const source = getEditDialogSource()
    const addCapabilityMatch = source.match(/function addCapability\([\s\S]*?^\}/m)
    expect(addCapabilityMatch).not.toBeNull()
    const addCapabilityBody = addCapabilityMatch![0]
    const usesCaseSensitiveIncludes = addCapabilityBody.match(/capabilitiesTags\.value\.includes\s*\(\s*value\s*\)/)
    expect(usesCaseSensitiveIncludes).toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// US-003-B AC4: CreateAgentDialog removeCapability updates tags and onSubmit payload
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003-B AC4: CreateAgentDialog removeCapability updates tags and onSubmit payload', () => {
  test('removeCapability function removes tag at given index', () => {
    const source = getCreateDialogSource()
    const removeCapabilityMatch = source.match(/function removeCapability\([\s\S]*?^\}/m)
    expect(removeCapabilityMatch).not.toBeNull()
    const removeCapabilityBody = removeCapabilityMatch![0]
    const usesFilter = removeCapabilityBody.includes('filter')
    const passesIndex = removeCapabilityBody.includes('i !== index') || removeCapabilityBody.includes('i !== index')
    expect(usesFilter && passesIndex).toBe(true)
  })

  test('capabilitiesTags is watched and synced to form capabilities field', () => {
    const source = getCreateDialogSource()
    const hasWatch = source.includes('watch(capabilitiesTags')
    const syncsToField = source.includes('setFieldValue')
    expect(hasWatch && syncsToField).toBe(true)
  })

  test('watch syncs capabilitiesTags to setFieldValue("capabilities")', () => {
    const source = getCreateDialogSource()
    const watchMatch = source.match(/watch\s*\(\s*capabilitiesTags[\s\S]*?\}\s*,\s*\{[^}]*\}\s*\)/m)
    expect(watchMatch).not.toBeNull()
    const watchBody = watchMatch![0]
    const syncsToField = watchBody.includes('setFieldValue') && watchBody.includes('capabilities')
    expect(syncsToField).toBe(true)
  })

  test('onSubmit passes form values with capabilities to $api.post', () => {
    const source = getCreateDialogSource()
    const hasOnSubmit = source.includes('const onSubmit = handleSubmit')
    const passesFormValues = source.match(/\$api\.post\s*\(\s*['"]\/agents['"]\s*,\s*formValues/)
    expect(hasOnSubmit && passesFormValues).toBeTruthy()
  })

  test('formSchema defines capabilities as z.array(z.string())', () => {
    const source = getCreateDialogSource()
    const hasCapabilitiesSchema = source.match(/capabilities:\s*z\.array\s*\(\s*z\.string\(\)\s*\)/)
    expect(hasCapabilitiesSchema).not.toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// US-003-B AC5: EditAgentCapabilitiesDialog handleRemove updates tags and onSubmit payload
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003-B AC5: EditAgentCapabilitiesDialog handleRemove updates tags and onSubmit payload', () => {
  test('handleRemove function removes tag at given index', () => {
    const source = getEditDialogSource()
    const handleRemoveMatch = source.match(/function handleRemove\([\s\S]*?^\}/m)
    expect(handleRemoveMatch).not.toBeNull()
    const handleRemoveBody = handleRemoveMatch![0]
    const usesFilter = handleRemoveBody.includes('filter')
    const passesIndex = handleRemoveBody.includes('i !== index')
    expect(usesFilter && passesIndex).toBe(true)
  })

  test('onSubmit passes capabilitiesTags.value to $api.patch', () => {
    const source = getEditDialogSource()
    const hasOnSubmit = source.includes('const onSubmit = handleSubmit')
    const passesCapabilities = source.match(/\$api\.patch\s*\([^)]*,\s*\{[^}]*capabilities[^}]*\}/)
    expect(hasOnSubmit && passesCapabilities).toBeTruthy()
  })

  test('$api.patch is called with agent.slug and update-capabilities endpoint', () => {
    const source = getEditDialogSource()
    const hasUpdateCapabilities = source.includes('update-capabilities')
    const usesAgentSlug = source.includes('agent.slug')
    expect(hasUpdateCapabilities && usesAgentSlug).toBe(true)
  })

  test('onSubmit payload contains capabilities array with current tags', () => {
    const source = getEditDialogSource()
    const patchCallMatch = source.match(/\$api\.patch\s*\(\s*[^,]+,\s*\{([^}]+)\}\s*\)/m)
    expect(patchCallMatch).not.toBeNull()
    const payload = patchCallMatch![1]
    expect(payload).toContain('capabilities')
    expect(payload).toContain('capabilitiesTags')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Utility: normalizeCapabilities exists and is properly implemented
// ──────────────────────────────────────────────────────────────────────────────

describe('Utility: normalizeCapabilities is properly implemented', () => {
  test('normalizeCapabilities is exported from lib/utils.ts', () => {
    const source = getUtilsSource()
    expect(source).toContain('export function normalizeCapabilities')
  })

  test('normalizeCapabilities uses Set for case-insensitive deduplication', () => {
    const source = getUtilsSource()
    const normalizeMatch = source.match(/export function normalizeCapabilities[\s\S]*?^\}/m)
    expect(normalizeMatch).not.toBeNull()
    const funcBody = normalizeMatch![0]
    const usesSet = funcBody.includes('Set')
    const usesToLowerCase = funcBody.includes('toLowerCase')
    expect(usesSet && usesToLowerCase).toBe(true)
  })

  test('normalizeCapabilities trims entries and skips empty strings', () => {
    const source = getUtilsSource()
    const normalizeMatch = source.match(/export function normalizeCapabilities[\s\S]*?^\}/m)
    expect(normalizeMatch).not.toBeNull()
    const funcBody = normalizeMatch![0]
    const trims = funcBody.includes('.trim()')
    const skipsEmpty = funcBody.includes('if (!trimmed) continue') || funcBody.includes('if (trimmed)')
    expect(trims && skipsEmpty).toBe(true)
  })
})
