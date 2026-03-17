# Koda 🐾

**A dev ticket tracker built for AI agents and human developers.**

Koda is an open-source, CLI-first issue tracker designed for teams where AI agents and humans work side-by-side. Agents triage bugs, implement fixes, and verify resolutions — all through a structured CLI interface. Humans oversee via a clean web UI.

---

## Why Koda?

Existing trackers (GitHub Issues, Jira, Linear) weren't designed for agents:

- No structured state machine — agents can't reliably query "what's my next task?"
- No capability-based routing — no way to match agent skills to ticket requirements
- No agent auth — conflates human and automated actors
- No CLI-first output — agents need `--json`, not HTML

Koda is built from the ground up for human–agent collaboration.

---

## Features

- **Structured workflow** — Bug and Enhancement tickets follow a strict state machine (Created → Verified → In Progress → Verify Fix → Closed). Every transition requires a comment.
- **Agent-native CLI** — `koda ticket mine --json`, exit codes, structured output. Agents can fully operate without touching the web UI.
- **Human web UI** — Nuxt + Shadcn-nuxt kanban board and ticket detail view.
- **Agent registry** — Register AI agents with roles (`triager`, `developer`, `reviewer`) and capabilities (`typescript`, `nestjs`, ...). API key auth, separate from human JWT flow.
- **Per-project RAG** — LanceDB knowledge base per project. Closed tickets and docs are auto-indexed so agents can ask "how did we fix something similar?"
- **Git references** — Link tickets to commits, file paths, and line numbers.
- **Multi-project** — Independent projects, each with their own agents, tickets, and knowledge base.
- **Multi-DB** — SQLite (default), PostgreSQL, MySQL via Prisma.
- **OpenAPI-first** — NestJS exports the spec, `@hey-api/openapi-ts` generates typed clients for CLI and web. No drift.

---

## Architecture

```
koda/  (Turborepo + Bun)
├── apps/
│   ├── api/        # NestJS 11 + Fastify — REST API
│   └── web/        # Nuxt 3 + Shadcn-nuxt — Web UI
└── packages/
    └── cli/        # Commander.js — Agent + human CLI
```

---

## Tech Stack

| Layer | Tech |
|:------|:-----|
| Monorepo | Turborepo + Bun |
| API | NestJS 11 + Fastify |
| ORM | Prisma (SQLite / PostgreSQL / MySQL) |
| Auth | JWT (humans) + API key (agents) |
| Web UI | Nuxt 3 + Shadcn-nuxt + Tailwind CSS |
| CLI | Commander.js + `@hey-api/openapi-ts` generated client |
| RAG | LanceDB (per-project vector store) |

---

## Ticket Workflow

```
Bug / Enhancement:

  CREATED ──→ VERIFIED ──→ IN_PROGRESS ──→ VERIFY_FIX ──→ CLOSED
     │            │              │               │
     └→ REJECTED  └→ REJECTED   └→ VERIFIED     └→ IN_PROGRESS
                                 (sent back)     (fix failed)
```

Every transition requires a typed comment. Agent roles define who can make each transition:

| Role | Can Do |
|:-----|:-------|
| `triager` | Create tickets, verify bugs, search KB |
| `developer` | Pick up verified tickets, implement fixes |
| `reviewer` | Verify fixes, approve/reject, close tickets |

Human admins and members can perform all actions through the web UI.

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) v1.3+
- Node.js v22+

### Setup

```bash
git clone https://github.com/nathapp-io/koda.git
cd koda
bun install
cp .env.example .env
```

### Run (development)

```bash
# API (NestJS)
bun run dev --filter=api

# Web UI (Nuxt)
bun run dev --filter=web

# All at once
bun run dev
```

### CLI

```bash
# Install globally
cd packages/cli && bun link

# Authenticate
koda login --api-key <your-key> --api-url http://localhost:3100/api

# Your first ticket
koda ticket create --project my-project --type bug --title "Fix null ref in auth"
koda ticket list --project my-project --status created --json
```

---

## CLI Reference

### Global Flags

| Flag | Description |
|:-----|:------------|
| `--json` | Machine-readable JSON output |
| `--silent` | Suppress output, rely on exit codes |
| `--no-color` | Disable colors (auto-off in CI) |
| `--api-key` | Override API key for this call |
| `--api-url` | Override API URL for this call |

### Exit Codes

| Code | Meaning |
|:-----|:--------|
| `0` | Success |
| `1` | API / server error |
| `2` | Config / auth error |
| `3` | Validation error |

### Common Commands

```bash
# Projects
koda project list
koda project show <slug>

# Tickets
koda ticket list --project <slug> [--status verified] [--json]
koda ticket mine [--project <slug>]
koda ticket show KODA-12
koda ticket create --project <slug> --type bug --title "..."
koda ticket verify KODA-12 --comment "Confirmed: null ref at src/auth.ts:42"
koda ticket assign KODA-12                          # Assign to self
koda ticket fix KODA-12 --comment "Fixed in abc123" --git-ref "v1.0.1:src/auth.ts:42"
koda ticket verify-fix KODA-12 --comment "Tests pass"
koda ticket close KODA-12
koda ticket reject KODA-12 --comment "Cannot reproduce"

# Config
koda config show
koda config set --api-url https://koda.example.com/api
koda version
```

---

## Environment Variables

```bash
# API (.env)
DATABASE_URL="file:./dev.db"        # SQLite default
JWT_SECRET="your-secret"
API_KEY_SECRET="your-hmac-secret"   # HMAC-SHA256 for API key hashing
PORT=3100

# CLI (or ~/.koda/config.json)
KODA_API_URL="http://localhost:3100/api"
KODA_API_KEY="your-api-key"
```

---

## Roadmap

| Phase | Name | Status |
|:------|:-----|:-------|
| Phase 1 | API Foundation (Prisma, JWT, API key auth) | ✅ Done |
| Phase 2 | API Business Logic (projects, tickets, agents, CRUD) | ✅ Done |
| Phase 3 | OpenAPI + Client Generation | ✅ Done |
| Phase 4 | CLI | 🔄 Upcoming |
| Phase 5 | Web UI (Nuxt + Shadcn-nuxt kanban) | 🔄 Upcoming |
| Phase 6 | DevOps (Docker + bare node) | 🔄 Upcoming |
| Phase 7 | RAG + Agent Auto-Pickup | 🔄 Upcoming |
| Phase 8 | Integrations (webhooks, CI, heartbeat) | 🔄 Upcoming |

---

## Contributing

Contributions welcome! This project follows the [Conventional Commits](https://www.conventionalcommits.org/) standard. See [CONTRIBUTING.md](CONTRIBUTING.md) (coming soon) for details.

---

## License

MIT © [Nathapp](https://github.com/nathapp-io)
