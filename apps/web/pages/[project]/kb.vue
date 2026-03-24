<script setup lang="ts">
import { toast } from 'vue-sonner'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import * as z from 'zod'

interface KbDocument {
  id: string
  sourceId: string
  source: 'manual' | 'doc' | 'ticket'
  content: string
  createdAt: string
}

interface SearchResult {
  score: number
  content: string
  source: 'manual' | 'doc' | 'ticket'
  sourceId?: string
  createdAt?: string
  verdict: 'likely_duplicate' | 'possibly_related' | 'no_match'
}

const route = useRoute()
const slug = route.params.project as string
const { $api } = useApi()
const { t } = useI18n()

// Search tab
const searchQuery = ref('')
const searchResults = ref<SearchResult[]>([])
const isSearching = ref(false)
const hasSearched = ref(false)

async function handleSearch() {
  if (!searchQuery.value.trim()) return
  isSearching.value = true
  hasSearched.value = true
  try {
    const result = await $api.post(`/projects/${slug}/kb/search`, { query: searchQuery.value }) as SearchResult[]
    searchResults.value = result
  } catch (err) {
    toast.error(t('kb.toast.searchFailed'))
  } finally {
    isSearching.value = false
  }
}

function verdictClass(verdict: string) {
  if (verdict === 'likely_duplicate') return 'bg-green-100 text-green-800'
  if (verdict === 'possibly_related') return 'bg-yellow-100 text-yellow-800'
  return 'bg-gray-100 text-gray-800'
}

function verdictLabel(verdict: string) {
  if (verdict === 'likely_duplicate') return '⚠ Likely Duplicate'
  if (verdict === 'possibly_related') return '~ Possibly Related'
  return 'No Match'
}

function scoreLabel(score: number) {
  if (score >= 0.85) return 'HIGH'
  if (score >= 0.65) return 'MED'
  return 'LOW'
}

function scoreClass(score: number) {
  if (score >= 0.85) return 'bg-red-100 text-red-800'
  if (score >= 0.65) return 'bg-yellow-100 text-yellow-800'
  return 'bg-gray-100 text-gray-800'
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString()
}

function truncate(str: string, len: number) {
  return str.length > len ? str.slice(0, len) + '...' : str
}

// Documents tab
const addDocSchema = toTypedSchema(z.object({
  sourceId: z.string().min(1, 'Source ID is required'),
  source: z.enum(['manual', 'doc', 'ticket']),
  content: z.string().min(1, 'Content is required'),
}) as any)

const { handleSubmit: handleAddDoc } = useForm({ validationSchema: addDocSchema })
const showAddDialog = ref(false)
const isAdding = ref(false)

const { data: docsData, refresh } = useAsyncData(
  `kb-docs-${slug}`,
  () => $api.get(`/projects/${slug}/kb/documents`) as Promise<KbDocument[]>,
)

const docs = computed(() => docsData.value ?? [])

const onAddDoc = handleAddDoc(async (values) => {
  isAdding.value = true
  try {
    await $api.post(`/projects/${slug}/kb/documents`, {
      sourceId: values.sourceId,
      source: values.source,
      content: values.content,
    })
    toast.success(t('kb.toast.docAdded'))
    showAddDialog.value = false
    refresh()
  } catch (err) {
    toast.error(t('kb.toast.addFailed'))
  } finally {
    isAdding.value = false
  }
})
</script>

<template>
  <Tabs default-value="search">
    <TabsList>
      <TabsTrigger value="search">{{ t('kb.tabs.search') }}</TabsTrigger>
      <TabsTrigger value="documents">{{ t('kb.tabs.documents') }}</TabsTrigger>
    </TabsList>

    <!-- Search Tab -->
    <TabsContent value="search" class="space-y-4">
      <div class="flex gap-2">
        <Input
          v-model="searchQuery"
          :placeholder="t('kb.search.placeholder')"
          @keyup.enter="handleSearch"
        />
        <Button @click="handleSearch" :disabled="isSearching">
          {{ isSearching ? t('common.loading') : t('kb.search.button') }}
        </Button>
      </div>

      <div v-if="hasSearched && searchResults.length === 0" class="py-8 text-center text-muted-foreground">
        {{ t('kb.search.noResults') }}
      </div>

      <div v-else-if="hasSearched" class="space-y-3">
        <div
          v-for="(result, idx) in searchResults"
          :key="idx"
          class="rounded-lg border p-4"
        >
          <div class="mb-2 flex items-center gap-2">
            <span :class="['rounded px-2 py-0.5 text-xs font-medium', verdictClass(result.verdict)]">
              {{ verdictLabel(result.verdict) }}
            </span>
            <Badge :class="scoreClass(result.score)" variant="outline" class="text-xs">
              {{ scoreLabel(result.score) }}
            </Badge>
            <Badge variant="outline" class="text-xs">
              {{ result.source }}
            </Badge>
          </div>
          <p class="text-sm text-muted-foreground">{{ truncate(result.content, 120) }}</p>
          <div class="mt-2 flex items-center gap-4 text-xs text-muted-foreground">
            <span v-if="result.sourceId">#{{ result.sourceId }}</span>
            <span v-if="result.createdAt">{{ formatDate(result.createdAt) }}</span>
          </div>
        </div>
      </div>
    </TabsContent>

    <!-- Documents Tab -->
    <TabsContent value="documents" class="space-y-4">
      <div class="flex justify-end">
        <Dialog v-model:open="showAddDialog">
          <DialogTrigger as-child>
            <Button>{{ t('kb.documents.addButton') }}</Button>
          </DialogTrigger>
          <DialogContent class="sm:max-w-[500px]">
            <DialogHeader>
              <DialogTitle>{{ t('kb.documents.addTitle') }}</DialogTitle>
            </DialogHeader>
            <form @submit="onAddDoc" class="space-y-4">
              <FormField name="sourceId" v-slot="{ componentField }">
                <FormItem>
                  <FormLabel>{{ t('kb.documents.fields.sourceId') }}</FormLabel>
                  <FormControl>
                    <Input v-bind="componentField" :placeholder="t('kb.documents.fields.sourceIdPlaceholder')" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              </FormField>

              <FormField name="source" v-slot="{ componentField }">
                <FormItem>
                  <FormLabel>{{ t('kb.documents.fields.source') }}</FormLabel>
                  <Select v-bind="componentField">
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue :placeholder="t('kb.documents.fields.sourcePlaceholder')" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="manual">{{ t('kb.documents.fields.sourceManual') }}</SelectItem>
                      <SelectItem value="doc">{{ t('kb.documents.fields.sourceDoc') }}</SelectItem>
                      <SelectItem value="ticket">{{ t('kb.documents.fields.sourceTicket') }}</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              </FormField>

              <FormField name="content" v-slot="{ componentField }">
                <FormItem>
                  <FormLabel>{{ t('kb.documents.fields.content') }}</FormLabel>
                  <FormControl>
                    <Textarea v-bind="componentField" :placeholder="t('kb.documents.fields.contentPlaceholder')" rows="4" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              </FormField>

              <DialogFooter>
                <Button type="button" variant="outline" @click="showAddDialog = false">
                  {{ t('common.cancel') }}
                </Button>
                <Button type="submit" :disabled="isAdding">
                  {{ isAdding ? t('common.loading') : t('kb.documents.addButton') }}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div v-if="docs.length === 0" class="py-8 text-center text-muted-foreground">
        {{ t('kb.documents.empty') }}
      </div>

      <Table v-else>
        <TableHeader>
          <TableRow>
            <TableHead>{{ t('kb.documents.columns.source') }}</TableHead>
            <TableHead>{{ t('kb.documents.columns.content') }}</TableHead>
            <TableHead>{{ t('kb.documents.columns.created') }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="doc in docs" :key="doc.id">
            <TableCell>
              <Badge variant="outline">{{ doc.source }}</Badge>
              <span v-if="doc.sourceId" class="ml-2 text-xs text-muted-foreground">#{{ doc.sourceId }}</span>
            </TableCell>
            <TableCell>{{ truncate(doc.content, 80) }}</TableCell>
            <TableCell class="text-muted-foreground">{{ formatDate(doc.createdAt) }}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </TabsContent>
  </Tabs>
</template>
