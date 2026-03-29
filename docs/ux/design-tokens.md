# Design Tokens — Koda Web UI

> Visual design decisions for consistency across all pages.
> Agents and developers must follow these rules when building UI.

---

## Toast Notifications

| Property | Value | Rationale |
|:---------|:------|:----------|
| **Position** | `top-right` | Near the user's focal area (header actions). Bottom-left is easy to miss. |
| **Library** | `vue-sonner` | Already installed. Use `rich-colors` mode. |
| **Duration** | 4000ms (default) | Standard. Errors persist until dismissed. |
| **Max visible** | 3 | Prevent toast stacking. |

### Implementation
```vue
<!-- app.vue -->
<Toaster position="top-right" :visible-toasts="3" rich-colors />
```

### Toast Usage Rules
- **Success**: `toast.success(t('...'))` — after create/update/delete actions.
- **Error**: `toast.error(extractApiError(error))` — always use `extractApiError`, never raw `error.message`.
- **Info**: `toast.info(...)` — for non-critical notifications.
- **Never** use inline error banners for API errors (use toasts). Inline validation errors (form fields) are fine.

---

## Typography

Based on Tailwind defaults + shadcn conventions.

| Element | Class | Usage |
|:--------|:------|:------|
| Page title | `text-3xl font-bold tracking-tight` | One per page, top of content area |
| Page subtitle | `text-muted-foreground mt-2` | Optional description below title |
| Section heading | `text-xl font-semibold` | Card titles, section dividers |
| Body text | `text-sm` | Default for all content |
| Small/meta | `text-xs text-muted-foreground` | Timestamps, IDs, helper text |
| Code/ref | `font-mono text-sm` | Ticket refs (NAX-1), API keys |

---

## Spacing

| Context | Value | Class |
|:--------|:------|:------|
| Page padding | 24px | `px-6 py-4` (already in default layout) |
| Section gap | 32px | `space-y-8` |
| Card gap (grid) | 16px | `gap-4` |
| Form field gap | 16px | `space-y-4` |
| Inline element gap | 8-16px | `gap-2` to `gap-4` |

---

## Colors & Status

Use shadcn semantic colors. Never hardcode hex values outside of user-defined label colors.

### Ticket Status Colors
| Status | Badge style | Rationale |
|:-------|:-----------|:----------|
| CREATED | `bg-gray-100 text-gray-800` / dark: `bg-gray-800 text-gray-200` | Neutral — new, unprocessed |
| VERIFIED | `bg-blue-100 text-blue-800` / dark: `bg-blue-900 text-blue-200` | Confirmed, ready for work |
| IN_PROGRESS | `bg-yellow-100 text-yellow-800` / dark: `bg-yellow-900 text-yellow-200` | Active work |
| VERIFY_FIX | `bg-purple-100 text-purple-800` / dark: `bg-purple-900 text-purple-200` | Awaiting review |
| CLOSED | `bg-green-100 text-green-800` / dark: `bg-green-900 text-green-200` | Done |
| REJECTED | `bg-red-100 text-red-800` / dark: `bg-red-900 text-red-200` | Won't fix / invalid |

### Priority Badge Variants
| Priority | shadcn variant |
|:---------|:--------------|
| CRITICAL | `destructive` |
| HIGH | `default` |
| MEDIUM | `secondary` |
| LOW | `outline` |

---

## Loading, Error & Empty States

**Every page with async data must implement all three states.**

### Loading
```html
<div v-if="pending" class="flex items-center justify-center py-12 text-muted-foreground">
  <!-- Use a spinner icon from lucide-vue-next -->
  <Loader2 class="mr-2 h-4 w-4 animate-spin" />
  {{ t('common.loading') }}
</div>
```

### Error
```html
<div v-else-if="error" class="text-center py-12">
  <AlertCircle class="mx-auto h-8 w-8 text-destructive" />
  <p class="mt-2 text-sm text-destructive">{{ t('common.loadFailed') }}</p>
  <Button variant="outline" class="mt-4" @click="refresh()">
    {{ t('common.retry') }}
  </Button>
</div>
```

### Empty
```html
<div v-else-if="items.length === 0" class="col-span-full flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12">
  <Inbox class="h-10 w-10 text-muted-foreground" />
  <h3 class="mt-4 text-lg font-medium">{{ t('...noItems') }}</h3>
  <p class="mt-1 text-sm text-muted-foreground">{{ t('...noItemsHint') }}</p>
  <Button class="mt-4" @click="...">{{ t('...createFirst') }}</Button>
</div>
```

---

## Icons

- **Library**: `lucide-vue-next` (already installed).
- **Size**: `h-4 w-4` for inline, `h-5 w-5` for nav/header, `h-8 w-8` or larger for empty states.
- **Never** use emoji in components — always use Lucide icons.

### Common Icons
| Purpose | Icon | Component |
|:--------|:-----|:----------|
| Dashboard | `LayoutDashboard` | `<LayoutDashboard />` |
| Board/Kanban | `Kanban` | `<Kanban />` |
| Agents/Bot | `Bot` | `<Bot />` |
| Labels/Tags | `Tag` | `<Tag />` |
| Knowledge Base | `BookOpen` | `<BookOpen />` |
| Settings | `Settings` | `<Settings />` |
| Back | `ArrowLeft` | `<ArrowLeft />` |
| Loading spinner | `Loader2` | `<Loader2 class="animate-spin" />` |
| Error | `AlertCircle` | `<AlertCircle />` |
| Empty state | `Inbox` | `<Inbox />` |
| Add/Create | `Plus` | `<Plus />` |
| Delete | `Trash2` | `<Trash2 />` |
| Edit | `Pencil` | `<Pencil />` |
| Search | `Search` | `<Search />` |
| Sun (light) | `Sun` | `<Sun />` |
| Moon (dark) | `Moon` | `<Moon />` |
| Monitor (system) | `Monitor` | `<Monitor />` |

---

## Dialogs vs Pages

| Use Case | Pattern | Example |
|:---------|:-------|:--------|
| Create entity (simple form, <5 fields) | Dialog | Create ticket, create project, create label |
| Edit entity (simple) | Dialog | Edit label |
| View/manage entity (complex, multiple sections) | Full page | Ticket detail, KB search |
| List with CRUD | Page with inline dialog for create | Agents list, labels list |
| Settings/config | Full page | Project settings (future) |

---

## Forms

- **Always** use `vee-validate` + `zod` with `toTypedSchema()`.
- **Always** wrap fields in `<FormField>` + `<FormItem>` + `<FormLabel>` + `<FormControl>` + `<FormMessage>`.
- **Reset** form state after successful submission (`resetForm()`).
- **Disable** submit button while submitting (`isSubmitting` from `useForm`).

---

## Responsive Breakpoints

| Breakpoint | Tailwind | Behavior |
|:-----------|:---------|:---------|
| Mobile | `< sm` (640px) | Sidebar hidden by default, hamburger toggle |
| Tablet | `sm` – `lg` | Sidebar visible, content adapts |
| Desktop | `≥ lg` (1024px) | Full layout, grid columns expand |

### Sidebar
- Default **open** on `≥ lg`, **closed** on `< lg`.
- Toggle button always visible in header.
- Sidebar overlays content on mobile (fixed positioning + backdrop).

---

*Created: 2026-03-29. Update when visual decisions change.*
