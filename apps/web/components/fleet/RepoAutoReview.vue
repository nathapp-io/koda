<template>
  <div class="flex items-center gap-2">
    <Switch :checked="repo.autoReview" :disabled="!allowed || saving" :aria-label="t('fleet.repos.autoReview.toggle')" @update:checked="toggle" />
    <span v-if="repo.autoReview" class="text-xs text-muted-foreground">{{ repo.autoReviewProfiles.join(', ') }}</span>
    <Button v-if="repo.autoReview && allowed" size="sm" variant="outline" @click="openDialog(true)">{{ t('fleet.repos.autoReview.edit') }}</Button>
    <p v-if="notice" class="text-xs text-muted-foreground">{{ notice }}</p>
    <p v-if="error" role="alert" class="text-xs text-muted-foreground">{{ error }}</p>
    <Dialog :open="dialogOpen" @update:open="dialogOpen = $event">
      <DialogContent>
        <DialogHeader><DialogTitle>{{ t('fleet.repos.autoReview.title') }}</DialogTitle></DialogHeader>
        <form class="space-y-4" @submit="save">
          <FormField v-slot="{ componentField }" name="profiles"><FormItem><FormLabel>{{ t('fleet.repos.autoReview.profiles') }}</FormLabel><FormControl><Input v-bind="componentField" /></FormControl><FormMessage /></FormItem></FormField>
          <FormField v-slot="{ componentField }" name="maxCost"><FormItem><FormLabel>{{ t('fleet.repos.autoReview.maxCost') }}</FormLabel><FormControl><Input v-bind="componentField" inputmode="decimal" /></FormControl><FormMessage /></FormItem></FormField>
          <div class="flex justify-end gap-2"><Button type="button" variant="outline" @click="dialogOpen = false">{{ t('common.cancel') }}</Button><Button type="submit" :disabled="saving">{{ t('fleet.repos.autoReview.save') }}</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  </div>
</template>
<script setup lang="ts">
import { ref } from 'vue'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import * as z from 'zod'
import { extractApiError } from '~/composables/useApi'
import { useFleetRepos } from '~/composables/useFleetRepos'
import type { FleetRepo } from '~/lib/fleet-types'
const props = defineProps<{ repo: FleetRepo }>()
const emit = defineEmits<{ (e: 'saved', repo: FleetRepo): void }>()
const { t } = useI18n()
const { permissions } = useGlobalPermissions()
const allowed = computed(() => permissions.value.has('fleet.repo.review.configure'))
const { setAutoReview } = useFleetRepos()
const dialogOpen = ref(false), saving = ref(false), notice = ref(''), error = ref('')
const schema = toTypedSchema(z.object({
  profiles: z.string().refine((v) => v.split(',').map((p) => p.trim()).filter(Boolean).length <= 8 && v.split(',').every((p) => p.trim().length <= 64), { message: t('fleet.repos.autoReview.profilesInvalid') }),
  maxCost: z.string().refine((v) => { const n = Number(v); return /^\d+(\.\d{1,4})?$/.test(v) && n >= 0.0001 && n <= 10000 }, { message: t('fleet.repos.autoReview.maxCostInvalid') }),
}))
const { handleSubmit, resetForm } = useForm({ validationSchema: schema, initialValues: { profiles: '', maxCost: '1' } })
function openDialog(edit: boolean) { notice.value = ''; error.value = ''; resetForm({ values: { profiles: edit ? props.repo.autoReviewProfiles.join(', ') : '', maxCost: edit ? String(Number(props.repo.autoReviewMaxCostUsd)) : '1' } }); dialogOpen.value = true }
async function toggle(value: boolean) {
 if (value) { openDialog(false); return }
 saving.value = true; notice.value = ''
 try { const result = await setAutoReview(props.repo.id, { enabled: false }); if (result.kind === 'pending') notice.value = t('fleet.repos.autoReview.pending'); else emit('saved', result.repo) }
 catch (err: unknown) { error.value = extractApiError(err) } finally { saving.value = false }
}
const save = handleSubmit(async (values) => {
 saving.value = true; error.value = ''; notice.value = ''
 try { const result = await setAutoReview(props.repo.id, { enabled: true, profiles: values.profiles.split(',').map((p) => p.trim()).filter(Boolean), maxCostUsd: Number(values.maxCost) }); if (result.kind === 'pending') notice.value = t('fleet.repos.autoReview.pending'); else { emit('saved', result.repo); dialogOpen.value = false } }
 catch (err: unknown) { error.value = extractApiError(err) } finally { saving.value = false }
})
</script>
