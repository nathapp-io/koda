# Navigation Map — Koda Web UI

> Authoritative reference for page hierarchy, sidebar behavior, and breadcrumbs.
> Every new page must be added here before implementation.

---

## Sitemap

```
/login                          ← Auth layout (no sidebar)
/register                       ← Auth layout (no sidebar)

/                               ← Dashboard: project list + summary stats
/projects                       ← Alias → redirects to /

/:project                       ← Project board (kanban)
/:project/tickets/:ref          ← Ticket detail
/:project/agents                ← Agent registry
/:project/labels                ← Label management
/:project/kb                    ← Knowledge base (search + documents)
/:project/settings              ← (future) Project settings
```

---

## Navigation Hierarchy

```
Root
├── / (Dashboard / Projects)
│   └── /:project (Project Board)
│       ├── /:project/tickets/:ref (Ticket Detail)
│       ├── /:project/agents (Agents)
│       ├── /:project/labels (Labels)
│       ├── /:project/kb (Knowledge Base)
│       └── /:project/settings (Future)
├── /login (Auth)
└── /register (Auth)
```

---

## Sidebar Rules

The sidebar uses a **two-level** model: global links + project-scoped links.

### Always Visible (Global)
| Label | Route | Icon |
|:------|:------|:-----|
| Dashboard | `/` | `LayoutDashboard` |

### Project-Scoped (visible when inside `/:project/*`)
| Label | Route | Icon |
|:------|:------|:-----|
| Board | `/:project` | `Kanban` |
| Agents | `/:project/agents` | `Bot` |
| Labels | `/:project/labels` | `Tag` |
| Knowledge Base | `/:project/kb` | `BookOpen` |

### Active State
- Use `NuxtLink` with `activeClass` / `exactActiveClass` for highlighting.
- The active link gets `bg-accent text-accent-foreground` styling.
- Board link uses **exact** match; others use **prefix** match.

### Sidebar Footer
- Language switcher (compact icon)
- Theme switcher (compact icon)
- No user info in sidebar — that stays in the header.

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
| Project Settings | `/:project/settings` | Project config, danger zone (delete) |
| User Profile | `/profile` | User settings, API keys |
| Admin | `/admin` | User management, system config |

---

*Created: 2026-03-29. Update this doc whenever a page is added or navigation changes.*
