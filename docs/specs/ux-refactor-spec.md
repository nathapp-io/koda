# SPEC: Web UX Refactor — Align with Design System

## Summary

Refactor `apps/web` to align with the UX docs in `docs/ux/`. This covers toast positioning, shared state components, sidebar navigation with icons and active states, breadcrumbs with back button, and page template consistency.

## Reference Docs

Read these FIRST before any implementation:
- `docs/ux/navigation-map.md` — sitemap, sidebar rules, breadcrumbs
- `docs/ux/design-tokens.md` — toast, typography, colors, states, icons
- `docs/ux/page-templates.md` — standard layouts, shared components
- `docs/ux/component-patterns.md` — forms, dialogs, badges, i18n

---

## Phase 1: Toast + Shared State Components

### 1A. Fix toast position
In `apps/web/app.vue`, replace `<Toaster />` with:
```vue
<Toaster position="top-right" :visible-toasts="3" rich-colors />
```

### 1B. Create shared components

Create these in `apps/web/components/`:

**`LoadingState.vue`**
- Spinner icon (`Loader2` from lucide-vue-next with `animate-spin`) + "Loading..." text
- Centered, `py-12`, `text-muted-foreground`

**`ErrorState.vue`**
- `AlertCircle` icon + error message + Retry button
- Props: none. Emits: `retry`
- Uses `t('common.loadFailed')` and `t('common.retry')`

**`EmptyState.vue`**
- `Inbox` icon + message + optional action slot
- Props: `message: string`, `icon?: Component`
- Slot: `#action` for CTA button

**`PageHeader.vue`**
- Title (`h1`) + optional subtitle + action slot
- Props: `title: string`, `subtitle?: string`
- Slot: `#actions` for top-right buttons

**`AppBreadcrumb.vue`**
- Renders breadcrumb trail with `/` separators
- Props: `items: { label: string, to?: string }[]`
- Last item renders as plain text (current page), others as NuxtLink
- See `docs/ux/page-templates.md` for exact implementation

**`BackButton.vue`**
- `ArrowLeft` icon button
- Props: `to: string`
- Renders as NuxtLink, styled as icon button

### 1C. Add i18n keys if missing

Ensure `en.json` and `zh.json` have:
```json
"common": {
  "loading": "Loading...",
  "loadFailed": "Failed to load data",
  "retry": "Retry"
}
```

---

## Phase 2: Sidebar + Breadcrumbs

### 2A. Refactor sidebar in `layouts/default.vue`

Replace current sidebar nav with:
- **Icons**: Use lucide-vue-next icons per `docs/ux/navigation-map.md` icon table
  - Dashboard: `LayoutDashboard`
  - Board: `Kanban`
  - Agents: `Bot`
  - Labels: `Tag`
  - Knowledge Base: `BookOpen`
- **Active state**: Active link gets `bg-accent text-accent-foreground`. Use NuxtLink's `exactActiveClass` for Board, `activeClass` for others.
- **Two-level model**: Dashboard always visible. Board/Agents/Labels/KB only when inside `/:project/*` route.
- **Move Language + Theme switchers** to sidebar footer (compact icons).
- **Keep** user email + logout in header only (remove from sidebar if duplicated).

### 2B. Add breadcrumbs to default layout

Add breadcrumb bar between header and page content:
```vue
<div v-if="breadcrumbItems.length > 1" class="flex items-center gap-2 border-b border-border px-6 py-2">
  <BackButton :to="backTo" />
  <AppBreadcrumb :items="breadcrumbItems" />
</div>
```

Compute breadcrumb items from route:
- `/` → no breadcrumbs
- `/:project` → `[{label:'Koda', to:'/'}, {label: projectName}]`
- `/:project/tickets/:ref` → `[{label:'Koda', to:'/'}, {label: projectName, to:'/:project'}, {label:'Tickets', to:'/:project'}, {label: ref}]`
- `/:project/agents` → `[{label:'Koda', to:'/'}, {label: projectName, to:'/:project'}, {label:'Agents'}]`
- Same pattern for labels, kb

Back button target:
- Ticket detail → `/:project`
- Project sub-pages → `/:project`
- Project board → `/`

For project name: use route params + a composable that caches project name (or just use slug as fallback).

### 2C. Create `/projects` redirect

Create `apps/web/pages/projects.vue`:
```vue
<script setup lang="ts">
definePageMeta({ layout: 'default' })
navigateTo('/', { redirectCode: 301 })
</script>
```

---

## Phase 3: Apply Page Templates

Refactor each page to follow the standard templates from `docs/ux/page-templates.md`:

### 3A. Dashboard (`pages/index.vue`)
- Already mostly correct. Add `PageHeader` component usage.
- Ensure uses `LoadingState`, `ErrorState`, `EmptyState` shared components.

### 3B. Project Board (`pages/[project]/index.vue`)
- Add `PageHeader` with project name + Create Ticket button.
- Use `LoadingState` and `ErrorState`.

### 3C. Ticket Detail (`pages/[project]/tickets/[ref].vue`)
- Ensure two-column layout (main 2/3 + sidebar 1/3).
- On mobile: sidebar stacks below.
- Uses `LoadingState` and `ErrorState`.

### 3D. Agents (`pages/[project]/agents.vue`)
- Follow List Page template.
- Use `PageHeader`, `LoadingState`, `ErrorState`, `EmptyState`.

### 3E. Labels (`pages/[project]/labels.vue`)
- Follow List Page template.
- Use `PageHeader`, `LoadingState`, `ErrorState`, `EmptyState`.
- Remove `console.error` calls.

### 3F. KB (`pages/[project]/kb.vue`)
- Follow Search + Results template.
- Use `PageHeader`, `LoadingState`, `ErrorState`.

### 3G. All pages
- Add `definePageMeta({ layout: 'default' })` to any page missing it.
- Replace ThemeSwitcher emoji icons with Lucide `Sun`, `Moon`, `Monitor` components.

---

## Testing

After each phase:
1. Run `cd apps/web && bun run type-check` (or `npx nuxi typecheck`)
2. Run `cd apps/web && bun test` (Jest tests)
3. Run `cd apps/web && bun run lint` (ESLint)
4. Fix any issues before moving to next phase.

## Git

- Work on branch `refactor/web-ux-alignment`
- Commit after each phase with descriptive message
- Do NOT push to remote

---

*Created: 2026-03-29*
