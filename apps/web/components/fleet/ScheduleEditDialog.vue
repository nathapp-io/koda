<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent class="max-h-[90vh] overflow-y-auto sm:max-w-[560px]">
      <DialogHeader>
        <DialogTitle>{{ schedule ? t('fleet.schedules.form.editTitle') : t('fleet.schedules.form.createTitle') }}</DialogTitle>
      </DialogHeader>

      <form class="space-y-4" data-testid="fleet-schedule-form" @submit="onSubmit">
        <FormField v-slot="{ componentField }" name="name">
          <FormItem>
            <FormLabel>{{ t('fleet.schedules.form.name') }}</FormLabel>
            <FormControl><Input v-bind="componentField" data-testid="fleet-schedule-name" /></FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <template v-if="!schedule">
          <FormField v-slot="{ componentField }" name="repoId">
            <FormItem>
              <FormLabel>{{ t('fleet.schedules.form.repo') }}</FormLabel>
              <FormControl>
                <FleetNativeSelect v-bind="componentField" :options="repoOptions" :placeholder="t('fleet.schedules.form.repoPlaceholder')" testid="fleet-schedule-repo" />
              </FormControl>
              <FormMessage />
            </FormItem>
          </FormField>
          <FormField v-slot="{ componentField }" name="feature">
            <FormItem>
              <FormLabel>{{ t('fleet.schedules.form.feature') }}</FormLabel>
              <FormControl><Input v-bind="componentField" data-testid="fleet-schedule-feature" /></FormControl>
              <FormMessage />
            </FormItem>
          </FormField>
        </template>
        <p v-else class="text-sm text-muted-foreground" data-testid="fleet-schedule-fixed-hint">{{ t('fleet.schedules.form.fixedHint') }}</p>

        <div class="grid gap-4 sm:grid-cols-2">
          <FormField v-slot="{ componentField }" name="cron">
            <FormItem>
              <FormLabel>{{ t('fleet.schedules.form.cron') }}</FormLabel>
              <FormControl><Input v-bind="componentField" class="font-mono" data-testid="fleet-schedule-cron" /></FormControl>
              <FormMessage />
            </FormItem>
          </FormField>
          <FormField v-slot="{ componentField }" name="timezone">
            <FormItem>
              <FormLabel>{{ t('fleet.schedules.form.timezone') }}</FormLabel>
              <FormControl><Input v-bind="componentField" list="fleet-schedule-timezones" data-testid="fleet-schedule-timezone" /></FormControl>
              <FormMessage />
            </FormItem>
          </FormField>
        </div>
        <datalist id="fleet-schedule-timezones">
          <option v-for="zone in zones" :key="zone" :value="zone" />
        </datalist>
        <p class="text-xs text-muted-foreground">{{ t('fleet.schedules.form.cronHint') }} {{ t('fleet.schedules.form.timezoneHint') }}</p>

        <FormField v-slot="{ componentField }" name="ref">
          <FormItem>
            <FormLabel>{{ t('fleet.schedules.form.ref') }}</FormLabel>
            <FormControl><Input v-bind="componentField" data-testid="fleet-schedule-ref" /></FormControl>
            <p class="text-xs text-muted-foreground">{{ schedule ? t('fleet.schedules.form.refHintEdit') : t('fleet.schedules.form.refHintCreate') }}</p>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField name="profiles">
          <FormItem>
            <FormLabel>{{ t('fleet.schedules.form.profiles') }}</FormLabel>
            <FleetTokenListInput
              :model-value="formValues.profiles ?? []"
              :suggestions="profileSuggestions"
              :placeholder="t('fleet.schedules.form.profilePlaceholder')"
              test-id="fleet-schedule-profiles"
              @update:model-value="setFieldValue('profiles', $event)"
            />
            <FormMessage />
          </FormItem>
        </FormField>

        <div class="grid gap-4 sm:grid-cols-2">
          <FormField v-slot="{ componentField }" name="maxCostUsd">
            <FormItem>
              <FormLabel>{{ t('fleet.schedules.form.maxCost') }}</FormLabel>
              <FormControl><Input v-bind="componentField" inputmode="decimal" data-testid="fleet-schedule-max-cost" /></FormControl>
              <FormMessage />
            </FormItem>
          </FormField>
          <FormField v-slot="{ componentField }" name="noProgressLimit">
            <FormItem>
              <FormLabel>{{ t('fleet.schedules.form.noProgressLimit') }}</FormLabel>
              <FormControl><Input v-bind="componentField" inputmode="numeric" data-testid="fleet-schedule-no-progress-limit" /></FormControl>
              <FormMessage />
            </FormItem>
          </FormField>
        </div>
        <p class="text-xs text-muted-foreground">{{ t('fleet.schedules.form.noProgressHint') }}</p>

        <FormField v-slot="{ componentField }" name="placement">
          <FormItem>
            <FormLabel>{{ t('fleet.schedules.form.placement') }}</FormLabel>
            <FormControl>
              <FleetNativeSelect v-bind="componentField" :options="placementOptions" testid="fleet-schedule-placement" />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField v-if="formValues.placement === 'labels'" name="selectorLabels">
          <FormItem>
            <FleetTokenListInput
              :model-value="formValues.selectorLabels ?? []"
              :suggestions="labelSuggestions"
              :placeholder="t('fleet.schedules.form.labelPlaceholder')"
              test-id="fleet-schedule-labels"
              @update:model-value="setFieldValue('selectorLabels', $event)"
            />
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField v-if="formValues.placement === 'pin'" v-slot="{ componentField }" name="pinnedRunnerId">
          <FormItem>
            <FormControl>
              <FleetNativeSelect v-bind="componentField" :options="runnerOptions" :placeholder="t('fleet.schedules.form.pinPlaceholder')" testid="fleet-schedule-pin" />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" @click="$emit('update:open', false)">{{ t('common.cancel') }}</Button>
          <Button type="submit" :disabled="isSubmitting" data-testid="fleet-schedule-submit">
            {{ isSubmitting ? t('fleet.schedules.form.submitting') : t('fleet.schedules.form.submit') }}
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import { extractApiError } from '~/composables/useApi'
import { useFleetSchedules } from '~/composables/useFleetSchedules'
import {
  browserTimeZone, buildScheduleSchema, initialScheduleValues, PLACEMENT_MODES, timeZoneOptions, toCreateScheduleBody,
  toSchedulePatchBody,
} from '~/lib/fleet-schedules'
import type { ScheduleDto } from '~/lib/fleet-types'
import FleetTokenListInput from '~/components/fleet/FleetTokenListInput.vue'

const props = withDefaults(defineProps<{
  open: boolean
  slug: string
  /** null creates; a schedule edits it (repo and feature stay fixed, 3a D203). Pages key the dialog by it. */
  schedule: ScheduleDto | null
  repoOptions?: Array<{ value: string; label: string }>
  runnerOptions?: Array<{ value: string; label: string }>
  profileSuggestions?: string[]
  labelSuggestions?: string[]
}>(), { repoOptions: () => [], runnerOptions: () => [], profileSuggestions: () => [], labelSuggestions: () => [] })

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'saved', schedule: ScheduleDto): void
  (e: 'failed'): void
}>()

const { t } = useI18n()
const toast = useAppToast()
const { create, update } = useFleetSchedules(props.slug)

const zones = timeZoneOptions()
const placementOptions = computed(() => PLACEMENT_MODES.map((mode) => ({ value: mode, label: t(`fleet.schedules.form.placementMode.${mode}`) })))
const initialValues = () => initialScheduleValues(props.schedule, browserTimeZone())

// D218: values under v-if stay put when their input unmounts; the body mappers read only the chosen placement.
const { handleSubmit, isSubmitting, resetForm, values: formValues, setFieldValue } = useForm({
  validationSchema: toTypedSchema(buildScheduleSchema(t, props.schedule ? 'edit' : 'create')),
  initialValues: initialValues(),
  keepValuesOnUnmount: true,
})

// Reopening shows the stored values again, not the last unsaved edit.
watch(() => props.open, (open) => {
  if (open) resetForm({ values: initialValues() })
})

const onSubmit = handleSubmit(async (values) => {
  try {
    const saved = props.schedule
      ? await update(props.schedule.id, toSchedulePatchBody(values))
      : await create(toCreateScheduleBody(values))
    toast.success(t(props.schedule ? 'fleet.schedules.toast.updated' : 'fleet.schedules.toast.created'))
    emit('saved', saved)
    emit('update:open', false)
  }
  catch (err: unknown) {
    // Stay open so the input is kept (D185 pattern); the page reloads in case its view is stale.
    toast.error(extractApiError(err))
    emit('failed')
  }
})
</script>
