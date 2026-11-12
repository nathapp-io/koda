<script setup lang="ts">
import { computed, defineComponent, h, ref, watch } from 'vue'
import { extractApiError } from '~/composables/useApi'
import { useProviderCredentials, type ProviderCredentialRow } from '~/composables/useProviderCredentials'
import { providerCredentialFormSchema, providerKeySchema } from '~/lib/provider-credentials'
import { apiPath } from '~/lib/api-path'

const props = defineProps<{ slug: string }>()
const { t } = useI18n()
const toast = useAppToast()
const { $api } = useApi()
const { permissions } = useProjectPermissions(props.slug)
const vault = useProviderCredentials({ kind: 'project', slug: props.slug })
interface Repo { id: string; owner: string; name: string }
const repos = ref<Repo[]>([])
const can = (key: string) => permissions.value.has(key)
const canRead = computed(() => can('project.credential.read'))
const form = ref({ scope: 'PROJECT' as 'PROJECT' | 'REPO', repoId: '', providerId: '', name: '', key: '' })
const rotateKeys = ref<Record<string, string>>({})
const pendingNotice = ref(false)
/**
 * B2: one write in flight per row (plus `adding` for the add form), like the GLOBAL page. Without it a completed
 * rotation left the row's field and actions live, so a key typed while the PATCH was outstanding could be erased by
 * the response that was already on its way; `clearSubmittedDraft` keeps even that from happening.
 */
const saving = ref<Record<string, boolean>>({})
const adding = ref(false)
const isSaving = (id: string) => saving.value[id] === true
function setSaving(id: string, busy: boolean): void {
  const next = { ...saving.value }
  if (busy) next[id] = true
  else delete next[id]
  saving.value = next
}
/** Only the draft that was submitted is cleared: a key typed meanwhile is the user's next rotation, not leftovers. */
function clearSubmittedDraft(id: string, submitted: string): void {
  if ((rotateKeys.value[id] ?? '') === submitted) rotateKeys.value[id] = ''
}
const repoName = (id: string | null) => { const repo = repos.value.find(item => item.id === id); return repo ? `${repo.owner}/${repo.name}` : t('fleet.providerKeys.unknownRepo') }
const projects = computed(() => vault.credentials.value.filter(row => row.scope === 'PROJECT'))
const repoRows = computed(() => vault.credentials.value.filter(row => row.scope === 'REPO'))
const CredentialRows = defineComponent({
  props: { rows: { type: Array as () => ProviderCredentialRow[], required: true }, canUpdate: Boolean, canDelete: Boolean, saving: { type: Object as () => Record<string, boolean>, required: true } },
  emits: ['rotate', 'disable', 'enable', 'remove'],
  setup(props, { emit }) {
    const busy = (id: string) => props.saving[id] === true
    return () => h('div', { class: 'space-y-2' }, props.rows.map(row => h('div', { key: row.id, class: 'rounded-md border border-border p-3 space-y-2' }, [
      h('div', { class: 'flex flex-wrap items-center gap-2' }, [h('span', `${row.providerId} · ${row.name}`), h('code', `•••• ${row.last4}`), h('code', row.fingerprint), h('span', row.disabled ? t('fleet.providerKeys.disabled') : t('fleet.providerKeys.enabled'))]),
      props.canUpdate ? h('div', { class: 'flex flex-wrap gap-2' }, [h('input', { 'aria-label': t('fleet.providerKeys.newKey'), type: 'password', value: rotateKeys.value[row.id] ?? '', disabled: busy(row.id), 'data-testid': `provider-key-rotate-input-${row.id}`, onInput: (event: Event) => { rotateKeys.value[row.id] = (event.target as HTMLInputElement).value } }), h('button', { type: 'button', disabled: busy(row.id), 'data-testid': `provider-key-rotate-${row.id}`, onClick: () => emit('rotate', row) }, t('fleet.providerKeys.rotate')), h('button', { type: 'button', disabled: busy(row.id), 'data-testid': `provider-key-${row.disabled ? 'enable' : 'disable'}-${row.id}`, onClick: () => emit(row.disabled ? 'enable' : 'disable', row) }, t(row.disabled ? 'fleet.providerKeys.enable' : 'fleet.providerKeys.disable'))]) : null,
      props.canDelete ? h('button', { type: 'button', disabled: busy(row.id), 'data-testid': `provider-key-delete-${row.id}`, onClick: () => emit('remove', row) }, t('fleet.providerKeys.delete')) : null,
    ])))
  },
})
async function loadRepositories(): Promise<void> {
  const all: Repo[] = []
  let page = 1
  let hasNext = true
  while (hasNext) {
    const result = await $api.get<{ records?: Repo[]; hasNext?: boolean }>(apiPath`/projects/${props.slug}/fleet/repos`, {
      query: { size: '100', ...(page > 1 ? { current: String(page) } : {}) },
    })
    all.push(...(result.records ?? []))
    hasNext = result.hasNext === true
    page += 1
  }
  repos.value = all
}
/**
 * The loading text shows until the first load settles, not while `vault.pending` is true: on the server no
 * load has started, so `pending` alone renders a different branch there than on the hydrating client (R2-15).
 */
const firstLoadSettled = ref(false)
async function load(targetPage?: number): Promise<void> {
  if (!canRead.value) return
  try {
    await Promise.all([vault.load(targetPage), loadRepositories()])
  } catch (err) { toast.error(extractApiError(err)) } finally { firstLoadSettled.value = true }
}
watch(canRead, (allowed) => { if (allowed) void load() }, { immediate: true })
function report(err: unknown) { toast.error(extractApiError(err)) }
async function create() {
  if (adding.value) return
  const parsed = providerCredentialFormSchema(t).safeParse({ providerId: form.value.providerId, name: form.value.name, key: form.value.key })
  if (!parsed.success) { toast.error(parsed.error.issues[0]?.message ?? t('fleet.providerKeys.validation.invalid')); return }
  if (form.value.scope === 'REPO' && !form.value.repoId) { toast.error(t('fleet.providerKeys.validation.repoRequired')); return }
  const submitted = parsed.data.key
  adding.value = true
  try {
    const result = await vault.create({ ...parsed.data, ...(form.value.scope === 'REPO' ? { repoId: form.value.repoId } : {}) })
    if (result.kind === 'pending') pendingNotice.value = true
    else {
      pendingNotice.value = false
      if (form.value.key === submitted) form.value.key = ''
      await load()
    }
  } catch (err) { report(err) } finally { adding.value = false }
}
async function rotate(row: ProviderCredentialRow) {
  if (isSaving(row.id)) return
  const key = rotateKeys.value[row.id] ?? ''
  const parsed = providerKeySchema(t).safeParse(key)
  if (!parsed.success) { toast.error(parsed.error.issues[0]?.message ?? t('fleet.providerKeys.validation.invalid')); return }
  setSaving(row.id, true)
  try {
    const result = await vault.rotate(row.id, { key })
    if (result.kind === 'pending') pendingNotice.value = true
    else { clearSubmittedDraft(row.id, key); await load() }
  } catch (err) { report(err) } finally { setSaving(row.id, false) }
}
async function setDisabled(row: ProviderCredentialRow, disabled: boolean) {
  if (isSaving(row.id)) return
  setSaving(row.id, true)
  try { const result = await vault.setDisabled(row.id, disabled); if (result.kind === 'pending') pendingNotice.value = true } catch (err) { report(err) } finally { setSaving(row.id, false) }
}
async function remove(row: ProviderCredentialRow) {
  if (isSaving(row.id)) return
  // B2/M2: `deleteConfirm` interpolates `{provider}` — the credential's provider id, as the GLOBAL page passes it.
  if (!window.confirm(t('fleet.providerKeys.deleteConfirm', { provider: row.providerId }))) return
  setSaving(row.id, true)
  try { const result = await vault.remove(row.id); if (result.kind === 'pending') pendingNotice.value = true } catch (err) { report(err) } finally { setSaving(row.id, false) }
}
</script>

<template>
  <section class="rounded-md border border-border p-6 space-y-5" data-testid="provider-keys-card">
    <header><h2 class="text-lg font-semibold">{{ t('fleet.providerKeys.projectTitle') }}</h2><p class="text-sm text-muted-foreground">{{ t('fleet.providerKeys.projectDescription') }}</p></header>
    <div v-if="pendingNotice" role="status" class="rounded-md border border-amber-500/50 p-3 text-sm">{{ t('fleet.providerKeys.pending') }}</div>
    <div v-if="canRead && !firstLoadSettled" class="text-sm text-muted-foreground">{{ t('common.loading') }}</div>
    <div v-else-if="!canRead" class="text-sm text-muted-foreground">{{ t('fleet.providerKeys.noReadPermission') }}</div>
    <template v-else>
      <div v-if="projects.length" class="space-y-2"><h3 class="font-medium">{{ t('fleet.providerKeys.projectScope') }}</h3><CredentialRows :rows="projects" :saving="saving" :can-update="can('project.credential.update')" :can-delete="can('project.credential.delete')" @rotate="rotate" @disable="setDisabled($event, true)" @enable="setDisabled($event, false)" @remove="remove" /></div>
      <div v-for="group in [...new Set(repoRows.map(row => row.repoId ?? ''))]" :key="group" class="space-y-2"><h3 class="font-medium">{{ repoName(group || null) }}</h3><CredentialRows :rows="repoRows.filter(row => row.repoId === group)" :saving="saving" :can-update="can('project.credential.update')" :can-delete="can('project.credential.delete')" @rotate="rotate" @disable="setDisabled($event, true)" @enable="setDisabled($event, false)" @remove="remove" /></div>
      <div v-if="vault.hasPrev.value || vault.hasNext.value" class="flex items-center gap-2">
        <Button type="button" variant="outline" :disabled="vault.pending.value || !vault.hasPrev.value" data-testid="provider-keys-prev" @click="load(vault.current.value - 1)">{{ t('fleet.providerKeys.pager.prev') }}</Button>
        <span class="text-sm text-muted-foreground">{{ t('fleet.providerKeys.pager.info', { current: vault.current.value, total: vault.total.value }) }}</span>
        <Button type="button" variant="outline" :disabled="vault.pending.value || !vault.hasNext.value" data-testid="provider-keys-next" @click="load(vault.current.value + 1)">{{ t('fleet.providerKeys.pager.next') }}</Button>
      </div>
      <div v-if="can('project.credential.create')" class="space-y-3 border-t border-border pt-4">
        <h3 class="font-medium">{{ t('fleet.providerKeys.addTitle') }}</h3>
        <div class="flex flex-wrap gap-2"><Button type="button" data-testid="provider-key-scope-project" :variant="form.scope === 'PROJECT' ? 'default' : 'outline'" @click="form.scope = 'PROJECT'">{{ t('fleet.providerKeys.projectScope') }}</Button><Button type="button" data-testid="provider-key-scope-repo" :variant="form.scope === 'REPO' ? 'default' : 'outline'" @click="form.scope = 'REPO'">{{ t('fleet.providerKeys.repoScope') }}</Button></div>
        <Select v-if="form.scope === 'REPO'" v-model="form.repoId"><SelectTrigger><SelectValue :placeholder="t('fleet.providerKeys.repoPlaceholder')" /></SelectTrigger><SelectContent><SelectItem v-for="repo in repos" :key="repo.id" :value="repo.id">{{ repo.owner }}/{{ repo.name }}</SelectItem></SelectContent></Select>
        <Input v-model="form.providerId" data-testid="provider-key-provider" :placeholder="t('fleet.providerKeys.providerId')" /><Input v-model="form.name" data-testid="provider-key-name" :placeholder="t('fleet.providerKeys.name')" /><Input v-model="form.key" data-testid="provider-key-secret" type="password" :placeholder="t('fleet.providerKeys.key')" autocomplete="new-password" />
        <Button type="button" data-testid="provider-key-add" :disabled="adding" @click="create">{{ t('fleet.providerKeys.add') }}</Button>
      </div>
    </template>
  </section>
</template>

