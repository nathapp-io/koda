<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent class="max-h-[90vh] overflow-y-auto sm:max-w-[720px]">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription v-if="readOnly">{{ t('admin.roles.form.lockedHint') }}</DialogDescription>
      </DialogHeader>

      <form v-if="open" class="space-y-4" data-testid="role-form" @submit="onSubmit">
        <div v-if="role" class="text-sm text-muted-foreground">
          <code>{{ role.key }}</code> · {{ t(`admin.roles.scope.${role.scope}`) }}
        </div>

        <div v-if="!role" class="space-y-1">
          <Label for="role-key">{{ t('admin.roles.form.key') }}</Label>
          <Input id="role-key" v-model="key" data-testid="role-key" autocomplete="off" />
          <p class="text-xs text-muted-foreground">{{ t('admin.roles.form.keyHint') }}</p>
          <p v-if="errors.key" class="text-sm font-medium text-status-rejected">{{ errors.key }}</p>
        </div>

        <div class="space-y-1">
          <Label for="role-name">{{ t('admin.roles.form.name') }}</Label>
          <Input id="role-name" v-model="name" data-testid="role-name" :disabled="nameReadOnly" />
          <p v-if="errors.name" class="text-sm font-medium text-status-rejected">{{ errors.name }}</p>
        </div>

        <div class="space-y-1">
          <Label for="role-description">{{ t('admin.roles.form.description') }}</Label>
          <Textarea id="role-description" v-model="description" data-testid="role-description" :disabled="readOnly" />
          <p v-if="errors.description" class="text-sm font-medium text-status-rejected">{{ errors.description }}</p>
        </div>

        <div v-if="!role" class="space-y-1">
          <Label for="role-scope">{{ t('admin.roles.form.scope') }}</Label>
          <select
            id="role-scope"
            data-testid="role-scope"
            class="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            :value="scope"
            @change="onScopeChange(($event.target as HTMLSelectElement).value as RoleScope)"
          >
            <option value="PROJECT">{{ t('admin.roles.scope.PROJECT') }}</option>
            <option value="GLOBAL">{{ t('admin.roles.scope.GLOBAL') }}</option>
          </select>
        </div>

        <div class="space-y-2">
          <h3 class="text-sm font-semibold">{{ t('admin.roles.form.permissions') }}</h3>
          <PermissionMatrix :selection="selection" :rows="rows" :covered="covered" :disabled="readOnly" @choose="onChoose" />
        </div>

        <div class="space-y-2">
          <h3 class="text-sm font-semibold">{{ t('admin.roles.entries.title') }}</h3>
          <p class="text-xs text-muted-foreground">{{ t('admin.roles.entries.hint') }}</p>
          <div class="flex flex-wrap gap-2" data-testid="entry-chips">
            <span
              v-for="entry in chips"
              :key="entry"
              class="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs"
              data-testid="entry-chip"
              :data-entry="entry"
            >
              <code>{{ entry }}</code>
              <button
                type="button"
                data-testid="entry-remove"
                :disabled="readOnly"
                :aria-label="t('admin.roles.entries.remove', { entry })"
                @click="removeEntry(entry)"
              >
                <X class="h-3 w-3" />
              </button>
            </span>
          </div>
          <div class="flex gap-2">
            <Input
              v-model="entryText"
              data-testid="entry-input"
              :disabled="readOnly"
              :placeholder="t('admin.roles.entries.placeholder')"
              @keydown.enter.prevent="addEntry"
            />
            <Button type="button" variant="outline" data-testid="entry-add" :disabled="readOnly" @click="addEntry">
              {{ t('admin.roles.entries.add') }}
            </Button>
          </div>
        </div>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" @click="$emit('update:open', false)">{{ t('common.cancel') }}</Button>
          <Button v-if="!readOnly" type="submit" data-testid="role-save" :disabled="isSubmitting || !ready">
            {{ isSubmitting ? t('admin.roles.form.saving') : t('admin.roles.form.save') }}
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { X } from 'lucide-vue-next'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import * as z from 'zod'
import PermissionMatrix from '~/components/PermissionMatrix.vue'
import { extractApiError } from '~/composables/useApi'
import {
  ROLE_KEY_PATTERN, buildPermissions, coveredKeys, rowsFor, splitPermissions,
} from '~/lib/role-editor'
import type { MatrixSelection, RowChoice } from '~/lib/role-editor'
import type { CatalogEntry, Role, RoleScope } from '~/composables/useRoles'

const props = defineProps<{
  open: boolean
  /** The role being edited, or null to create one. */
  role: Role | null
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'saved'): void
}>()

const { t } = useI18n()
const toast = useAppToast()
const { loadCatalog, create, update } = useRoles()

/** A locked role (the owner) opens read-only; a system role keeps its name. */
const readOnly = computed(() => props.role?.locked === true)
const nameReadOnly = computed(() => readOnly.value || props.role?.system === true)
const title = computed(() => {
  if (!props.role) return t('admin.roles.form.createTitle')
  return t(readOnly.value ? 'admin.roles.form.viewTitle' : 'admin.roles.form.editTitle', { name: props.role.name })
})

// `key` is checked only while creating: a saved role's key never changes and is not sent.
const formSchema = toTypedSchema(z.object({
  key: z.string().refine((value) => props.role !== null || ROLE_KEY_PATTERN.test(value), t('admin.roles.form.keyFormat')),
  name: z.string().trim().min(1, t('admin.roles.form.nameRequired')).max(100, t('admin.roles.form.nameTooLong')),
  description: z.string().max(500, t('admin.roles.form.descriptionTooLong')),
  scope: z.enum(['GLOBAL', 'PROJECT']),
}))

const { handleSubmit, isSubmitting, resetForm, defineField, errors } = useForm({
  validationSchema: formSchema,
  initialValues: { key: '', name: '', description: '', scope: 'PROJECT' as RoleScope },
})
const [key] = defineField('key')
const [name] = defineField('name')
const [description] = defineField('description')
const [scope] = defineField('scope')

const catalog = ref<CatalogEntry[]>([])
const chips = ref<string[]>([])
const selection = ref<MatrixSelection>({})
/** The explicit rows the saved role lists: what "covered" is measured against, whatever the user toggles. */
const savedSelection = ref<MatrixSelection>({})
/** False from open until the stored permissions are read into the chips and matrix. */
const ready = ref(false)
const entryText = ref('')

const rows = computed(() => rowsFor(catalog.value, scope.value ?? 'PROJECT'))
const covered = computed(() => (props.role ? coveredKeys(props.role.expandedKeys, savedSelection.value, rows.value) : []))

let initialisation = 0

/** Loads the form from the role (or blank) and the matrix from the catalog; a later open wins. */
async function initialise(): Promise<void> {
  const current = ++initialisation
  const role = props.role
  resetForm({
    values: { key: role?.key ?? '', name: role?.name ?? '', description: role?.description ?? '', scope: role?.scope ?? 'PROJECT' },
  })
  entryText.value = ''
  ready.value = false
  chips.value = []
  selection.value = {}
  savedSelection.value = {}
  let entries: CatalogEntry[] = []
  try {
    entries = await loadCatalog()
  } catch (err: unknown) {
    // Without the catalog every stored entry stays a chip, so a save cannot drop one.
    toast.error(extractApiError(err))
  }
  if (current !== initialisation) return
  catalog.value = entries
  const split = splitPermissions(role?.permissions ?? [], rows.value)
  chips.value = split.chips
  selection.value = split.selection
  savedSelection.value = split.selection
  ready.value = true
}

watch(() => ({ open: props.open, role: props.role }), (state) => {
  if (state.open) void initialise()
}, { immediate: true })

function onScopeChange(next: RoleScope): void {
  scope.value = next
  const visible = new Set(rowsFor(catalog.value, next).map((row) => row.key))
  selection.value = Object.fromEntries(Object.entries(selection.value).filter(([rowKey]) => visible.has(rowKey)))
}

function onChoose(rowKey: string, choice: RowChoice | 'none'): void {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { [rowKey]: _dropped, ...rest } = selection.value
  selection.value = choice === 'none' ? rest : { ...rest, [rowKey]: choice }
}

function addEntry(): void {
  const entry = entryText.value.trim()
  entryText.value = ''
  if (!entry || chips.value.includes(entry)) return
  // A plain matrix key typed here belongs to its row, not to a second, duplicate entry.
  const split = splitPermissions([entry], rows.value)
  chips.value = [...chips.value, ...split.chips]
  selection.value = { ...selection.value, ...split.selection }
}

function removeEntry(entry: string): void {
  chips.value = chips.value.filter((existing) => existing !== entry)
}

const onSubmit = handleSubmit(async (values) => {
  // Until the stored entries are loaded the chips and matrix are empty, and a save would replace them.
  if (readOnly.value || !ready.value) return
  const permissions = buildPermissions(chips.value, selection.value, rows.value)
  try {
    if (props.role) {
      // A system role's name is fixed: the API rejects a rename, so the body does not carry one.
      await update(props.role.id, {
        ...(props.role.system ? {} : { name: values.name }),
        description: values.description,
        permissions,
      })
    } else {
      await create({ key: values.key, name: values.name, description: values.description, scope: values.scope, permissions })
    }
    toast.success(t('admin.roles.toast.saved'))
    emit('saved')
    emit('update:open', false)
  } catch (err: unknown) {
    // The dialog stays open with what was entered; the API's refusal is the message.
    toast.error(extractApiError(err))
  }
})
</script>
