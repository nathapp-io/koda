<script setup lang="ts">
import { Code2 } from 'lucide-vue-next'
import { extractApiError } from '~/composables/useApi'

definePageMeta({ layout: 'default' })

const route = useRoute()
const slug = route.params.project as string
const { $api } = useApi()
const { t } = useI18n()
const toast = useAppToast()

interface CodeIntelSymbol {
  id: string
  name: string
  kind: string
  file: string
  signature?: string
  docComment?: string
  callers?: string[]
  callees?: string[]
}

const searchQuery = ref('')
const isSearching = ref(false)
const symbols = ref<CodeIntelSymbol[]>([])
const expandedSymbolId = ref<string | null>(null)

async function handleSearch() {
  if (!searchQuery.value.trim()) return
  isSearching.value = true
  symbols.value = []
  expandedSymbolId.value = null
  try {
    const res = await $api.get<{ items: CodeIntelSymbol[]; total: number }>(
      '/code-intel/symbols',
      { query: { projectSlug: slug, q: searchQuery.value } },
    )
    symbols.value = res.items ?? []
  }
  catch (err) {
    symbols.value = []
    toast.error(extractApiError(err))
  }
  finally {
    isSearching.value = false
  }
}

function toggleSymbol(id: string) {
  expandedSymbolId.value = expandedSymbolId.value === id ? null : id
}

const expandedSymbol = computed(() => {
  if (!expandedSymbolId.value) return null
  return symbols.value.find(s => s.id === expandedSymbolId.value) ?? null
})
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('nav.codeIntel')">
      <template #icon>
        <Code2 class="h-5 w-5" />
      </template>
    </PageHeader>

    <div class="flex gap-2">
      <Input
        v-model="searchQuery"
        :placeholder="t('codeIntel.search.placeholder')"
        class="flex-1"
        @keyup.enter="handleSearch"
      />
      <Button :disabled="isSearching || !searchQuery.trim()" @click="handleSearch">
        {{ isSearching ? t('common.loading') : t('codeIntel.search.button') }}
      </Button>
    </div>

    <LoadingState v-if="isSearching" />

    <div
      v-else-if="symbols.length === 0"
      class="rounded-lg border border-dashed border-border py-16 text-center"
    >
      <p class="text-sm font-medium text-muted-foreground">{{ t('codeIntel.empty') }}</p>
    </div>

    <div v-else class="space-y-3">
      <div class="overflow-hidden rounded-lg border border-border">
        <table class="w-full text-sm">
          <thead class="bg-muted/50">
            <tr>
              <th class="px-4 py-3 text-left font-medium text-muted-foreground">{{ t('codeIntel.columns.name') }}</th>
              <th class="px-4 py-3 text-left font-medium text-muted-foreground">{{ t('codeIntel.columns.kind') }}</th>
              <th class="px-4 py-3 text-left font-medium text-muted-foreground">{{ t('codeIntel.columns.file') }}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            <tr
              v-for="symbol in symbols"
              :key="symbol.id"
              class="cursor-pointer hover:bg-muted/30"
              @click="toggleSymbol(symbol.id)"
            >
              <td class="px-4 py-3 font-mono text-xs">{{ symbol.name }}</td>
              <td class="px-4 py-3"><span class="rounded border border-border px-1.5 py-0.5 text-xs">{{ symbol.kind }}</span></td>
              <td class="px-4 py-3 font-mono text-xs text-muted-foreground">{{ symbol.file }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div
        v-if="expandedSymbol"
        class="overflow-hidden rounded-lg border border-border bg-muted/20 p-4"
      >
        <dl class="space-y-3 text-sm">
          <div>
            <dt class="text-xs font-medium text-muted-foreground">{{ t('codeIntel.detail.signature') }}</dt>
            <dd class="mt-1 font-mono text-xs">{{ expandedSymbol.signature }}</dd>
          </div>
          <div>
            <dt class="text-xs font-medium text-muted-foreground">{{ t('codeIntel.detail.docComment') }}</dt>
            <dd class="mt-1 whitespace-pre-wrap text-muted-foreground">{{ expandedSymbol.docComment }}</dd>
          </div>
          <div>
            <dt class="text-xs font-medium text-muted-foreground">{{ t('codeIntel.detail.callers') }}</dt>
            <dd class="mt-1">
              <ul class="space-y-0.5 font-mono text-xs text-muted-foreground">
                <li v-for="caller in expandedSymbol.callers" :key="caller">{{ caller }}</li>
              </ul>
            </dd>
          </div>
          <div>
            <dt class="text-xs font-medium text-muted-foreground">{{ t('codeIntel.detail.callees') }}</dt>
            <dd class="mt-1">
              <ul class="space-y-0.5 font-mono text-xs text-muted-foreground">
                <li v-for="callee in expandedSymbol.callees" :key="callee">{{ callee }}</li>
              </ul>
            </dd>
          </div>
        </dl>
      </div>
    </div>
  </div>
</template>
