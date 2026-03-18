# CLAUDE.md — Koda Web (`apps/web`)

Nuxt 3 + Shadcn-nuxt + Tailwind CSS. This file is the authoritative reference for building the Koda web UI. Do not guess component APIs — use the patterns documented here.

---

## Stack

| Layer | Package | Notes |
|:------|:--------|:------|
| Framework | `nuxt` ^3.16 | App router, file-based pages |
| UI components | `shadcn-nuxt` | Copy-paste components in `components/ui/` |
| Primitives | `radix-vue` | Underlying accessibility primitives |
| Styling | `@nuxtjs/tailwindcss` | Utility-first CSS |
| Icons | `lucide-vue-next` | `<LucideIcon />` pattern |
| Dark mode | `@nuxtjs/color-mode` | `classSuffix: ''` — class-based toggle |
| Form validation | `vee-validate` + `zod` | Always use together for forms |

---

## Adding Shadcn-nuxt Components

Install a component via CLI — never hand-write UI primitives:

```bash
cd apps/web
bunx shadcn-vue@latest add <component-name>
```

This copies the component source into `components/ui/<component>/`. All components are owned by this repo — edit freely.

---

## Installed Components (Koda)

| Component | Import path | Used for |
|:----------|:-----------|:---------|
| `Button` | `~/components/ui/button` | All buttons |
| `Card`, `CardHeader`, `CardContent`, `CardFooter` | `~/components/ui/card` | Ticket cards, project cards |
| `Badge` | `~/components/ui/badge` | Status, priority, ticket type labels |
| `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogTrigger` | `~/components/ui/dialog` | Create ticket modal, confirm dialogs |
| `Input` | `~/components/ui/input` | Text inputs in forms |
| `Textarea` | `~/components/ui/textarea` | Comment body, ticket description |
| `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `SelectValue` | `~/components/ui/select` | Priority, type, assignee dropdowns |
| `Label` | `~/components/ui/label` | Form field labels |
| `Form`, `FormField`, `FormItem`, `FormLabel`, `FormControl`, `FormMessage` | `~/components/ui/form` | All validated forms |
| `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell` | `~/components/ui/table` | Agent list, project list |
| `Separator` | `~/components/ui/separator` | Visual dividers |
| `Avatar`, `AvatarImage`, `AvatarFallback` | `~/components/ui/avatar` | Assignee display |
| `Tooltip`, `TooltipContent`, `TooltipProvider`, `TooltipTrigger` | `~/components/ui/tooltip` | Icon button hints |
| `Sonner` (Toast) | `~/components/ui/sonner` | Success/error notifications |
| `DropdownMenu`, `DropdownMenuContent`, `DropdownMenuItem`, `DropdownMenuTrigger` | `~/components/ui/dropdown-menu` | Ticket action menus |

---

## Usage Patterns

### Button

```vue
<Button>Save</Button>
<Button variant="outline">Cancel</Button>
<Button variant="destructive">Delete</Button>
<Button variant="ghost" size="icon">
  <LucidePencil class="h-4 w-4" />
</Button>
```

Variants: `default` | `outline` | `ghost` | `destructive` | `secondary` | `link`  
Sizes: `default` | `sm` | `lg` | `icon`

### Badge (Status / Priority / Type)

```vue
<!-- Ticket status -->
<Badge variant="outline">CREATED</Badge>
<Badge class="bg-blue-100 text-blue-800">VERIFIED</Badge>
<Badge class="bg-yellow-100 text-yellow-800">IN_PROGRESS</Badge>
<Badge class="bg-purple-100 text-purple-800">VERIFY_FIX</Badge>
<Badge class="bg-green-100 text-green-800">CLOSED</Badge>
<Badge variant="destructive">REJECTED</Badge>

<!-- Priority -->
<Badge variant="destructive">CRITICAL</Badge>
<Badge class="bg-orange-100 text-orange-800">HIGH</Badge>
<Badge variant="secondary">MEDIUM</Badge>
<Badge variant="outline">LOW</Badge>

<!-- Ticket type -->
<Badge variant="outline" class="border-red-300 text-red-700">BUG</Badge>
<Badge variant="outline" class="border-blue-300 text-blue-700">ENHANCEMENT</Badge>
```

### Card

```vue
<Card>
  <CardHeader>
    <CardTitle>Project Name</CardTitle>
    <CardDescription>Optional description</CardDescription>
  </CardHeader>
  <CardContent>
    <!-- content -->
  </CardContent>
  <CardFooter class="justify-end gap-2">
    <Button variant="outline">Cancel</Button>
    <Button>Save</Button>
  </CardFooter>
</Card>
```

### Form with VeeValidate + Zod

Always use `vee-validate` + `zod` for form validation. Never use raw `v-model` on form inputs without validation.

```vue
<script setup lang="ts">
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import * as z from 'zod'

const formSchema = toTypedSchema(z.object({
  title: z.string().min(3, 'Title must be at least 3 characters'),
  type: z.enum(['BUG', 'ENHANCEMENT']),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
  description: z.string().optional(),
}))

const { handleSubmit } = useForm({ validationSchema: formSchema })

const onSubmit = handleSubmit(async (values) => {
  // call API
})
</script>

<template>
  <form @submit="onSubmit" class="space-y-4">
    <FormField name="title" v-slot="{ componentField }">
      <FormItem>
        <FormLabel>Title</FormLabel>
        <FormControl>
          <Input placeholder="Short description of the issue" v-bind="componentField" />
        </FormControl>
        <FormMessage />
      </FormItem>
    </FormField>

    <FormField name="type" v-slot="{ componentField }">
      <FormItem>
        <FormLabel>Type</FormLabel>
        <Select v-bind="componentField">
          <FormControl>
            <SelectTrigger>
              <SelectValue placeholder="Select type" />
            </SelectTrigger>
          </FormControl>
          <SelectContent>
            <SelectItem value="BUG">Bug</SelectItem>
            <SelectItem value="ENHANCEMENT">Enhancement</SelectItem>
          </SelectContent>
        </Select>
        <FormMessage />
      </FormItem>
    </FormField>

    <Button type="submit">Create Ticket</Button>
  </form>
</template>
```

### Dialog (Modal)

```vue
<Dialog>
  <DialogTrigger as-child>
    <Button>New Ticket</Button>
  </DialogTrigger>
  <DialogContent class="sm:max-w-[500px]">
    <DialogHeader>
      <DialogTitle>Create Ticket</DialogTitle>
    </DialogHeader>
    <!-- form goes here -->
  </DialogContent>
</Dialog>
```

### Toast Notifications (Sonner)

Add `<Toaster />` once in `app.vue`, then use anywhere:

```vue
<script setup lang="ts">
import { toast } from 'vue-sonner'

// Success
toast.success('Ticket created successfully')

// Error
toast.error('Failed to create ticket')
</script>
```

### Table

```vue
<Table>
  <TableHeader>
    <TableRow>
      <TableHead>Name</TableHead>
      <TableHead>Role</TableHead>
      <TableHead>Status</TableHead>
    </TableRow>
  </TableHeader>
  <TableBody>
    <TableRow v-for="agent in agents" :key="agent.id">
      <TableCell>{{ agent.name }}</TableCell>
      <TableCell>
        <Badge variant="outline">{{ agent.role }}</Badge>
      </TableCell>
      <TableCell>{{ agent.status }}</TableCell>
    </TableRow>
  </TableBody>
</Table>
```

---

## API Client Pattern

Use `useApi` composable for all API calls — never use `$fetch` or `useFetch` directly:

```typescript
// composables/useApi.ts exports useApi()
const { $api } = useApi()

// GET
const projects = await $api.get('/projects')

// POST
const ticket = await $api.post('/tickets', { title, type, priority })

// PATCH
await $api.patch(`/tickets/${id}/verify`, { comment })
```

---

## Dark Mode

Color mode is class-based. Toggle with:

```vue
<script setup lang="ts">
const colorMode = useColorMode()
</script>

<template>
  <Button variant="ghost" size="icon" @click="colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'">
    <LucideSun v-if="colorMode.value === 'dark'" class="h-4 w-4" />
    <LucideMoon v-else class="h-4 w-4" />
  </Button>
</template>
```

---

## File Conventions

| Pattern | Example |
|:--------|:--------|
| Pages | `pages/[project]/tickets/[id].vue` |
| Layouts | `layouts/default.vue`, `layouts/auth.vue` |
| Composables | `composables/useApi.ts`, `composables/useAuth.ts` |
| Custom components | `components/TicketCard.vue` (PascalCase) |
| Shadcn components | `components/ui/button/index.ts` (auto-generated, do not edit manually) |

---

## Tailwind Conventions

- Use `space-y-*` for vertical stacking inside forms/cards
- Use `gap-*` inside flex/grid containers
- Use semantic colors: `text-muted-foreground`, `bg-background`, `border-border`
- Avoid hardcoded colors like `text-gray-500` — use Shadcn CSS variables instead
- Dark mode works automatically via CSS variables — do not add `dark:` classes to Shadcn component internals
