# SPEC: Koda CLI Bugfix Batch — PR #2

## Summary

Two CLI bugs that crash or display wrong data during agent workflows. Both fixes are in `apps/cli/src/commands/` only — no API changes needed.

## Design

### Bug #17 — Use `ref` from API instead of hardcoded `KODA-` prefix

`apps/cli/src/commands/ticket.ts` has two table-rendering blocks (for `ticket list` and `ticket mine`) that hardcode `` `KODA-${t.number}` ``. Since the API now returns a `ref` field (added in PR #27 / US-004), the CLI should use it directly.

**Two occurrences to fix — both identical pattern:**
```ts
// Before (lines ~127 and ~179)
`KODA-${t.number}`

// After
String(t.ref || `KODA-${t.number}`)
```

No other changes needed. The `t.ref` field is already present in the API response.

### Bug #22 — Guard undefined `apiKey` in `agent me`

`apps/cli/src/commands/agent.ts` — `GET /agents/me` returns the Prisma agent row which stores `apiKeyHash` (one-way hash), never the plain `apiKey`. So `agentData.apiKey` is always `undefined`. The CLI calls `maskApiKey(agentData.apiKey)` which throws `Cannot read properties of undefined (reading 'length')`.

**Fix — null-guard the API key display:**
```ts
// Before
console.log(`API Key: ${maskApiKey(agentData.apiKey)}`);

// After
if (agentData.apiKey) {
  console.log(`API Key: ${maskApiKey(agentData.apiKey)}`);
} else {
  console.log(`API Key: (stored as hash — not recoverable)`);
}
```

## Stories

### US-005: Fix hardcoded KODA prefix in ticket list/mine display

**Bug: #17**

#### Acceptance Criteria

1. When `TicketsService.list()` returns tickets with a `ref` field (e.g. `'NAX-1'`), the `ticket list` table renders the first column as `'NAX-1'` (not `'KODA-1'`)
2. When `TicketsService.list()` returns tickets with a `ref` field (e.g. `'NAX-2'`), the `ticket mine` table renders the first column as `'NAX-2'` (not `'KODA-2'`)
3. When a ticket object has no `ref` field (undefined), the display falls back to `` `KODA-${t.number}` `` (backward-compat guard)
4. The fix is applied in both table-rendering blocks: the `list` subcommand (around line 127) and the `mine` subcommand (around line 179) of `apps/cli/src/commands/ticket.ts`

#### Context Files

- `apps/cli/src/commands/ticket.ts` — fix both hardcoded `KODA-${t.number}` occurrences in the table rows
- `apps/cli/src/commands/ticket.spec.ts` — add/update unit tests asserting `ref` is used when present

---

### US-006: Fix `koda agent me` crash on undefined apiKey

**Bug: #22**

#### Acceptance Criteria

1. When `AgentService.me()` returns an agent object where `apiKey` is `undefined`, `koda agent me` does not throw and exits with code 0
2. When `agentData.apiKey` is `undefined`, the output includes the line `API Key: (stored as hash — not recoverable)` instead of crashing
3. When `agentData.apiKey` is a non-empty string (e.g. test fixture `'abcd1234efgh5678'`), the output includes `API Key: abcd****5678` (masked)
4. The fix is in the `agent me` action handler in `apps/cli/src/commands/agent.ts` — add a null-guard before calling `maskApiKey(agentData.apiKey)`

#### Context Files

- `apps/cli/src/commands/agent.ts` — add null-guard before `maskApiKey` call in the `me` subcommand
- `apps/cli/src/commands/agent.spec.ts` — add unit tests for both defined and undefined `apiKey` cases

## Implementation Order

```
US-005 (ticket list ref fix)  → independent
US-006 (agent me crash fix)   → independent
```

Both are independent and simple. Run sequentially per preference.
