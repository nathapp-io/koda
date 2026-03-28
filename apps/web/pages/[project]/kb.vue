<script setup lang="ts">
import { toast } from 'vue-sonner'

definePageMeta({ layout: 'default' })

const route = useRoute()
const slug = route.params.project as string
const { $api } = useApi()
const { t } = useI18n()

// ─── Search ──────────────────────────────────────────────────────────────────

interface KbSearchResult {
  verdict: 'likely_duplicate' | 'possibly_related' | 'no_match' | null
  bestMatch: string | null
  results: Array<{
    id: string
    source: string
    sourceId: string
    content: string
    score: number
    similarity: 'high' | 'medium' | 'low'
    createdAt: string
  }>
}

const searchQuery = ref('')
const isSearching = ref(false)
const searchResult = ref<KbSearchResult | null>(null)

async function handleSearch() {
  if (!searchQuery.value.trim()) return
  isSearching.value = true
  searchResult.value = null
  try {
    searchResult.value = await $api.post<KbSearchResult>(
      `/projects/${slug}/kb/search`,
      { query: searchQuery.value },
    )
  }
  catch {
    toast.error(t('kb.toast.searchFailed'))
  }
  finally {
    isSearching.value = false
  }
}

// ─── Documents ───────────────────────────────────────────────────────────────

interface KbDocument {
  id: string
  source: string
  sourceId: string
  content: string
  createdAt: string
}

const { data: docsData, pending, error, refresh } = useAsyncData(
  `kb-docs-${slug}`,
  () => $api.get<{ items: KbDocument[] }>(`/projects/${slug}/kb/documents`),
)

const docs = computed(() => docsData.value?.items ?? [])

function truncate(str: string, len: number) {
  return str.length > len ? `${str.slice(0, len)}...` : str
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString()
}

function onDocumentAdded() {
  refresh()
}
</script>

<template>
  <div class="space-y-6">
    <!-- Page header -->
    <div>
      <h1 class="text-2xl font-bold">{{ t('nav.kb') }}</h1>
      <p class="text-sm text-muted-foreground">Search and manage documents for the {{ slug }} project.</p>
    </div>

    <Tabs default-value="search">
      <TabsList>
        <TabsTrigger value="search">{{ t('kb.tabs.search') }}</TabsTrigger>
        <TabsTrigger value="documents">{{ t('kb.tabs.documents') }}</TabsTrigger>
      </TabsList>

      <!-- ── Search Tab ──────────────────────────────────────────────────── -->
      <TabsContent value="search" class="space-y-4">
        <div class="flex gap-2">
          <Input
            v-model="searchQuery"
            :placeholder="t('kb.search.placeholder')"
            @keyup.enter="handleSearch"
          />
          <Button :disabled="isSearching || !searchQuery.trim()" @click="handleSearch">
            {{ isSearching ? t('common.loading') : t('kb.search.button') }}
          </Button>
        </div>

        <!-- Verdict banner -->
        <KbVerdictBanner
          v-if="searchResult"
          :verdict="searchResult.verdict"
          :best-match="searchResult.bestMatch"
        />

        <!-- Result cards -->
        <div v-if="searchResult && searchResult.results.length > 0" class="space-y-3">
          <KbResultCard
            v-for="r in searchResult.results"
            :key="r.id"
            :id="r.id"
            :source="r.source"
            :source-id="r.sourceId"
            :content="r.content"
            :score="r.score"
            :similarity="r.similarity"
            :created-at="r.createdAt"
          />
        </div>

        <!-- No results -->
        <div
          v-else-if="searchResult && searchResult.results.length === 0"
          class="py-12 text-center text-sm text-muted-foreground"
        >
          {{ t('kb.search.noResults') }}
        </div>

        <!-- Pre-search prompt -->
        <div
          v-else-if="!searchResult && !isSearching"
          class="py-12 text-center text-sm text-muted-foreground"
        >
          {{ t('kb.search.placeholder') }}
        </div>
      </TabsContent>

      <!-- ── Documents Tab ───────────────────────────────────────────────── -->
      <TabsContent value="documents" class="space-y-4">
        <div v-if="pending" class="text-center py-12 text-muted-foreground">{{ t('common.loading') }}</div>
        <div v-else-if="error" class="text-center py-12">
          <p class="text-destructive text-sm">{{ t('common.loadFailed') }}</p>
          <Button @click="refresh()">{{ t('common.retry') }}</Button>
        </div>
        <template v-else>
        <div class="flex items-center justify-between">
          <p class="text-sm text-muted-foreground">{{ docs.length }} document(s) indexed</p>
          <KbAddDocumentDialog :project-slug="slug" @added="onDocumentAdded" />
        </div>

        <!-- Empty state -->
        <div
          v-if="docs.length === 0"
          class="rounded-lg border border-dashed border-border py-16 text-center"
        >
          <p class="text-sm font-medium text-muted-foreground">{{ t('kb.documents.empty') }}</p>
        </div>

        <!-- Documents table -->
        <div v-else class="overflow-hidden rounded-lg border border-border">
          <table class="w-full text-sm">
            <thead class="bg-muted/50">
              <tr>
                <th class="px-4 py-3 text-left font-medium text-muted-foreground">{{ t('kb.documents.columns.source') }}</th>
                <th class="px-4 py-3 text-left font-medium text-muted-foreground">{{ t('kb.documents.columns.content') }}</th>
                <th class="px-4 py-3 text-left font-medium text-muted-foreground">{{ t('kb.documents.columns.created') }}</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border">
              <tr v-for="doc in docs" :key="doc.id" class="hover:bg-muted/30">
                <td class="px-4 py-3">
                  <span class="rounded border border-border px-1.5 py-0.5 text-xs">{{ doc.source }}</span>
                  <span v-if="doc.sourceId" class="ml-2 font-mono text-xs text-muted-foreground">{{ doc.sourceId }}</span>
                </td>
                <td class="max-w-xs truncate px-4 py-3 text-muted-foreground">{{ truncate(doc.content, 80) }}</td>
                <td class="whitespace-nowrap px-4 py-3 text-muted-foreground">{{ formatDate(doc.createdAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        </template>
      </TabsContent>
    </Tabs>
  </div>
</template>
