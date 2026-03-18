# CLAUDE.md — Koda CLI (apps/cli)

## Project: Koda CLI

Commander.js CLI for agents to interact with the Koda API. The CLI is a **thin shell** — all business logic stays in the API.

### Stack
- **CLI framework:** Commander.js
- **HTTP client:** Generated from OpenAPI spec via `@hey-api/client-axios` (see `src/generated/`)
- **Config store:** `conf` — stores `apiUrl` + `apiKey` in `~/.koda/config.json`
- **Output:** `chalk` for human output, `--json` flag for machine output
- **Build:** TypeScript → `dist/`
- **Bin:** `koda` → `dist/index.js`

### Key Constraints

1. **Never write HTTP calls manually** — always use generated client in `src/generated/`
2. **`--json` flag is mandatory** on all commands that return data — agents depend on it
3. **Exit codes must be correct:**
   - `0` = success
   - `1` = API error
   - `2` = config/auth error
   - `3` = validation error
4. **Auth resolution order:** `--api-key` flag → `KODA_API_KEY` env → `~/.koda/config.json`
5. **`koda ticket mine`** — shorthand for `ticket list --assigned-to self` — must work without `--project` if default project is set

### Project Structure
```
src/
├── index.ts           # Commander program entry, register all commands, shebang
├── config.ts          # conf store — read/write ~/.koda/config.json
├── client.ts          # Configure hey-api Axios client with baseUrl + Bearer token
├── commands/
│   ├── login.ts       # koda login --api-key <key> [--api-url <url>]
│   ├── config.ts      # koda config show|set
│   ├── project.ts     # koda project list|show
│   ├── ticket.ts      # koda ticket create|list|mine|show|verify|assign|start|fix|verify-fix|close|reject
│   ├── comment.ts     # koda comment add
│   └── agent.ts       # koda agent me|pickup
└── utils/
    ├── output.ts      # output(data, {json}) — table for humans, JSON.stringify for agents
    ├── error.ts       # handleApiError(err) → exit with correct code
    └── auth.ts        # resolveAuth(options) — flag → env → config fallback
```

### Auth Resolution
```typescript
export function resolveAuth(options: { apiKey?: string; apiUrl?: string }) {
  const config = getConfig();
  return {
    apiKey: options.apiKey ?? process.env.KODA_API_KEY ?? config.apiKey,
    apiUrl: options.apiUrl ?? process.env.KODA_API_URL ?? config.apiUrl ?? 'http://localhost:3100/api',
  };
}
```

### Output Pattern
```typescript
// Every command that returns data:
if (options.json) {
  console.log(JSON.stringify(data, null, 2));
  process.exit(0);
}
// Human output: chalk-formatted table
```

### Ticket Commands Reference
```bash
koda ticket create --project <slug> --type bug|enhancement --title "..." [--priority low|medium|high|critical]
koda ticket list --project <slug> [--status <s>] [--type <t>] [--unassigned] [--json]
koda ticket mine [--project <slug>] [--status verified] [--json]
koda ticket show <ref>                     # ref = KODA-42 or CUID
koda ticket verify <ref> --comment "..."
koda ticket assign <ref> [--to <agent-slug>]   # omit --to = self-assign
koda ticket start <ref>
koda ticket fix <ref> --comment "..."
koda ticket verify-fix <ref> --comment "..." [--pass|--fail]
koda ticket close <ref>
koda ticket reject <ref> --comment "..."
```

### Generated Client
The `src/generated/` directory is gitignored — regenerate with:
```bash
bun run generate   # from monorepo root — exports spec + regenerates client
```
Import pattern:
```typescript
import { TicketsService } from '../generated';
```

### Commands
```bash
bun run build        # tsc compile
bun run dev          # ts-node src/index.ts
bun run test         # jest
bun run type-check   # tsc --noEmit
bun run lint         # eslint src
```
