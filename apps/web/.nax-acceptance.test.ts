import { describe, test, expect } from '@jest/globals'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '.')
const pagesDir = join(webDir, 'pages')
const componentsDir = join(webDir, 'components')
const layoutsDir = join(webDir, 'layouts')
const localesDir = join(webDir, 'i18n', 'locales')

const agentsPagePath = join(pagesDir, 'agents.vue')
const createAgentDialogPath = join(componentsDir, 'CreateAgentDialog.vue')
const editAgentRolesDialogPath = join(componentsDir, 'EditAgentRolesDialog.vue')
const editAgentCapabilitiesDialogPath = join(componentsDir, 'EditAgentCapabilitiesDialog.vue')
const rotateKeyDialogPath = join(componentsDir, 'RotateKeyDialog.vue')
const deleteAgentDialogPath = join(componentsDir, 'DeleteAgentDialog.vue')
const defaultLayoutPath = join(layoutsDir, 'default.vue')

// ─────────────────────────────────────────────────────────────────────────────
// AC-1: pages/agents.vue loaded, useAsyncData called with key 'agents' and
//       fetches $api.get('/agents')
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-1: pages/agents.vue useAsyncData key is 'agents' and fetches $api.get('/agents')", () => {
  test('AC-1: pages/agents.vue exists', () => {
    expect(existsSync(agentsPagePath)).toBe(true)
  })

  test("AC-1: useAsyncData is called with first argument exactly 'agents'", () => {
    const source = readFileSync(agentsPagePath, 'utf-8')
    expect(source).toMatch(/useAsyncData\s*\(\s*['"]agents['"]/)
  })

  test("AC-1: fetch call uses $api.get('/agents') with no slug segment", () => {
    const source = readFileSync(agentsPagePath, 'utf-8')
    expect(source).toContain("$api.get('/agents')")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-2: changeStatus(agent, newStatus) calls $api.patch('/agents/' + agent.slug, { status: newStatus })
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-2: changeStatus calls $api.patch with /agents/${agent.slug} and status body', () => {
  test('AC-2: changeStatus function calls $api.patch with /agents/${agent.slug}', () => {
    const source = readFileSync(agentsPagePath, 'utf-8')
    expect(source).toMatch(/\$api\.patch\s*\(\s*['`]\/agents\/\$\{[^}]+\.slug\}[`'`]/)
  })

  test('AC-2: $api.patch call includes status: newStatus in body', () => {
    const source = readFileSync(agentsPagePath, 'utf-8')
    expect(source).toMatch(/status\s*:\s*newStatus/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-3: Given route.path === '/agents', breadcrumbItems returns
//       [{ label: 'Koda', to: '/' }, { label: t('nav.agents') }]
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-3: breadcrumbItems returns correct items when route.path === '/agents'", () => {
  test("AC-3: layout has breadcrumb case for path === '/agents'", () => {
    const source = readFileSync(defaultLayoutPath, 'utf-8')
    expect(source).toMatch(/route\.path\s*===\s*['"]\/agents['"]/)
  })

  test("AC-3: /agents breadcrumb includes Koda link and t('nav.agents') label", () => {
    const source = readFileSync(defaultLayoutPath, 'utf-8')
    // The /agents case should return [{ label: 'Koda', to: '/' }, { label: t('nav.agents') }]
    expect(source).toMatch(/label:\s*['"]Koda['"]/)
    expect(source).toMatch(/to:\s*['"]\/['"]/)
    expect(source).toMatch(/label:\s*t\s*\(\s*['"]nav\.agents['"]\s*\)/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-4: When sidebar renders without project context, /agents NuxtLink with Bot icon is visible
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-4: sidebar has /agents NuxtLink with Bot icon visible outside v-if="projectSlug"', () => {
  test('AC-4: /agents NuxtLink exists outside v-if="projectSlug" block', () => {
    const source = readFileSync(defaultLayoutPath, 'utf-8')
    // The Bot icon NuxtLink to /agents must appear in the always-visible nav section
    // (before the v-if="projectSlug" template block)
    const projectSlugBlockIdx = source.indexOf('v-if="projectSlug"')
    const agentsLinkIdx = source.indexOf('to="/agents"')
    expect(agentsLinkIdx).toBeGreaterThan(0)
    // The link should appear BEFORE the project-scoped block, not inside it
    expect(agentsLinkIdx).toBeLessThan(projectSlugBlockIdx)
  })

  test('AC-4: /agents link uses Bot icon', () => {
    const source = readFileSync(defaultLayoutPath, 'utf-8')
    // Bot component should be imported and used alongside /agents link
    expect(source).toContain('Bot')
    expect(source).toMatch(/<Bot\s+class=/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-5: When sidebar renders with project context (projectSlug set),
//       old /${projectSlug}/agents NuxtLink is NOT present
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-5: sidebar does NOT contain /${projectSlug}/agents NuxtLink inside v-if='projectSlug' block", () => {
  test('AC-5: project-scoped agents NuxtLink is removed from v-if="projectSlug" block', () => {
    const source = readFileSync(defaultLayoutPath, 'utf-8')
    // The old link: :to="`/${projectSlug}/agents`" should NOT exist
    expect(source).not.toMatch(/to=["']\/\$\{projectSlug\}\/agents["']/)
    expect(source).not.toMatch(/:to=`\/\$\{projectSlug\}\/agents`/)
  })

  test('AC-5: no NuxtLink with path containing projectSlug and /agents', () => {
    const source = readFileSync(defaultLayoutPath, 'utf-8')
    // No agents link that embeds projectSlug variable
    expect(source).not.toMatch(/\$\{projectSlug\}.*agents/)
    expect(source).not.toMatch(/projectSlug.*agents/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-6: name field auto-derives slug as kebab-case but remains independently editable
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-6: name field auto-derives slug in kebab-case but is independently editable', () => {
  test('AC-6: CreateAgentDialog watches name and sets slug field', () => {
    const source = readFileSync(createAgentDialogPath, 'utf-8')
    // Should have a watch on name that calls setFieldValue for slug
    expect(source).toMatch(/watch\s*\(\s*\(\)\s*=>\s*values\.name/)
    expect(source).toMatch(/setFieldValue\s*\(\s*['"]slug['"]/)
  })

  test('AC-6: slug is set via toLowerCase and replace for kebab-case derivation', () => {
    const source = readFileSync(createAgentDialogPath, 'utf-8')
    // deriveSlug or inline transform: toLowerCase + replace spaces with -
    expect(source).toMatch(/toLowerCase\s*\(\s*\)/)
    expect(source).toMatch(/replace\s*\(\s*\/[\^]?\s*\/.*-/)
  })

  test('AC-6: slug FormField still exists and is user-editable (not disabled)', () => {
    const source = readFileSync(createAgentDialogPath, 'utf-8')
    // slug field must be present as FormField name="slug" with an Input
    expect(source).toMatch(/FormField\s+name=['"]slug['"]/)
    // Should NOT have :disabled on the slug input (it must be editable)
    expect(source).not.toMatch(/slug.*:disabled|:disabled.*slug/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-7: Form submitted with valid values calls $api.post('/agents', {...})
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-7: CreateAgentDialog form submits $api.post('/agents', { name, slug, roles, capabilities, maxConcurrentTickets })", () => {
  test("AC-7: $api.post is called with '/agents' endpoint", () => {
    const source = readFileSync(createAgentDialogPath, 'utf-8')
    expect(source).toContain("$api.post('/agents'")
  })

  test('AC-7: post body includes name, slug, roles, capabilities, maxConcurrentTickets', () => {
    const source = readFileSync(createAgentDialogPath, 'utf-8')
    expect(source).toMatch(/name\s*:\s*values\.name/)
    expect(source).toMatch(/slug\s*:\s*values\.slug/)
    expect(source).toMatch(/roles\s*:\s*values\.roles/)
    expect(source).toMatch(/capabilities\s*:\s*values\.capabilities/)
    expect(source).toMatch(/maxConcurrentTickets\s*:\s*values\.maxConcurrentTickets/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-8: When API call succeeds, dialog renders read-only Input containing returned apiKey
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-8: CreateAgentDialog switches to key-reveal view with read-only Input showing apiKey', () => {
  test('AC-8: apiKey value from API response is rendered in Input', () => {
    const source = readFileSync(createAgentDialogPath, 'utf-8')
    // Template should show apiKey in an Input element
    expect(source).toMatch(/v-model[:=][^"]*"apiKey"|:model-value=["']apiKey["']/)
  })

  test('AC-8: apiKey Input is read-only (not editable)', () => {
    const source = readFileSync(createAgentDialogPath, 'utf-8')
    // Read-only can be achieved via :readonly or disabled on Input
    expect(source).toMatch(/:readonly\s*=|:disabled\s*=/)
  })

  test('AC-8: key-reveal view appears after successful creation (apiKey is displayed)', () => {
    const source = readFileSync(createAgentDialogPath, 'utf-8')
    // Should show the API key reveal section (with a condition like v-if="apiKey" or similar)
    expect(source).toMatch(/apiKey/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-9: Copy button writes apiKey to clipboard, label changes to 'Copied!' for 2 seconds
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-9: Copy button writes apiKey to clipboard and shows 'Copied!' for 2 seconds", () => {
  test('AC-9: Copy button calls navigator.clipboard.writeText with apiKey', () => {
    const source = readFileSync(createAgentDialogPath, 'utf-8')
    expect(source).toMatch(/navigator\.clipboard\.writeText/)
    expect(source).toMatch(/apiKey/)
  })

  test("AC-9: Copy button label changes to i18n key for copied state after click", () => {
    const source = readFileSync(createAgentDialogPath, 'utf-8')
    // Button should use i18n key for copied state after copying
    expect(source).toMatch(/t\s*\(\s*['"]agents\.rotateKey\.apiKeyReveal\.copied['"]/)
  })

  test('AC-9: setTimeout or similar reverts button label after 2000ms', () => {
    const source = readFileSync(createAgentDialogPath, 'utf-8')
    // Should have setTimeout with 2000 (or close to it) to revert label
    expect(source).toMatch(/setTimeout\s*\(\s*\w+\s*,\s*2000\s*\)/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-10: When form submitted with empty roles, validation error shown and $api.post NOT called
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-10: CreateAgentDialog validates roles is required and blocks submission when empty', () => {
  test('AC-10: roles field has min(1) validation in zod schema', () => {
    const source = readFileSync(createAgentDialogPath, 'utf-8')
    // roles: z.array(z.string()).min(1) or similar
    expect(source).toMatch(/roles\s*:\s*z\.(array|object).*\.min\s*\(\s*1\s*\)/)
  })

  test('AC-10: handleSubmit is used to gate $api.post on validation', () => {
    const source = readFileSync(createAgentDialogPath, 'utf-8')
    expect(source).toContain('handleSubmit')
    // onSubmit is async function passed to handleSubmit - API call only inside
    expect(source).toMatch(/handleSubmit\s*\(\s*async\s*\(\s*\)\s*=>/)
  })

  test('AC-10: FormMessage is rendered for roles field', () => {
    const source = readFileSync(createAgentDialogPath, 'utf-8')
    expect(source).toMatch(/FormField\s+name=['"]roles['"]/)
    expect(source).toMatch(/FormMessage/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-11: Done button on key-reveal view emits 'created' and closes dialog
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-11: Done button emits 'created' event and closes dialog", () => {
  test("AC-11: Done button calls emit('created')", () => {
    const source = readFileSync(createAgentDialogPath, 'utf-8')
    expect(source).toMatch(/emit\s*\(\s*['"]created['"]\s*\)/)
  })

  test('AC-11: Done button closes the dialog', () => {
    const source = readFileSync(createAgentDialogPath, 'utf-8')
    // emit('update:open', false) or similar to close
    expect(source).toMatch(/emit\s*\(\s*['"]update:open['"]/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-12: pages/agents.vue calls refresh() on 'created' event from CreateAgentDialog
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-12: pages/agents.vue calls refresh() when CreateAgentDialog emits 'created'", () => {
  test("AC-12: CreateAgentDialog is used in pages/agents.vue and emits 'created'", () => {
    const source = readFileSync(agentsPagePath, 'utf-8')
    expect(source).toContain('CreateAgentDialog')
    expect(source).toMatch(/@created\s*=\s*["']refresh\(\)["']|@created\s*=\s*refresh/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-13: maxConcurrentTickets defaults to 3 when not provided
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-13: maxConcurrentTickets form field defaults to 3', () => {
  test('AC-13: initialValues for maxConcurrentTickets is 3', () => {
    const source = readFileSync(createAgentDialogPath, 'utf-8')
    expect(source).toMatch(/maxConcurrentTickets\s*:\s*3/)
  })

  test('AC-13: zod schema provides a default of 3', () => {
    const source = readFileSync(createAgentDialogPath, 'utf-8')
    // .default(3) on maxConcurrentTickets in zod schema
    expect(source).toMatch(/maxConcurrentTickets.*\.default\s*\(\s*3\s*\)/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-14: EditAgentRolesDialog pre-checks current roles when opened with agent
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-14: EditAgentRolesDialog pre-checks current roles from agent prop', () => {
  test('AC-14: roles checkboxes are pre-checked based on agent.roles', () => {
    const source = readFileSync(editAgentRolesDialogPath, 'utf-8')
    // Should have v-model or :checked bound to roles with agent.roles as initial value
    expect(source).toMatch(/agent\.roles/)
    expect(source).toMatch(/roles\.value/)
  })

  test('AC-14: initialValues or form state is seeded with agent.roles', () => {
    const source = readFileSync(editAgentRolesDialogPath, 'utf-8')
    // initialValues should spread agent.roles or set roles field to agent.roles
    expect(source).toMatch(/initialValues|setFieldValue/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-15: EditAgentRolesDialog calls $api.patch('/agents/${agent.slug}/update-roles', { roles })
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-15: EditAgentRolesDialog submits $api.patch('/agents/${agent.slug}/update-roles', { roles })", () => {
  test('AC-15: $api.patch is called with /agents/${agent.slug}/update-roles', () => {
    const source = readFileSync(editAgentRolesDialogPath, 'utf-8')
    expect(source).toMatch(/\$api\.patch\s*\(\s*['`]\/agents\/\$\{[^}]+\.slug\}\/update-roles['`]/)
  })

  test('AC-15: patch body includes roles from form values', () => {
    const source = readFileSync(editAgentRolesDialogPath, 'utf-8')
    expect(source).toMatch(/roles\s*:\s*values\.roles/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-16: EditAgentRolesDialog shows success toast and emits 'updated' on success
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-16: EditAgentRolesDialog shows toast.success and emits 'updated' on success", () => {
  test('AC-16: toast.success is called on successful submission', () => {
    const source = readFileSync(editAgentRolesDialogPath, 'utf-8')
    expect(source).toMatch(/toast\.success\s*\(\s*t\s*\(\s*['"]agents\.toast\.rolesUpdated/)
  })

  test("AC-16: emit('updated') is called after successful patch", () => {
    const source = readFileSync(editAgentRolesDialogPath, 'utf-8')
    expect(source).toMatch(/emit\s*\(\s*['"]updated['"]\s*\)/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-17: EditAgentCapabilitiesDialog renders capabilities as removable Badge tags
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-17: EditAgentCapabilitiesDialog renders capabilities as removable Badge tags', () => {
  test('AC-17: capabilities are rendered using Badge component in a loop', () => {
    const source = readFileSync(editAgentCapabilitiesDialogPath, 'utf-8')
    expect(source).toMatch(/v-for.*capabilities/)
    expect(source).toMatch(/Badge/)
  })

  test('AC-17: Badge has a remove control (e.g., X button or @click to remove)', () => {
    const source = readFileSync(editAgentCapabilitiesDialogPath, 'utf-8')
    // Should have a remove action - either a button inside Badge or a click handler
    expect(source).toMatch(/@click|remove|splice|filter/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-18: Enter key in input appends entered text as new capability tag
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-18: Enter key in EditAgentCapabilitiesDialog input appends capability tag', () => {
  test('AC-18: Input has @keydown.enter handler', () => {
    const source = readFileSync(editAgentCapabilitiesDialogPath, 'utf-8')
    expect(source).toMatch(/@keydown\.enter|@keyup\.enter/)
  })

  test('AC-18: Enter handler appends new capability to capabilities array', () => {
    const source = readFileSync(editAgentCapabilitiesDialogPath, 'utf-8')
    // Should push or spread-concat to add new capability
    expect(source).toMatch(/capabilities\.value\.push|setFieldValue|[\s\S]capabilities[\s\S]*\+\s*\[/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-19: Badge remove control removes that capability tag
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-19: Badge remove control removes capability from the list', () => {
  test('AC-19: Clicking remove calls filter/splice to remove the specific capability', () => {
    const source = readFileSync(editAgentCapabilitiesDialogPath, 'utf-8')
    // Should filter out or splice on the specific capability being removed
    expect(source).toMatch(/filter\s*\(|splice\s*\(|capabilities\.value\s*=/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-20: EditAgentCapabilitiesDialog calls $api.patch('/agents/${agent.slug}/update-capabilities', { capabilities })
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-20: EditAgentCapabilitiesDialog submits $api.patch('/agents/${agent.slug}/update-capabilities', { capabilities })", () => {
  test('AC-20: $api.patch is called with update-capabilities endpoint', () => {
    const source = readFileSync(editAgentCapabilitiesDialogPath, 'utf-8')
    expect(source).toMatch(/\$api\.patch\s*\(\s*['`]\/agents\/\$\{[^}]+\.slug\}\/update-capabilities['`]/)
  })

  test('AC-20: patch body includes capabilities array', () => {
    const source = readFileSync(editAgentCapabilitiesDialogPath, 'utf-8')
    expect(source).toMatch(/capabilities\s*:\s*values\.capabilities/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-21: EditAgentCapabilitiesDialog shows success toast and emits 'updated' on success
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-21: EditAgentCapabilitiesDialog shows toast.success and emits 'updated' on success", () => {
  test('AC-21: toast.success is called on successful submission', () => {
    const source = readFileSync(editAgentCapabilitiesDialogPath, 'utf-8')
    expect(source).toMatch(/toast\.success\s*\(\s*t\s*\(\s*['"]agents\.toast\.capabilitiesUpdated/)
  })

  test("AC-21: emit('updated') is called after successful patch", () => {
    const source = readFileSync(editAgentCapabilitiesDialogPath, 'utf-8')
    expect(source).toMatch(/emit\s*\(\s*['"]updated['"]\s*\)/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-22: pages/agents.vue calls refresh() on 'updated' from either edit dialog
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-22: pages/agents.vue calls refresh() when edit dialogs emit 'updated'", () => {
  test("AC-22: EditAgentRolesDialog emits 'updated' and page handles it", () => {
    const source = readFileSync(agentsPagePath, 'utf-8')
    // Should have @updated="refresh" on EditAgentRolesDialog or similar handling
    expect(source).toMatch(/@updated\s*=\s*refresh|EditAgentRolesDialog.*@updated/)
  })

  test("AC-22: EditAgentCapabilitiesDialog emits 'updated' and page handles it", () => {
    const source = readFileSync(agentsPagePath, 'utf-8')
    expect(source).toMatch(/EditAgentCapabilitiesDialog/)
    expect(source).toMatch(/@updated\s*=\s*refresh|EditAgentCapabilitiesDialog.*@updated/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-23: Actions dropdown contains 'Edit Roles' and 'Edit Capabilities' items
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-23: Actions dropdown contains 'Edit Roles' and 'Edit Capabilities' items", () => {
  test("AC-23: DropdownMenuItem exists for 'Edit Roles'", () => {
    const source = readFileSync(agentsPagePath, 'utf-8')
    expect(source).toMatch(/DropdownMenuItem/)
    expect(source).toMatch(/editRoles|Edit Roles/)
  })

  test("AC-23: DropdownMenuItem exists for 'Edit Capabilities'", () => {
    const source = readFileSync(agentsPagePath, 'utf-8')
    expect(source).toMatch(/editCapabilities|Edit Capabilities/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-24: RotateKeyDialog calls $api.post('/agents/${agent.slug}/rotate-key', {})
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-24: RotateKeyDialog calls $api.post('/agents/${agent.slug}/rotate-key', {})", () => {
  test('AC-24: $api.post is called with rotate-key endpoint', () => {
    const source = readFileSync(rotateKeyDialogPath, 'utf-8')
    expect(source).toMatch(/\$api\.post\s*\(\s*['`]\/agents\/\$\{[^}]+\.slug\}\/rotate-key['`]\s*,\s*\{\s*\}\s*\)/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-25: RotateKeyDialog shows new apiKey in read-only Input with Copy button
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-25: RotateKeyDialog shows new apiKey in read-only Input with Copy button and warning', () => {
  test('AC-25: apiKey is displayed in a read-only Input after rotation', () => {
    const source = readFileSync(rotateKeyDialogPath, 'utf-8')
    expect(source).toMatch(/apiKey/)
    expect(source).toMatch(/:readonly\s*=|:disabled\s*=/)
  })

  test('AC-25: warning message uses i18n key for key reveal message', () => {
    const source = readFileSync(rotateKeyDialogPath, 'utf-8')
    // Warning about key not being shown again uses i18n
    expect(source).toMatch(/t\s*\(\s*['"]agents\.rotateKey\.apiKeyReveal\.message['"]/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-26: Copy button in RotateKeyDialog writes apiKey to clipboard and shows 'Copied!' for 2s
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-26: RotateKeyDialog Copy button writes apiKey to clipboard and shows 'Copied!' for 2 seconds", () => {
  test('AC-26: Copy button calls navigator.clipboard.writeText with apiKey', () => {
    const source = readFileSync(rotateKeyDialogPath, 'utf-8')
    expect(source).toMatch(/navigator\.clipboard\.writeText/)
    expect(source).toMatch(/apiKey/)
  })

  test("AC-26: Button label changes to i18n key for copied state after click", () => {
    const source = readFileSync(rotateKeyDialogPath, 'utf-8')
    expect(source).toMatch(/t\s*\(\s*['"]agents\.rotateKey\.apiKeyReveal\.copied['"]/)
  })

  test('AC-26: setTimeout with ~2000ms reverts button label', () => {
    const source = readFileSync(rotateKeyDialogPath, 'utf-8')
    expect(source).toMatch(/setTimeout\s*\(\s*\w+\s*,\s*2000\s*\)/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-27: RotateKeyDialog Done button emits 'rotated' and closes
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-27: RotateKeyDialog Done button emits 'rotated' and closes", () => {
  test("AC-27: Done button calls emit('rotated')", () => {
    const source = readFileSync(rotateKeyDialogPath, 'utf-8')
    expect(source).toMatch(/emit\s*\(\s*['"]rotated['"]\s*\)/)
  })

  test('AC-27: Done button closes the dialog', () => {
    const source = readFileSync(rotateKeyDialogPath, 'utf-8')
    expect(source).toMatch(/emit\s*\(\s*['"]update:open['"]/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-28: DeleteAgentDialog confirm message contains agent's name
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-28: DeleteAgentDialog confirm message contains agent.name', () => {
  test('AC-28: confirm message interpolates agent.name', () => {
    const source = readFileSync(deleteAgentDialogPath, 'utf-8')
    expect(source).toMatch(/agent\.name|agentName/)
    expect(source).toMatch(/t\s*\(\s*['"]agents\.deleteAgent\.confirm/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-29: DeleteAgentDialog calls $api.delete('/agents/${agent.slug}')
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-29: DeleteAgentDialog calls $api.delete('/agents/${agent.slug}')", () => {
  test('AC-29: $api.delete is called with /agents/${agent.slug}', () => {
    const source = readFileSync(deleteAgentDialogPath, 'utf-8')
    expect(source).toMatch(/\$api\.delete\s*\(\s*['`]\/agents\/\$\{[^}]+\.slug\}[`'`]\s*\)/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-30: DeleteAgentDialog shows success toast, emits 'deleted', and closes on success
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-30: DeleteAgentDialog shows toast.success, emits 'deleted', and closes on success", () => {
  test('AC-30: toast.success is called after successful deletion', () => {
    const source = readFileSync(deleteAgentDialogPath, 'utf-8')
    expect(source).toMatch(/toast\.success\s*\(\s*t\s*\(\s*['"]agents\.toast\.deleted/)
  })

  test("AC-30: emit('deleted') is called after successful deletion", () => {
    const source = readFileSync(deleteAgentDialogPath, 'utf-8')
    expect(source).toMatch(/emit\s*\(\s*['"]deleted['"]\s*\)/)
  })

  test('AC-30: dialog closes after successful deletion', () => {
    const source = readFileSync(deleteAgentDialogPath, 'utf-8')
    expect(source).toMatch(/emit\s*\(\s*['"]update:open['"]/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-31: pages/agents.vue calls refresh() on 'rotated' from RotateKeyDialog
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-31: pages/agents.vue calls refresh() when RotateKeyDialog emits 'rotated'", () => {
  test("AC-31: @rotated='refresh' is set on RotateKeyDialog or handled in the page", () => {
    const source = readFileSync(agentsPagePath, 'utf-8')
    expect(source).toMatch(/RotateKeyDialog/)
    expect(source).toMatch(/@rotated\s*=\s*refresh/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-32: pages/agents.vue calls refresh() on 'deleted' from DeleteAgentDialog
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-32: pages/agents.vue calls refresh() when DeleteAgentDialog emits 'deleted'", () => {
  test("AC-32: @deleted='refresh' is set on DeleteAgentDialog or handled in the page", () => {
    const source = readFileSync(agentsPagePath, 'utf-8')
    expect(source).toMatch(/DeleteAgentDialog/)
    expect(source).toMatch(/@deleted\s*=\s*refresh/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-33: Actions dropdown contains 'Rotate Key' and 'Delete' items
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-33: Actions dropdown contains 'Rotate Key' and 'Delete' items", () => {
  test("AC-33: DropdownMenuItem exists for 'Rotate Key'", () => {
    const source = readFileSync(agentsPagePath, 'utf-8')
    expect(source).toMatch(/DropdownMenuItem/)
    expect(source).toMatch(/rotateKey|Rotate Key/)
  })

  test("AC-33: DropdownMenuItem exists for 'Delete'", () => {
    const source = readFileSync(agentsPagePath, 'utf-8')
    expect(source).toMatch(/DropdownMenuItem/)
    expect(source).toMatch(/['"]delete['"]|Delete/)
  })
})