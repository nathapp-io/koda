# Web UX Redesign Slice 5 — Remaining Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the remaining Koda web pages (Settings, Agents, Memory, Timeline, auth layout) to the slice 0–4 design system — token-based status chips, shared `PageHeader`/`FilterBar` patterns, componentized Settings — with every pinned test green.

**Architecture:** UI-only slice in `apps/web`. Split the 502-line Settings page into two form components; replace the last hardcoded palette status colors (agent pages) with dot+label chips from `lib/ticket-chips.ts`; adopt `FilterBar` on the memory/timeline filter rows; light up the `PageHeader` `#icon` slot that three pages already pass. No API changes, no new i18n keys, no nav changes.

**Tech Stack:** Nuxt 3 + Tailwind tokens (`apps/web/assets/css/globals.css` via `tailwind.config.ts`), shadcn-nuxt, vee-validate + zod, Jest source-grep + `tests/helpers/mount-sfc.ts` mount specs, Playwright e2e.

**Spec:** `docs/ux/redesign/MASTER-PLAN.md` (§2 visual direction, §3 hard constraints, §6 Slice 5, §7 working agreement) + `docs/ux/component-patterns.md` + `docs/ux/design-tokens.md`.

## Global Constraints

- Web strings: `apps/web/i18n/locales/{en,zh}.json`, both files, same keys. This slice adds **no new keys**; if a task ends up needing one, add it to both locales in the same commit.
- Do not move business logic into components. The Settings split moves **forms and API calls**, not workflow rules.
- Run logs and agent-written text use `{{ }}` only, never `v-html`.
- Never hardcode palette status colors (`bg-green-100`, `text-yellow-800`, raw hex in class strings). Status uses tokens via `lib/ticket-chips.ts`.
- State is never color alone: every colored dot ships with its i18n label, and the label must be on the **same template line** as the dot span (Playwright `getByText` does not whitespace-normalize).
- Do not touch `layouts/default.vue`, `TicketCard.vue`, `TicketBoard.vue`, chart wrappers (`*.client.vue`, unovis), `apps/cli/src/generated/`, or generated `AGENTS.md`.
- Do not edit `assets/css/globals.css` or `tailwind.config.ts` (no new tokens this slice).
- Verification per task: `cd apps/web && bunx jest <touched spec paths>` then full `bunx jest` before claiming the task done; `bunx eslint <changed files>`.
- `vue-tsc` reports pre-existing Nuxt auto-import type errors in `server/utils/api.ts` — not this slice's problem; do not "fix" it.
- Component files live **flat** in `apps/web/components/` (like `TicketHeader.vue`, `FilterBar.vue`) — not in subdirectories, so Nuxt pathPrefix auto-import names stay clean.

## Review Focus

1. **Source-grep spec breakage when strings move.** The settings specs grep `pages/[project]/settings.vue` source; moving the VCS form into a component breaks them unless the specs are updated to read the page + component as one surface in the **same commit**. Pin: Task 4 updates both specs in the same commit as the extraction.
2. **Playwright `getByText` whitespace.** A mustache on its own line renders `" X"` and breaks e2e journeys. Pin: every chip label stays on the same line as its dot span (Task 2 step 3).
3. **`loading-states.spec.ts` pins literal `v-if="pending"` / `v-else-if="error"` chains** on the agents page. Pin: the chip swap (Task 2) must not rewrite the state chain.
4. **e2e testids must survive the Settings split.** `owner`, `repo`, `token`, `provider`, `pollingInterval`, `authors`, `syncMode`, `webhook-secret` move into `SettingsVcsCard.vue` — DOM output must be byte-identical. Pin: Task 4 runs the settings e2e specs in Task 8's gate.
5. **i18n parity.** `tests/i18n/used-keys-exist.spec.ts` fails if any literal `t()` key is missing from either locale. Pin: no task adds a `t()` key without adding it to both `en.json` and `zh.json` (expected: none).

---

### Task 1: PageHeader icon slot

Three pages (`pages/[project]/memory.vue`, `pages/[project]/code-intel.vue`, `pages/admin/slos.vue`) already pass a `#icon` slot that `PageHeader` silently drops. Add the slot, rendered as a bordered muted square left of the title.

**Files:**
- Modify: `apps/web/components/PageHeader.vue`
- Test: `apps/web/tests/components/page-header.spec.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces: `PageHeader` with props `{ title: string; subtitle?: string }` (unchanged), `#actions` slot (unchanged), new `#icon` slot rendered inside a `flex h-10 w-10 items-center justify-center rounded-md border border-border bg-muted/40 text-muted-foreground` container. Later tasks rely on this rendering the existing `Brain`/`Code2`/`Activity` icons.

- [ ] **Step 1: Write the failing spec**

Create `apps/web/tests/components/page-header.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const source = readFileSync(join(webDir, 'components', 'PageHeader.vue'), 'utf-8')

describe('PageHeader icon slot', () => {
  test('renders an optional #icon slot before the title', () => {
    expect(source).toContain('<slot name="icon" />')
    expect(source.indexOf('<slot name="icon" />')).toBeGreaterThan(-1)
    expect(source.indexOf('<slot name="icon" />')).toBeLessThan(source.indexOf('<h1'))
  })

  test('icon sits in a bordered muted square', () => {
    expect(source).toContain('h-10 w-10')
    expect(source).toContain('rounded-md border border-border')
    expect(source).toContain('bg-muted/40')
  })

  test('title, subtitle and actions slots are unchanged', () => {
    expect(source).toContain('text-3xl font-bold tracking-tight')
    expect(source).toContain('v-if="subtitle"')
    expect(source).toContain('<slot name="actions" />')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bunx jest tests/components/page-header.spec.ts`
Expected: FAIL — `'<slot name="icon" />'` not found.

- [ ] **Step 3: Implement**

Replace `apps/web/components/PageHeader.vue` with:

```vue
<script setup lang="ts">
defineProps<{
  title: string
  subtitle?: string
}>()
</script>

<template>
  <div class="flex items-center justify-between">
    <div class="flex items-center gap-3">
      <div
        v-if="$slots.icon"
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40 text-muted-foreground"
      >
        <slot name="icon" />
      </div>
      <div>
        <h1 class="text-3xl font-bold tracking-tight">{{ title }}</h1>
        <p v-if="subtitle" class="mt-2 text-muted-foreground">{{ subtitle }}</p>
      </div>
    </div>
    <div class="flex items-center gap-2">
      <slot name="actions" />
    </div>
  </div>
</template>
```

- [ ] **Step 4: Normalize existing icon sizes**

In the three pages that pass `#icon`, the lucide icons must render at `h-5 w-5` inside the new container. Check `pages/[project]/memory.vue` (already `h-5 w-5`), `pages/[project]/code-intel.vue` and `pages/admin/slos.vue`; change any other size to `h-5 w-5`. No other edits to those pages in this task.

- [ ] **Step 5: Run tests and lint**

Run: `cd apps/web && bunx jest tests/components/page-header.spec.ts tests/pages/memory.spec.ts tests/pages/timeline.spec.ts tests/pages/code-intel.spec.ts tests/pages/code-intel-mount.spec.ts tests/pages/admin-slos-mount.spec.ts`
Expected: PASS (the icon-related assertions in those specs, if any, read the page source and are unaffected).

Run: `bunx eslint components/PageHeader.vue tests/components/page-header.spec.ts`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/PageHeader.vue apps/web/tests/components/page-header.spec.ts apps/web/pages/[project]/code-intel.vue apps/web/pages/admin/slos.vue
git commit -m "feat(web): render PageHeader #icon slot in a muted square (slice 5)"
```

---

### Task 2: Agent status chips (token-based)

Both agent pages hardcode palette classes (`bg-green-100 text-green-800` / `bg-yellow-100 text-yellow-800`) for agent status — the exact drift slice 3 eliminated for tickets. Replace with the shared dot+label chip. `tests/pages/agents.spec.ts` pins the palette classes; it is re-pinned to tokens **deliberately** (state never color alone). The global page's specs (`agents-standalone.spec.ts`, `agents.actions.spec.ts`) do not pin colors.

**Files:**
- Modify: `apps/web/pages/[project]/agents.vue`
- Modify: `apps/web/pages/agents.vue` (global `/agents` page — same `statusClass` helper at its lines ~89-92, same Badge-based status cell)
- Modify: `apps/web/tests/pages/agents.spec.ts` (AC3/AC4/AC5 describes only)
- Test: `apps/web/tests/pages/agents.spec.ts`, `tests/pages/agents-standalone.spec.ts`, `tests/pages/agents.actions.spec.ts`, `tests/pages/loading-states.spec.ts`

**Interfaces:**
- Consumes: `lib/ticket-chips.ts` exports `TICKET_CHIP_CLASS`, `TICKET_DOT_CLASS`, `statusDotClass(status: string): string` (exact, pinned by `tests/lib/ticket-chips.spec.ts`).
- Produces: `AGENT_STATUS_TOKEN: Record<string, string>` mapping `ACTIVE→'done'`, `PAUSED→'review'`, `OFFLINE→'todo'`, and `agentStatusDot(status: string): string` — defined identically in both pages.

- [ ] **Step 1: Re-pin the spec (write the failing test)**

In `apps/web/tests/pages/agents.spec.ts`, delete the three describes `US-006 AC3: ACTIVE status badge has green styling`, `US-006 AC4: PAUSED status badge has yellow styling`, and `US-006 AC5: OFFLINE status badge has gray/secondary styling` (they pin `bg-green-100`, `text-green-800`, `bg-yellow-100`, `text-yellow-800`, and the `secondary`/`bg-gray`/`text-gray` fallback) and replace with:

```ts
// ──────────────────────────────────────────────────────────────────────────────
// AC3–AC5 — status styling is token-based (UX redesign slice 5): the page maps
// each agent state to a ticket status token via lib/ticket-chips.ts and renders
// a dot+label chip. The palette classes (bg-green-100 etc.) were removed on
// purpose; state is never color alone — the i18n label always accompanies the dot.
// ──────────────────────────────────────────────────────────────────────────────

describe('US-006 AC3-AC5: status styling is token-based', () => {
  test('source maps ACTIVE to the done (green) status token', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain("ACTIVE: 'done'")
  })

  test('source maps PAUSED to the review (amber) status token', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain("PAUSED: 'review'")
  })

  test('source maps OFFLINE to the todo (muted) status token', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain("OFFLINE: 'todo'")
  })

  test('source renders dot+label chips via the shared chip classes', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('~/lib/ticket-chips')
    expect(source).toContain('TICKET_CHIP_CLASS')
    expect(source).toContain('TICKET_DOT_CLASS')
    expect(source).toContain('statusDotClass')
  })

  test('source no longer hardcodes palette status colors', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).not.toContain('bg-green-100')
    expect(source).not.toContain('text-green-800')
    expect(source).not.toContain('bg-yellow-100')
    expect(source).not.toContain('text-yellow-800')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bunx jest tests/pages/agents.spec.ts`
Expected: FAIL — `'~/lib/ticket-chips'` not found (and the palette-colors-absent assertion fails).

- [ ] **Step 3: Implement in `pages/[project]/agents.vue`**

In the script, add the import and replace the `statusClass` function:

```ts
import { TICKET_CHIP_CLASS, TICKET_DOT_CLASS, statusDotClass } from '~/lib/ticket-chips'

// Agent states reuse the ticket status dot tokens: ACTIVE is green (done),
// PAUSED is amber (review), OFFLINE is muted (todo). The i18n label always
// travels with the dot — state is never color alone.
const AGENT_STATUS_TOKEN: Record<string, string> = {
  ACTIVE: 'done',
  PAUSED: 'review',
  OFFLINE: 'todo',
}

function agentStatusDot(status: string) {
  return statusDotClass(AGENT_STATUS_TOKEN[status] ?? '')
}
```

Delete the old `statusClass` function. In the template, replace the status `TableCell` content:

```html
          <TableCell>
            <span :class="TICKET_CHIP_CLASS">
              <span :class="[TICKET_DOT_CLASS, agentStatusDot(agent.status)]" aria-hidden="true"></span>
              {{ t(`agents.status.${agent.status}`) }}
            </span>
          </TableCell>
```

The label mustache stays on the line **after** the dot span within the same chip — i.e. no blank line and no newline between the dot span's `>` and `{{` other than the single line break shown above; if a Playwright journey ever matches this label with a non-exact regex, move `{{ t(...) }}` onto the dot span's line. Do **not** touch the `v-if="pending"` / `v-else-if="error"` / `v-else-if="agents.length === 0"` chain or the roles/capabilities Badges.

- [ ] **Step 4: Implement the same change in `pages/agents.vue`**

Apply the identical import, `AGENT_STATUS_TOKEN`, `agentStatusDot` helper, and chip markup to the global page `apps/web/pages/agents.vue` (same `statusClass` helper, same Badge→chip replacement in its status cell). Its roles/capabilities Badges and the status DropdownMenu stay as they are.

- [ ] **Step 5: Run tests and lint**

Run: `cd apps/web && bunx jest tests/pages/agents.spec.ts tests/pages/agents-standalone.spec.ts tests/pages/agents.actions.spec.ts tests/pages/loading-states.spec.ts tests/lib/ticket-chips.spec.ts`
Expected: PASS. If `agents-standalone.spec.ts` or `agents.actions.spec.ts` pins anything about the old Badge, stop and report — they were verified not to (2026-10-06 grep).

Run: `bunx eslint pages/[project]/agents.vue pages/agents.vue tests/pages/agents.spec.ts`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/pages/\[project\]/agents.vue apps/web/pages/agents.vue apps/web/tests/pages/agents.spec.ts
git commit -m "feat(web): token-based dot+label chips for agent status (slice 5)"
```

---

### Task 3: Settings — extract `SettingsProjectCard`

The 502-line `pages/[project]/settings.vue` holds two independent forms. Extract the project form first (small, low risk). The VCS source-grep specs do **not** pin project-tab strings, so they stay green through this task.

**Files:**
- Create: `apps/web/components/SettingsProjectCard.vue`
- Modify: `apps/web/pages/[project]/settings.vue`

**Interfaces:**
- Consumes: `$api`/`useApi`, `useAppToast`, `apiPath` from `~/lib/api-path`, i18n keys `projects.settings.*`, `projects.form.*` (all exist).
- Produces: `SettingsProjectCard` with props `{ project: { id: string; name: string; slug: string; key: string; description?: string | null } }` and emit `(e: 'saved'): void`. The page passes `:project="projectData"` and `@saved="refreshProject()"`.

- [ ] **Step 1: Create `apps/web/components/SettingsProjectCard.vue`**

```vue
<script setup lang="ts">
import { extractApiError } from '~/composables/useApi'
import { apiPath } from '~/lib/api-path'

interface ProjectDetails {
  id: string
  name: string
  slug: string
  key: string
  description?: string | null
}

const props = defineProps<{
  project: ProjectDetails
}>()

const emit = defineEmits<{
  (e: 'saved'): void
}>()

const { $api } = useApi()
const { t } = useI18n()
const toast = useAppToast()

const projectForm = reactive({
  name: props.project.name,
  key: props.project.key,
  description: props.project.description ?? '',
})
const savingProject = ref(false)

watch(() => props.project, (project) => {
  if (!project) return
  projectForm.name = project.name
  projectForm.key = project.key
  projectForm.description = project.description ?? ''
})

async function saveProject() {
  const payload: Record<string, unknown> = {}
  if (projectForm.name !== props.project.name) payload.name = projectForm.name
  if (projectForm.key !== props.project.key) payload.key = projectForm.key
  if ((projectForm.description || '') !== (props.project.description ?? '')) payload.description = projectForm.description

  if (Object.keys(payload).length === 0) {
    toast.success(t('projects.settings.noChanges'))
    return
  }

  savingProject.value = true
  try {
    await $api.patch(apiPath`/projects/${props.project.slug}`, payload)
    toast.success(t('projects.settings.updated'))
    emit('saved')
  } catch (err) {
    toast.error(extractApiError(err))
  } finally {
    savingProject.value = false
  }
}

const deletingProject = ref(false)
async function deleteProject() {
  if (!window.confirm(t('projects.settings.deleteConfirm'))) return
  deletingProject.value = true
  try {
    await $api.delete(apiPath`/projects/${props.project.slug}`)
    toast.success(t('projects.settings.deleted'))
    await useRouter().push('/')
  } catch (err) {
    toast.error(extractApiError(err))
  } finally {
    deletingProject.value = false
  }
}
</script>

<template>
  <form class="space-y-4" @submit.prevent="saveProject">
    <div class="space-y-2">
      <FormLabel>{{ t('projects.form.name') }}</FormLabel>
      <Input v-model="projectForm.name" :placeholder="t('projects.form.namePlaceholder')" />
    </div>
    <div class="space-y-2">
      <FormLabel>{{ t('projects.form.key') }}</FormLabel>
      <Input v-model="projectForm.key" :placeholder="t('projects.form.keyPlaceholder')" />
    </div>
    <div class="space-y-2">
      <FormLabel>{{ t('projects.settings.projectDescription') }}</FormLabel>
      <Textarea v-model="projectForm.description" :placeholder="t('projects.settings.projectDescriptionPlaceholder')" />
    </div>

    <div class="flex flex-wrap gap-3">
      <Button type="submit" :disabled="savingProject">
        {{ savingProject ? t('common.loading') : t('projects.settings.save') }}
      </Button>
      <Button type="button" variant="destructive" :disabled="deletingProject" @click="deleteProject">
        {{ deletingProject ? t('common.loading') : t('projects.settings.delete') }}
      </Button>
    </div>
  </form>
</template>
```

- [ ] **Step 2: Slim the page**

In `apps/web/pages/[project]/settings.vue`: delete `projectForm`, `savingProject`, `saveProject`, `deletingProject`, `deleteProject`, and the `watch(projectData, ...)` pre-fill. Replace the project tab's `<form>…</form>` block with:

```html
            <LoadingState v-if="loadingProject" />
            <ErrorState v-else-if="projectError" @retry="refreshProject()" />

            <SettingsProjectCard
              v-else-if="projectData"
              :project="projectData"
              @saved="refreshProject()"
            />
```

Keep the card's heading (`projects.settings.title` / `.description`), the surrounding `rounded-md border border-border p-6 space-y-6` div, and `<ProjectMembersPanel :slug="slug" />` in the page. Delete is now handled by the card (it navigates to `/` itself); the page no longer needs `router` for delete — keep `useRouter()` only if still referenced.

- [ ] **Step 3: Run tests and lint**

Run: `cd apps/web && bunx jest tests/pages/settings-vcs-tab.spec.ts tests/pages/settings-vcs-webhook-secret.spec.ts tests/i18n/used-keys-exist.spec.ts`
Expected: PASS (nothing these specs pin moved).

Run: `bunx eslint components/SettingsProjectCard.vue pages/[project]/settings.vue`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/SettingsProjectCard.vue apps/web/pages/\[project\]/settings.vue
git commit -m "refactor(web): extract SettingsProjectCard from settings page (slice 5)"
```

---

### Task 4: Settings — extract `SettingsVcsCard` + union-surface spec update

The big extraction. The two source-grep specs (`tests/pages/settings-vcs-tab.spec.ts`, `tests/pages/settings-vcs-webhook-secret.spec.ts`) pin VCS strings that move into the component, so they are updated **in the same commit** to read page + component as one surface — the slice-1 precedent (MASTER-PLAN §10, 2026-10-05): assertions unchanged in intent, only what they read.

**Files:**
- Create: `apps/web/components/SettingsVcsCard.vue`
- Modify: `apps/web/pages/[project]/settings.vue`
- Modify: `apps/web/tests/pages/settings-vcs-tab.spec.ts`
- Modify: `apps/web/tests/pages/settings-vcs-webhook-secret.spec.ts`

**Interfaces:**
- Consumes: same composable/`apiPath` stack as Task 3; i18n keys `vcs.*` (all exist).
- Produces: `SettingsVcsCard` with props `{ connection: { provider: string; repoOwner: string; repoName: string; syncMode: 'off' | 'polling' | 'webhook'; pollingIntervalMs: number; allowedAuthors: string[] } | null }` and emit `(e: 'changed'): void`. The page passes `:connection="existingConnection"` and `@changed="refreshConnection()"`. All e2e testids (`provider`, `owner`, `repo`, `token`, `syncMode`, `pollingInterval`, `authors`, `webhook-secret`) render from the component, DOM-identical to today.

- [ ] **Step 1: Create `apps/web/components/SettingsVcsCard.vue`**

Move **verbatim** from the page into the new component's script: the `VcsConnection`, `VcsConnectionWithSecret`, `SyncResult` interfaces; the zod `formSchema`; the `useForm` block; the `watch(existingConnection, …)` pre-fill; `onSubmit`; `revealedSecret`/`revealSecret`/`copySecret`; `rotatingSecret`/`rotateSecret`; `testingConnection`/`testConnection`; `syncing`/`syncNow`; `syncingPr`/`syncPrStatus`; `disconnect`. The only mechanical changes:

- `defineProps<{ connection: VcsConnection | null }>()`, `const emit = defineEmits<{ (e: 'changed'): void }>()`
- `const existingConnection = computed(() => props.connection)`
- every `existingConnection.value` stays as-is (it is now the computed over props)
- `await refreshConnection()` inside `onSubmit` and `disconnect` becomes `emit('changed')`
- the script needs `import { extractApiError } from '~/composables/useApi'` (the `ApiError` import and the 404-tolerant connection fetch stay in the page) and `import { apiPath } from '~/lib/api-path'`.

Move **verbatim** into the component's template: the entire `<form v-else @submit="onSubmit" class="space-y-6">…</form>` block (provider/owner/repo/token/syncMode/pollingInterval/authors fields and the action row) **and** the `revealedSecret` box (`data-testid="webhook-secret"`). The `v-else` on the form no longer applies (loading/error stay in the page) — make it a plain `<form @submit="onSubmit" class="space-y-6">`.

Do not reword any comment (the M9 comment and the GitLab polling-only comment move with their code). Do not rename `created`/`updated`/`skipped` in the `syncComplete` toast params (the spec pins those literals).

- [ ] **Step 2: Slim the page**

In `apps/web/pages/[project]/settings.vue`: delete everything listed in Step 1 from the page script (interfaces, schema, form, all VCS handlers, `revealedSecret`), keeping: `definePageMeta`, `route`/`slug`, `useApi`/`useI18n`/`useAppToast` (drop any now-unused), the 404-tolerant `useAsyncData` for the connection (with `ApiError` import), `existingConnection` computed, the project `useAsyncData`, and `refreshConnection`/`refreshProject`. Replace the VCS tab's form + secret box with:

```html
          <LoadingState v-if="loadingConnection" />
          <ErrorState v-else-if="connectionError" @retry="refreshConnection()" />

          <SettingsVcsCard
            v-else
            :connection="existingConnection"
            @changed="refreshConnection()"
          />
```

Keep the VCS card heading (`vcs.title` / `vcs.description`) and the bordered wrapper in the page. The page should now be ~140 lines.

- [ ] **Step 3: Update both specs to read the union surface**

In **both** `tests/pages/settings-vcs-tab.spec.ts` and `tests/pages/settings-vcs-webhook-secret.spec.ts`, replace the single `source` construction with:

```ts
const settingsPath = join(webDir, 'pages', '[project]', 'settings.vue')
const vcsCardPath = join(webDir, 'components', 'SettingsVcsCard.vue')

const pageSource = readFileSync(settingsPath, 'utf-8')
const cardSource = readFileSync(vcsCardPath, 'utf-8')
// Slice 5 split the settings page into form components; the VCS assertions now
// read the page + VCS card as one surface (slice-1 precedent — assertions
// unchanged in intent, only in what they read).
const source = `${pageSource}\n${cardSource}`
```

Keep every existing assertion **exactly as it is** (including the file-exists check on the page path, the Tabs assertions — the page still contains them — and the negative assertions on hardcoded `'Provider'`/`'Token'`/`'Owner'`, which now run against the union). Do not add or remove assertions. If an assertion fails after this change, that is a real regression in the split — fix the component, not the assertion, unless the assertion pins the *page file specifically* (only AC1's `existsSync(settingsPath)` may).

- [ ] **Step 4: Run tests and lint**

Run: `cd apps/web && bunx jest tests/pages/settings-vcs-tab.spec.ts tests/pages/settings-vcs-webhook-secret.spec.ts tests/i18n/vcs-complete-i18n.spec.ts tests/i18n/used-keys-exist.spec.ts tests/layouts/vcs-phase1-settings-link.spec.ts`
Expected: PASS.

Run: `bunx eslint components/SettingsVcsCard.vue pages/[project]/settings.vue tests/pages/settings-vcs-tab.spec.ts tests/pages/settings-vcs-webhook-secret.spec.ts`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/SettingsVcsCard.vue apps/web/pages/\[project\]/settings.vue apps/web/tests/pages/settings-vcs-tab.spec.ts apps/web/tests/pages/settings-vcs-webhook-secret.spec.ts
git commit -m "refactor(web): extract SettingsVcsCard; settings specs read page+card as one surface (slice 5)"
```

---

### Task 5: FilterBar on memory + timeline filter rows

The memory page (2 native selects) and timeline page (1 select + 2 date inputs) hand-roll `flex flex-wrap items-end gap-3` filter rows. Wrap them in the shared `FilterBar` (slice 3 pattern) so all filter rows share one grid. The `memory.spec.ts` / `memory-mount.spec.ts` / `timeline.spec.ts` pins target the wiring (`withToastError`, `applyAndToast`, `v-if` chains) and the selects themselves — not the container div — so this is safe; the mount spec may need a `FilterBar` stub.

**Files:**
- Modify: `apps/web/pages/[project]/memory.vue`
- Modify: `apps/web/pages/[project]/timeline.vue`
- Possibly modify: `apps/web/tests/pages/memory-mount.spec.ts`, `apps/web/tests/pages/timeline.spec.ts` (stub only, see Step 3)

**Interfaces:**
- Consumes: `components/FilterBar.vue` props `{ columns?: '3' | '4' }` (default `'4'`), slot-only — pinned by `tests/components/filter-bar.spec.ts`.
- Produces: nothing downstream.

- [ ] **Step 1: memory.vue**

Replace the filter row's outer `<div class="flex flex-wrap items-end gap-3">` … `</div>` with `<FilterBar columns="3">` … `</FilterBar>`. The two label+select blocks inside move over unchanged (they become grid items). Do not touch the selects' `v-model`/`@change="applyAndToast"` wiring.

- [ ] **Step 2: timeline.vue**

Same replacement on the timeline page (its three filter blocks become grid items of `<FilterBar columns="3">`). Wiring untouched.

- [ ] **Step 3: Fix any mount-spec fallout**

Run: `cd apps/web && bunx jest tests/pages/memory.spec.ts tests/pages/memory-mount.spec.ts tests/pages/timeline.spec.ts`

If a mount spec fails with an unresolved `FilterBar` component, add a stub to that spec's mount options (mount-sfc's `components` option), e.g. `components: { FilterBar: { template: '<div><slot /></div>' } }`, keeping all behavioral assertions untouched. Do not weaken assertions.

Expected: PASS.

- [ ] **Step 4: Lint and commit**

Run: `bunx eslint pages/[project]/memory.vue pages/[project]/timeline.vue`
Expected: clean.

```bash
git add apps/web/pages/\[project\]/memory.vue apps/web/pages/\[project\]/timeline.vue
git commit -m "feat(web): shared FilterBar grid on memory and timeline filter rows (slice 5)"
```

---

### Task 6: Auth layout polish

`layouts/auth.vue` is a bare centered card. Give it a small brand mark above the card. The `tests/layouts/auth.spec.ts` pins (`<Card`, centering classes, `min-h-screen`, `<slot />`, no `console.log`) all survive. `pages/login.vue` and `pages/register.vue` are **not touched** (register's root class is pinned exactly).

**Files:**
- Modify: `apps/web/layouts/auth.vue`

**Interfaces:**
- Consumes: shadcn `Card`/`CardContent` (as today).
- Produces: nothing downstream.

- [ ] **Step 1: Implement**

Replace `apps/web/layouts/auth.vue` with:

```vue
<template>
  <div class="flex min-h-screen items-center justify-center bg-background px-4">
    <div class="w-full max-w-md">
      <div class="mb-8 flex items-center justify-center gap-2.5">
        <span
          class="flex h-8 w-8 items-center justify-center rounded-md bg-primary font-bold text-primary-foreground"
          aria-hidden="true"
        >
          K
        </span>
        <span class="text-lg font-semibold tracking-tight">Koda</span>
      </div>
      <Card class="w-full max-w-md">
        <CardContent class="pt-6">
          <slot />
        </CardContent>
      </Card>
    </div>
  </div>
</template>
```

"Koda" is a brand name and stays a literal (not a `t()` key) — consistent with the logo elsewhere; no i18n change.

- [ ] **Step 2: Run tests and lint**

Run: `cd apps/web && bunx jest tests/layouts/auth.spec.ts tests/pages/login.spec.ts tests/pages/register.spec.ts`
Expected: PASS.

Run: `bunx eslint layouts/auth.vue`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/layouts/auth.vue
git commit -m "feat(web): brand mark on the auth layout (slice 5)"
```

---

### Task 7: Conformance verification — Labels, KB, Code Intel, admin Users/SLOs

These pages already follow the pattern stack (PageHeader, LoadingState/ErrorState/EmptyState, shadcn Table, form stack, destructive confirms). Code Intel gets its `#icon` rendered by Task 1 but is otherwise intentionally untouched (its search row is a single control + button — `FilterBar` is for multi-filter rows). This task verifies rather than changes: run their full spec sets and confirm **no source changes are needed**. Only fix a deviation if a spec reveals one.

**Files:**
- None expected to change. `pages/admin/slos.vue` icon size only if Task 1 Step 4 left it non-`h-5 w-5`.

- [ ] **Step 1: Run the page spec sets**

Run: `cd apps/web && bunx jest tests/pages/labels.spec.ts tests/pages/labels-validation.spec.ts tests/pages/labels-safe-color.spec.ts tests/pages/label-color-picker.spec.ts tests/i18n/labels-validation-i18n.spec.ts tests/components/KbAddDocumentDialog.spec.ts tests/components/KbResultCard.spec.ts tests/components/KbVerdictBanner.spec.ts tests/pages/code-intel.spec.ts tests/pages/code-intel-mount.spec.ts tests/layouts/code-intel-nav.spec.ts tests/pages/loading-states.spec.ts tests/pages/admin-users.spec.ts tests/pages/admin-slos-mount.spec.ts tests/composables/useAdminUsers.spec.ts`
Expected: PASS with no source edits. If something fails, fix minimally in the offending page and note it in the PR description.

- [ ] **Step 2: Record the outcome**

Note in the commit message body: "labels/KB/admin conformance verified, no source changes required" (or list the minimal fixes).

- [ ] **Step 3: Commit (if anything changed) or skip**

```bash
git add -A apps/web && git commit -m "chore(web): slice 5 conformance fixes for labels/KB/code-intel/admin pages" || true
```

---

### Task 8: Docs, master plan, full gates, e2e, visual check

**Files:**
- Modify: `docs/ux/redesign/MASTER-PLAN.md` (§4 status row 5, §10 decisions log)
- Modify: `docs/ux/component-patterns.md` (PageHeader icon pattern + agent chips note)

**Interfaces:**
- Consumes: everything above, complete.
- Produces: the master plan updated for the next session.

- [ ] **Step 1: Full unit gate**

Run: `cd apps/web && bunx jest`
Expected: all pass (baseline 2,932+ plus the new page-header spec).

Run: `git diff --name-only main | grep -E '\.(vue|ts)$' | grep -v generated | xargs bunx eslint` (from `apps/web`)
Expected: clean.

- [ ] **Step 2: Docs**

In `docs/ux/component-patterns.md`, add under the existing patterns:
- **PageHeader icon**: pages with a natural lucide icon pass `<template #icon><Icon class="h-5 w-5" /></template>`; PageHeader renders it in a `h-10 w-10` bordered muted square.
- **Agent status chips**: agent ACTIVE/PAUSED/OFFLINE map to ticket status tokens via `AGENT_STATUS_TOKEN` (`done`/`review`/`todo`) + `statusDotClass`; dot+label chip from `lib/ticket-chips.ts`, never palette classes.

In `docs/ux/redesign/MASTER-PLAN.md`:
- §4 Status row 5 → `**Done** — feat/web-ux-slice-5 (settings split into SettingsProjectCard/SettingsVcsCard, token agent chips, PageHeader icon slot, FilterBar on memory/timeline, auth brand mark)`.
- §10 add these decisions (dated 2026-10-06):
  1. Slice 5: Settings kept its existing two Tabs (project / VCS); the 502-line file was split into `SettingsProjectCard` + `SettingsVcsCard` instead of adding a sticky section nav — with only two sections a sticky nav is chrome, not UX.
  2. Slice 5: agent status chips map ACTIVE/PAUSED/OFFLINE to the ticket status tokens done/review/todo; `tests/pages/agents.spec.ts` palette pins replaced with token pins (deliberate spec change).
  3. Slice 5: settings source-grep specs read page + SettingsVcsCard as one surface (slice-1 precedent); e2e testids unchanged.
  4. Slice 5: no mock previews — every change reuses an established pattern (chips, FilterBar, PageHeader) rather than introducing a new layout.
  5. Slice 5: login/register pages untouched (register's root class is pinned; both already conform) — only the auth layout gained a brand mark.
- §6 Slice 5 bullet: leave as history; the status table is the live state.

- [ ] **Step 3: e2e (settings, auth, agents)**

Requires the running stack (MASTER-PLAN §9): API on test Postgres (`cd apps/api && bun run test:db:up`, `prisma db push`, seed) and web via `E2E_RUN=1 bunx nuxt dev --port 3101` (plain `bun run dev` 500s — devtools bug). Then:

Run: `cd apps/web && bunx playwright test tests/e2e/vcs-integration-settings.e2e.spec.ts tests/e2e/settings-project-vcs-sync-pr.e2e.spec.ts tests/e2e/auth.spec.ts`
Expected: PASS — this proves the Settings split kept the DOM (testids, tab roles, button names) and the auth layout kept the form flow. If the environment cannot be booted, state that explicitly in the PR description instead of claiming it ran.

- [ ] **Step 4: Visual check**

Screenshot the changed surfaces in the running app (light + dark, and 375px width for settings/auth): project settings (both tabs), an agents page, memory, timeline, `/login`. Dispatch the visual-judge subagent on the PNGs and fix anything it rejects (spacing, contrast, broken icons) before finishing.

- [ ] **Step 5: Commit docs and finish**

```bash
git add docs/ux/redesign/MASTER-PLAN.md docs/ux/component-patterns.md
git commit -m "docs(ux): slice 5 status + decisions in master plan; icon and agent-chip patterns"
```

Do **not** push or open a PR — the user asks for that explicitly.
