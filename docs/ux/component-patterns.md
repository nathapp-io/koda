# Component Patterns — Koda Web UI

> When to use which component pattern, and how to compose them.

---

## Decision Matrix

| Question | Answer → Pattern |
|:---------|:-----------------|
| Simple CRUD on a list? | **Table** with inline create dialog |
| Visual workflow with stages? | **Kanban board** with column cards |
| View a single entity with actions? | **Detail page** with sidebar panel |
| Quick input (< 5 fields)? | **Dialog** (modal) |
| Complex input (> 5 fields, sections)? | **Full page form** |
| Search + results? | **Tabs** (search / browse) with result cards |
| Confirm a destructive action? | **AlertDialog** (not regular Dialog) |

---

## Tables

Use for: Agents, Labels, Documents — simple lists with columns.

### Rules
- Always include column headers.
- Action buttons (edit, delete) in the last column, right-aligned.
- Clickable rows → navigate to detail (if detail page exists).
- Use `<TableCell class="text-right">` for action columns.
- Empty state inside `<TableBody>` as a full-width row.

---

## Cards

Use for: Project cards on dashboard, ticket cards on kanban.

### Rules
- Cards are **clickable** when they link to a detail view. Add `cursor-pointer hover:shadow-md transition-shadow`.
- Card content is brief — title, 1-2 metadata badges, optional snippet.
- Never put forms inside cards (use dialogs).

---

## Dialogs

Use for: Create ticket, create project, create label, edit label.

### Rules
- Always include `<DialogHeader>` with `<DialogTitle>` and optional `<DialogDescription>`.
- **Close on success**: `emit('update:open', false)` + `resetForm()`.
- **Close on cancel**: `emit('update:open', false)` only (no form reset needed — it resets on next open).
- **Never** nest dialogs. If a flow needs two steps, use a page instead.
- Use `v-model:open` pattern from parent:
  ```vue
  <CreateItemDialog v-model:open="showCreate" @created="refresh()" />
  ```

---

## Forms

### Validation Stack
```
zod schema → toTypedSchema() → useForm({ validationSchema }) → FormField/FormItem/FormControl/FormMessage
```

### Rules
1. **Define schema** with Zod.
2. **Wrap** with `toTypedSchema()` from `@vee-validate/zod`.
3. **Destructure** `{ handleSubmit, isSubmitting, resetForm }` from `useForm()`.
4. **Submit button** shows loading state: `<Button :disabled="isSubmitting">`.
5. **On success**: toast, emit event, reset form.
6. **On error**: `toast.error(extractApiError(error))`.

### Example
```vue
<script setup lang="ts">
import { toTypedSchema } from '@vee-validate/zod'
import { z } from 'zod'
import { useForm } from 'vee-validate'
import { toast } from 'vue-sonner'
import { extractApiError } from '~/composables/useApi'

const schema = toTypedSchema(z.object({
  name: z.string().min(1, t('validation.required')),
}))

const { handleSubmit, isSubmitting, resetForm } = useForm({
  validationSchema: schema,
})

const onSubmit = handleSubmit(async (values) => {
  try {
    await $api.post('/items', values)
    toast.success(t('items.toast.created'))
    emit('created')
    emit('update:open', false)
    resetForm()
  } catch (error) {
    toast.error(extractApiError(error))
  }
})
</script>
```

---

## Toasts

### When to Toast
| Action | Toast type | Message |
|:-------|:-----------|:--------|
| Create success | `toast.success` | "Item created" |
| Update success | `toast.success` | "Item updated" |
| Delete success | `toast.success` | "Item deleted" |
| API error | `toast.error` | `extractApiError(error)` |
| Validation error | None — inline `<FormMessage>` handles it | |
| Info/hint | `toast.info` | Contextual message |

### When NOT to Toast
- Page load errors → use inline error state (ErrorState component).
- Form field validation → use `<FormMessage>` inline.
- Navigation events → no toast.

---

## Badges

### Status Badges
Use the color mapping from `design-tokens.md`. Always render as:
```vue
<Badge :class="statusClass(ticket.status)">{{ t(`tickets.status.${ticket.status}`) }}</Badge>
```

### Priority Badges
```vue
<Badge :variant="priorityVariant(ticket.priority)">{{ t(`tickets.priority.${ticket.priority}`) }}</Badge>
```

### Helper Functions
Extract `statusClass()` and `priorityVariant()` into a shared composable (`composables/useTicketDisplay.ts`) to avoid duplication across TicketCard, TicketBoard, and ticket detail page.

---

## Action Buttons

### Placement Rules
| Context | Placement |
|:--------|:---------|
| Page-level action (create) | Top-right of page header |
| Row-level action (delete, edit) | Right side of table row |
| Entity-level actions (change status) | Sidebar panel on detail page |
| Destructive actions | Use `variant="destructive"` + confirmation dialog |

### Confirmation Pattern
For delete and other destructive actions:
```vue
<AlertDialog>
  <AlertDialogTrigger as-child>
    <Button variant="destructive" size="sm">
      <Trash2 class="mr-2 h-4 w-4" /> Delete
    </Button>
  </AlertDialogTrigger>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>{{ t('common.confirmDelete') }}</AlertDialogTitle>
      <AlertDialogDescription>{{ t('common.confirmDeleteDesc') }}</AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel>{{ t('common.cancel') }}</AlertDialogCancel>
      <AlertDialogAction @click="handleDelete">{{ t('common.delete') }}</AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

---

## i18n Rules

1. **Every** user-facing string uses `t()`.
2. Keys follow the pattern: `{section}.{subsection}.{key}` (e.g., `tickets.toast.created`).
3. Add keys to **both** `en.json` and `zh.json`. Use English values for `zh.json` if Chinese translation is pending.
4. Validation messages: `{section}.validation.{field}` (e.g., `tickets.validation.titleRequired`).

---

*Created: 2026-03-29. Update when new patterns emerge.*
