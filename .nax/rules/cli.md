---
paths:
  - "apps/cli/*"
---

# CLI Rules — apps/cli

## API Client
- Use generated client in `src/generated/`; do not hand-write HTTP calls
- Configure before each call:
  - `OpenAPI.BASE = ctx.apiUrl`
  - `OpenAPI.TOKEN = ctx.apiKey`
- Handle API failures with generated `ApiError`
- Do not use raw `axios`, `AxiosInstance`, or `configureClient()`
- Generated functions return data directly (no axios envelope unwrap needed)

## Output
- Data-returning commands must support `--json`
- `--json` mode outputs `JSON.stringify(data, null, 2)`
- Human-friendly output can use `chalk`
- Write warnings/errors to stderr
- CLI-owned strings remain English; translated API messages come from API responses

## Exit Codes
- `0`: success
- `1`: API/network error
- `2`: config/auth error
- `3`: validation error

## Auth & Config Resolution
1. `--api-key` / `--api-url` flags
2. `KODA_API_KEY` / `KODA_API_URL`
3. `~/.koda/config.json`

## Config Rules
- `koda init` creates project config at `.koda/config.json`
- Global credentials live at `~/.koda/config.json`
- `resolveContext()` merges project-local and global config

## Generated Client Rules
- `src/generated/` is regenerated (`bun run generate:cli` from repo root)
- Never edit generated files
- Use generated function imports and generated types over handwritten equivalents
- `ctx.apiUrl` should be bare host (no `/api` suffix)
- Including `/api` in `--api-url` will double-prefix generated paths and can cause 404s

## Implementation Anti-Patterns
- Do not hardcode API URLs
- Do not use sync FS operations in production command paths (`readFileSync`)
- Use shared validation/output helpers; avoid duplicating command-local variants
- Retry transient 5xx failures with backoff when appropriate

## Quick Reference
- Wrong: `OpenAPI.BASE = 'http://localhost:3100/api'`
- Correct: `OpenAPI.BASE = 'http://localhost:3100'`
- Wrong: validation failures exiting with code `1`
- Correct: validation failures exit with code `3`
