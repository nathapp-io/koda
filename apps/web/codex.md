# Codex Instructions

This file is auto-generated from `.nax/context.md`.
DO NOT EDIT MANUALLY — run `nax generate` to regenerate.

---

## Project Metadata

> Auto-injected by `nax generate`

**Project:** `@nathapp/koda-web`

**Language:** TypeScript

**Key dependencies:** @nuxtjs/color-mode, @nuxtjs/i18n, @nuxtjs/tailwindcss, @vee-validate/zod, lucide-vue-next, nuxt, radix-vue, shadcn-nuxt, vue, vue-router

---
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
| i18n | `@nuxtjs/i18n` | `no_prefix` strategy, `en` + `zh` |
| Form validation | `vee-validate` + `zod` | Always use together for forms |
| E2E testing | Playwright | `test:e2e` script |
| Unit testing | Jest | `test` script |

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
| `Avatar`, `AvatarImage`, `AvatarFallback` | `~/components/ui/avatar` | Assignee display |
| `Badge` | `~/components/ui/badge` | Status, priority, ticket type labels |
| `Button` | `~/components/ui/button` | All buttons |
| `Card`, `CardHeader`, `CardContent`, `CardFooter` | `~/components/ui/card` | Ticket cards, project cards |
| `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogTrigger` | `~/components/ui/dialog` | Create ticket modal, confirm dialogs |
| `DropdownMenu`, `DropdownMenuContent`, `DropdownMenuItem`, `DropdownMenuTrigger` | `~/components/ui/dropdown-menu` | Ticket action menus |
| `Form`, `FormField`, `FormItem`, `FormLabel`, `FormControl`, `FormMessage` | `~/components/ui/form` | All validated forms |
| `Input` | `~/components/ui/input` | Text inputs in forms |
| `Label` | `~/components/ui/label` | Form field labels |
| `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `SelectValue` | `~/components/ui/select` | Priority, type, assignee dropdowns |
| `Separator` | `~/components/ui/separator` | Visual dividers |
| `Sonner` (Toast) | `~/components/ui/sonner` | Success/error notifications |
| `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell` | `~/components/ui/table` | Agent list, project list |
| `Tabs`, `TabsContent`, `TabsList`, `TabsTrigger` | `~/components/ui/tabs` | Tabbed views |
| `Textarea` | `~/components/ui/textarea` | Comment body, ticket description |
| `Tooltip`, `TooltipContent`, `TooltipProvider`, `TooltipTrigger` | `~/components/ui/tooltip` | Icon button hints |

---

## Custom Components

| Component | Purpose |
|:----------|:--------|
| `AppBreadcrumb` | Navigation breadcrumbs |
| `BackButton` | Go-back navigation button |
| `CommentThread` | Threaded comment display |
| `CreateAgentDialog` | Create agent modal |
| `CreateProjectDialog` | Create project modal |
| `CreateTicketDialog` | Create ticket modal |
| `DeleteAgentDialog` | Delete agent confirmation |
| `EditAgentCapabilitiesDialog` | Edit agent capabilities |
| `EditAgentRolesDialog` | Edit agent roles |
| `EmptyState` | Empty data placeholder |
| `ErrorState` | Error display with retry |
| `KbAddDocumentDialog` | Add document to knowledge base |
| `KbResultCard` | Knowledge base search result card |
| `KbVerdictBanner` | KB verdict summary banner |
| `LanguageSwitcher` | i18n locale toggle |
| `LoadingState` | Loading spinner/skeleton |
| `PageHeader` | Consistent page header layout |
| `RotateKeyDialog` | Rotate agent API key |
| `ThemeSwitcher` | Dark/light mode toggle |
| `TicketActionPanel` | Ticket state transition actions |
| `TicketBoard` | Kanban-style ticket board |
| `TicketCard` | Ticket summary card |

---

## Pages & Routing

```
pages/
├── index.vue                       # Dashboard / home (redirects to projects)
├── login.vue                       # Login form
├── register.vue                    # Registration form
├── projects.vue                    # Project list
├── agents.vue                      # Global agent management
└── [project]/                      # Project-scoped pages
    ├── index.vue                   # Project board (tickets kanban)
    ├── agents.vue                  # Project agents
    ├── kb.vue                      # Knowledge base search
    ├── labels.vue                  # Label management
    └── tickets/
        └── [ref].vue               # Ticket detail view
```

---

## Middleware

### `auth.global.ts` — Global Auth Guard
- Redirects unauthenticated users to `/login`
- Redirects authenticated users away from `/login` and `/register`
- Auto-fetches user profile if token cookie exists but user not loaded

---

## API Client & Proxy

### Composables
- **`useApi()`** — configured Axios client for all API calls
- **`useAuth()`** — login, logout, register, token management
- **`useAppToast()`** — toast notifications (success/error)

### API Proxy (Nuxt → API)
Nuxt proxies `/api/**` requests to the API server. Configured in `nuxt.config.ts`:

```typescript
routeRules: {
  '/api/**': {
    proxy: `${process.env.NUXT_API_INTERNAL_URL || 'http://localhost:3100'}/api/**`,
  },
},
```

- **Browser:** requests go to `/api/...` (same origin)
- **SSR:** Nuxt server proxies to `NUXT_API_INTERNAL_URL` (e.g. `http://api:3100` in Docker)

### Generated Client
`generated/` directory is auto-generated from `openapi.json`:
```
generated/
├── core/
├── index.ts
├── schemas.gen.ts
├── services.gen.ts
└── types.gen.ts
```
Regenerate with `bun run generate` from monorepo root. Never edit manually.

---

## i18n — Client-Side Translations

Uses `@nuxtjs/i18n` with `no_prefix` strategy (no URL locale prefixes).

### Translation files
```
i18n/locales/
├── en.json               ← English (source of truth)
└── zh.json               ← Chinese
```

### Key structure (nested, single file per locale)
Top-level keys: `common`, `auth`, `nav`, `projects`, `tickets`, `comments`, `agents`, `kb`, `labels`, `toast`

### Usage in components
```vue
<script setup lang="ts">
const { t } = useI18n()
</script>

<template>
  <Button>{{ t('common.cancel') }}</Button>
  <h1>{{ t('auth.login.title') }}</h1>
</template>
```

### Language switching
```vue
const { locale } = useI18n()
locale.value = 'zh'  // switches to Chinese
```
Browser detection enabled via cookie (`koda_locale`), fallback: `en`.

### Rules
1. **All UI text** must use `t()` — no hardcoded strings in templates
2. When adding new pages/features, add keys to **both** `en.json` and `zh.json`
3. Top-level key = feature area (e.g. `tickets`, `agents`) — keep consistent with API module names
4. `en.json` is the source of truth — add English first, then Chinese

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
const toast = useAppToast()

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
| Middleware | `middleware/auth.global.ts` |
| Tests (unit) | `tests/pages/*.spec.ts`, `tests/composables/*.spec.ts` |
| Tests (E2E) | Playwright config at `playwright.config.ts` |
| Translations | `i18n/locales/{en,zh}.json` |

---

## Tailwind Conventions

- Use `space-y-*` for vertical stacking inside forms/cards
- Use `gap-*` inside flex/grid containers
- Use semantic colors: `text-muted-foreground`, `bg-background`, `border-border`
- Avoid hardcoded colors like `text-gray-500` — use Shadcn CSS variables instead
- Dark mode works automatically via CSS variables — do not add `dark:` classes to Shadcn component internals

---

## Commands

```bash
bun run build          # nuxt build
bun run dev            # nuxt dev --port 3101
bun run test           # jest (unit/component tests)
bun run test:e2e       # playwright test
bun run test:e2e:ui    # playwright test --ui
bun run type-check     # nuxt typecheck
bun run lint           # eslint
bun run lint:fix       # eslint --fix
```
