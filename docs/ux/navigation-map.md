# Navigation Map — Koda Web UI

> Authoritative reference for page hierarchy, sidebar behavior, and breadcrumbs.
> Every new page must be added here before implementation.

---

## Sitemap

```
/login                          ← Auth layout (no sidebar)
/register                       ← Auth layout (no sidebar)

/                               ← Dashboard: needs-you, projects, recent activity
/projects                       ← Alias → redirects to /

/:project                       ← Project board (kanban)
/:project/tickets/:ref          ← Ticket detail
/:project/agents                ← Agent registry
/:project/labels                ← Label management
/:project/kb                    ← Knowledge base (search + documents)
/:project/timeline              ← Project timeline
/:project/memory                ← Agent memory
/:project/code-intel            ← Code intelligence
/:project/settings              ← Project settings
/:project/fleet                 ← Fleet jobs list
/:project/fleet/overview        ← Fleet overview (project scope)
/:project/fleet/jobs/:id        ← Fleet job detail
/:project/fleet/jobs/:id/logs   ← Fleet job log viewer
/:project/fleet/approvals       ← Fleet approvals inbox (project scope)
/:project/fleet/budgets         ← Fleet budget policies
/:project/fleet/schedules       ← Fleet schedules (+ detail)
/:project/fleet/dispatch        ← Fleet dispatch form
/:project/fleet/analytics       ← Fleet analytics (project scope)

/agents                         ← Global agent registry
/admin/users                    ← Admin: users (global admin)
/admin/slos                     ← Admin: SLOs (global admin)
/admin/fleet                    ← Fleet overview (global scope)
/admin/fleet/runners            ← Admin: runner registry
/admin/fleet/repos              ← Admin: repo registry
/admin/fleet/budgets            ← Admin: budget policies
/admin/fleet/approvals          ← Admin: approvals inbox
/admin/fleet/analytics          ← Admin: fleet analytics
```

---

## Navigation Hierarchy

```
Root
├── / (Dashboard)
│   └── /:project (Project Board)
│       ├── /:project/tickets/:ref (Ticket Detail)
│       ├── /:project/agents, /labels, /kb, /timeline, /memory, /code-intel, /settings
│       └── /:project/fleet/** (overview, jobs, approvals, budgets, schedules, dispatch, analytics)
├── /agents (Agents)
├── /admin/** (global admin only: users, slos, fleet)
├── /login (Auth)
└── /register (Auth)
```

---

## Sidebar Rules

The sidebar (`layouts/default.vue`) is a **fixed 224px (`w-56`) column with labelled, grouped
sections**. It is pinned by `tests/layouts/*` — keep nav links inline in the template (not
data-driven) and keep the source order below.

### Groups (in DOM order)
1. **Workspace** (`nav.sectionWorkspace`): Dashboard (`/`), Agents (`/agents`), SLOs (`/admin/slos`).
2. **Admin** (`nav.sectionAdmin`, rendered only for global admins): Users, Fleet overview
   (`/admin/fleet`), Runners, Repos, Budgets, Approvals, Fleet analytics.
3. **Project block** (rendered when inside `/:project/*`, shown **first** via CSS `order-first`;
   DOM order is unchanged): project name, then Work (Board, Labels, Agents), Knowledge (KB, Timeline,
   Memory, Code Intel), Fleet (Overview above Fleet jobs, then Fleet analytics), and Settings.

### Behavior
- **Active state**: `NuxtLink` with `activeClass` → `bg-accent text-accent-foreground`; the
  Dashboard and Board links use exact match.
- **Drawer below 1024px**: the sidebar starts closed, overlays the content with a backdrop, and
  auto-closes on route change. The header hamburger toggles it at every width.
- **Skip link**: `nav.skipToContent` targets `#main`, first element in the layout.
- **Command palette**: the header search button opens `CommandPalette`; global `Cmd/Ctrl+K`
  toggles it. New top-level destinations must be added there too.
- **Footer**: language + theme switchers. User identity stays in the header.

---

## Breadcrumbs

Every page inside the default layout renders a breadcrumb bar below the header.

### Format
```
Koda > MyProject > Tickets > NAX-1
```

### Rules
1. **First segment** is always `Koda` (links to `/`).
2. **Project segment** shows the project name (links to `/:project`).
3. **Page segment** shows the current section (Agents, Labels, KB, etc.) — no link (current page).
4. **Detail segment** (optional) shows the entity identifier (e.g., ticket ref `NAX-1`) — no link.

### Breadcrumb per Page

| Page | Breadcrumb |
|:-----|:-----------|
| `/` | `Koda` (no breadcrumb bar — it's home) |
| `/:project` | `Koda > {project.name}` |
| `/:project/tickets/:ref` | `Koda > {project.name} > Tickets > {ref}` |
| `/:project/agents` | `Koda > {project.name} > Agents` |
| `/:project/labels` | `Koda > {project.name} > Labels` |
| `/:project/kb` | `Koda > {project.name} > Knowledge Base` |

### Back Button
- Shown on **detail pages** (ticket detail) and **project sub-pages**.
- On ticket detail: navigates to `/:project` (the board).
- On project sub-pages (agents, labels, kb): navigates to `/:project` (the board).
- On project board: navigates to `/` (dashboard).
- Rendered as a `←` icon button left of the breadcrumb.

---

## Layout Assignment

| Page Pattern | Layout | Sidebar | Breadcrumbs | Header |
|:-------------|:-------|:--------|:------------|:-------|
| `/login`, `/register` | `auth` | ❌ | ❌ | ❌ |
| `/` | `default` | ✅ (global only) | ❌ | ✅ |
| `/:project/**` | `default` | ✅ (global + project) | ✅ | ✅ |

---

## `/projects` Route

`/projects` is an alias that redirects to `/`. The dashboard (`/`) serves as both the home page and the project list. If a dedicated projects page is needed later (e.g., with search/filter), it can be split out — but for now, one page avoids confusion.

Implementation:
```ts
// apps/web/pages/projects.vue
definePageMeta({ layout: 'default' })
// Redirect to dashboard
navigateTo('/', { redirectCode: 301 })
```

---

## Future Pages (Placeholder)

These are anticipated but not yet built. Add to sidebar when implemented.

| Page | Route | Notes |
|:-----|:------|:------|
| User Profile | `/profile` | User settings, API keys |

---

*Created: 2026-03-29. Update this doc whenever a page is added or navigation changes.*
