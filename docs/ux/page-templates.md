# Page Templates — Koda Web UI

> Standard page layouts that all pages must follow.
> When building a new page, pick the matching template and follow its structure.

---

## Template 1: List Page

**Used by:** Dashboard (`/`), Agents, Labels

### Structure
```
┌──────────────────────────────────────────┐
│ [← Back]  Breadcrumb > Path              │
├──────────────────────────────────────────┤
│ Page Title                    [+ Create] │
│ Optional subtitle                        │
├──────────────────────────────────────────┤
│ Loading / Error / Empty / Content        │
│                                          │
│  ┌─────┬─────┬─────┐  (grid or table)   │
│  │     │     │     │                     │
│  └─────┴─────┴─────┘                     │
└──────────────────────────────────────────┘
```

### Code Pattern
```vue
<script setup lang="ts">
definePageMeta({ layout: 'default' })

const route = useRoute()
const { t } = useI18n()
const { $api } = useApi()

const slug = route.params.project as string

const { data, pending, error, refresh } = useAsyncData(
  'unique-key',
  () => $api.get(`/projects/${slug}/items`) as Promise<Item[]>,
)

const items = computed(() => data.value ?? [])
const showCreateDialog = ref(false)
</script>

<template>
  <div class="space-y-8">
    <!-- Header row -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-3xl font-bold tracking-tight">{{ t('items.title') }}</h1>
        <p class="mt-2 text-muted-foreground">{{ t('items.subtitle') }}</p>
      </div>
      <Button @click="showCreateDialog = true">
        <Plus class="mr-2 h-4 w-4" />
        {{ t('items.create') }}
      </Button>
    </div>

    <!-- States -->
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" @retry="refresh()" />
    <EmptyState v-else-if="items.length === 0" :message="t('items.empty')" />

    <!-- Content -->
    <Table v-else>...</Table>

    <!-- Create dialog -->
    <CreateItemDialog v-model:open="showCreateDialog" @created="refresh()" />
  </div>
</template>
```

---

## Template 2: Kanban Board Page

**Used by:** Project Board (`/:project`)

### Structure
```
┌──────────────────────────────────────────┐
│ [← Back]  Koda > ProjectName            │
├──────────────────────────────────────────┤
│ Project Name                 [+ Ticket]  │
├──────────────────────────────────────────┤
│ ┌────────┐ ┌────────┐ ┌────────┐        │
│ │CREATED │ │VERIFIED│ │IN_PROG │ ...    │
│ │        │ │        │ │        │        │
│ │ Card   │ │ Card   │ │ Card   │        │
│ │ Card   │ │        │ │ Card   │        │
│ └────────┘ └────────┘ └────────┘        │
└──────────────────────────────────────────┘
```

### Key Rules
- Columns represent ticket statuses in workflow order.
- Each column shows a count badge: `CREATED (3)`.
- Cards are clickable → navigate to `/:project/tickets/:ref`.
- Horizontal scroll on mobile for columns.

---

## Template 3: Detail Page

**Used by:** Ticket Detail (`/:project/tickets/:ref`)

### Structure
```
┌──────────────────────────────────────────┐
│ [← Back]  Koda > Project > Tickets > REF│
├──────────────────────────────────────────┤
│ ┌──────────────────────┐ ┌────────────┐ │
│ │ Main content         │ │ Side panel │ │
│ │                      │ │            │ │
│ │ Title                │ │ Status     │ │
│ │ Description          │ │ Priority   │ │
│ │                      │ │ Assignee   │ │
│ │ ─────────────────    │ │ Type       │ │
│ │ Comments             │ │ Git Ref    │ │
│ │                      │ │            │ │
│ │ [Add comment]        │ │ [Actions]  │ │
│ └──────────────────────┘ └────────────┘ │
└──────────────────────────────────────────┘
```

### Key Rules
- Two-column layout: main (2/3) + sidebar (1/3).
- On mobile: sidebar stacks below main content.
- Back button goes to `/:project` (the board).
- Action buttons (change status, assign) live in the sidebar panel.

---

## Template 4: Search + Results Page

**Used by:** Knowledge Base (`/:project/kb`)

### Structure
```
┌──────────────────────────────────────────┐
│ [← Back]  Koda > Project > Knowledge Base│
├──────────────────────────────────────────┤
│ Knowledge Base                           │
│ Description text                         │
├──────────────────────────────────────────┤
│ [Tab: Search] [Tab: Documents]           │
├──────────────────────────────────────────┤
│ ┌─────────────────────────────┐          │
│ │ 🔍 Search query...     [Go]│          │
│ └─────────────────────────────┘          │
│                                          │
│ Result Card 1                            │
│ Result Card 2                            │
│ Result Card 3                            │
└──────────────────────────────────────────┘
```

---

## Shared Components to Extract

These patterns repeat across templates. Extract as reusable components:

| Component | Purpose | Props |
|:----------|:--------|:------|
| `Breadcrumb` | Renders breadcrumb trail | `items: { label, to? }[]` |
| `BackButton` | `←` icon + navigation | `to: string` |
| `PageHeader` | Title + subtitle + action slot | `title, subtitle` + `#actions` slot |
| `LoadingState` | Spinner + "Loading..." | — |
| `ErrorState` | Error icon + message + retry | `@retry` event |
| `EmptyState` | Icon + message + optional CTA | `message, icon?, #action` slot |

### Breadcrumb Component
```vue
<!-- components/AppBreadcrumb.vue -->
<script setup lang="ts">
interface BreadcrumbItem {
  label: string
  to?: string
}
defineProps<{ items: BreadcrumbItem[] }>()
</script>

<template>
  <nav class="flex items-center gap-1.5 text-sm text-muted-foreground">
    <template v-for="(item, i) in items" :key="i">
      <span v-if="i > 0" class="text-muted-foreground/50">/</span>
      <NuxtLink v-if="item.to" :to="item.to" class="hover:text-foreground transition-colors">
        {{ item.label }}
      </NuxtLink>
      <span v-else class="text-foreground font-medium">{{ item.label }}</span>
    </template>
  </nav>
</template>
```

---

## Page Checklist

Before submitting a new page, verify:

- [ ] Uses correct template from this doc
- [ ] Has `definePageMeta({ layout: 'default' })` (or `auth`)
- [ ] Implements loading, error, and empty states
- [ ] Has breadcrumbs matching navigation-map.md
- [ ] Has back button
- [ ] All user-facing strings use `t()` (i18n)
- [ ] Forms use `vee-validate` + `zod` + `toTypedSchema()`
- [ ] Error catches use `extractApiError()`
- [ ] Added to navigation-map.md if new page
- [ ] Added to sidebar in `layouts/default.vue` if navigable

---

*Created: 2026-03-29. Update when new templates are needed.*
