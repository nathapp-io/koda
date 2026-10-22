<template>
  <div class="space-y-4" data-testid="permission-matrix">
    <section
      v-for="group in groups"
      :key="group.group"
      class="rounded-md border border-border"
      data-testid="matrix-group"
      :data-group="group.group"
    >
      <h4 class="border-b border-border bg-muted/40 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {{ group.group }}
      </h4>
      <ul class="divide-y divide-border">
        <li
          v-for="row in group.rows"
          :key="row.key"
          class="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
          data-testid="matrix-row"
          :data-key="row.key"
        >
          <span class="flex min-w-0 items-center gap-2">
            <code class="truncate">{{ row.key }}</code>
            <Badge :variant="riskVariant[row.risk]" data-testid="risk-badge" :data-risk="row.risk">
              {{ t(`admin.roles.risk.${row.risk}`) }}
            </Badge>
            <span v-if="isCovered(row.key)" class="text-xs text-muted-foreground">{{ t('admin.roles.matrix.covered') }}</span>
          </span>

          <span v-if="row.ownable" class="flex items-center gap-3" role="radiogroup" :aria-label="row.key">
            <label v-for="choice in CHOICES" :key="choice" class="flex items-center gap-1">
              <input
                type="radio"
                :name="`choice-${row.key}`"
                :data-testid="`perm-${row.key}-${choice}`"
                :checked="choiceOf(row.key) === choice"
                :disabled="disabled || isCovered(row.key)"
                @change="choose(row.key, choice)"
              />
              {{ t(`admin.roles.matrix.${choice}`) }}
            </label>
          </span>
          <input
            v-else
            type="checkbox"
            :data-testid="`perm-${row.key}`"
            :aria-label="row.key"
            :checked="isCovered(row.key) || selection[row.key] !== undefined"
            :disabled="disabled || isCovered(row.key)"
            @change="toggle(row.key, ($event.target as HTMLInputElement).checked)"
          />
        </li>
      </ul>
    </section>
  </div>
</template>

<script setup lang="ts">
import { groupRows } from '~/lib/role-editor'
import type { MatrixSelection, RowChoice } from '~/lib/role-editor'
import type { CatalogEntry } from '~/composables/useRoles'

type Choice = RowChoice | 'none'

const props = defineProps<{
  /** The catalog entries that fit the role's scope. */
  rows: CatalogEntry[]
  /** The rows with a choice made. */
  selection: MatrixSelection
  /** Rows a wildcard already grants: shown checked and not editable. */
  covered?: string[]
  disabled?: boolean
}>()

// One row's change, not the whole selection: two changes in a row must both land, and only the
// owner of the selection knows its latest value.
const emit = defineEmits<{ choose: [key: string, choice: Choice] }>()

const { t } = useI18n()

const CHOICES: Choice[] = ['none', 'own', 'any']
const riskVariant = { low: 'outline', medium: 'secondary', high: 'default', critical: 'destructive' } as const

const groups = computed(() => groupRows(props.rows))

function isCovered(key: string): boolean {
  return (props.covered ?? []).includes(key)
}

/** A covered ownable row reads as "any": the wildcard grants it for every row. */
function choiceOf(key: string): Choice {
  if (isCovered(key)) return 'any'
  return props.selection[key] ?? 'none'
}

function choose(key: string, choice: Choice): void {
  emit('choose', key, choice)
}

function toggle(key: string, checked: boolean): void {
  choose(key, checked ? 'any' : 'none')
}
</script>
