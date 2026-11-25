# Web workflow evidence for findings 10–14

The fixture runs against `7e23427915d4e98df0eb9a4fc9750ad4a05c0f43`. From the repository root with Bun and workspace dependencies installed, run

```sh
bun --tsconfig-override docs/review-evidence/20261125/web.tsconfig.json docs/review-evidence/20261125/web.ts
```

The script exits nonzero if an observation differs. It mounts production Vue pages with the repository's test renderer and uses real web composables and ofetch with in-memory responses. It replaces unrelated child components, supplies valid ticket form input, and uses a simulated browser EventSource. The approval filter, event bus, live stream and permission resolver execute production API code with in-memory dependencies. There is no browser, HTTP server, database or runner in this fixture.

| Finding | Observed | Control or scope |
| --- | --- | --- |
| **10 · P2** | The production approval filter serializes a pending request as HTTP 202. Ticket creation emits both the created and close events and shows its success toast. Fleet cancellation shows its success toast and throws a render `TypeError` after reading the missing `profiles.length`. Thread send returns failure with a `TypeError` and removes the optimistic echo. | Executed ticket 201 produces the expected success UI. Executed cancel 200 retains the displayed job and shows the cancellation marker. Executed thread send 201 replaces its optimistic echo. The knowledge reindex response shape `{ queued: true }` also passes through on 202, so the status alone cannot distinguish these outcomes. The fixture exercises the response contract after policy evaluation. |
| **11 · P2** | Project and workspace mounts both remain visibly streaming with the composer disabled after the first ready frame. A completion published between the initial GET and subscription causes zero catch-up GETs. | A nonterminal stream interruption followed by reconnect triggers two GETs and restores the final transcript and enabled composer in both scopes. The fixture exercises initial subscription timing and the existing reconnect path. |
| **12 · P2** | For initial 403, 404 and 503 detail responses, the project page renders zero visible characters and zero retry buttons. | A workspace 503 renders retry, and retry renders the thread when the simulated API is available. A later project event may recover a transient failure. |
| **13 · P2** | With 101 threads in each project status, the mounted table renders 100 active and 100 archived rows on their respective views. Both requests are for page one and the only buttons switch status. | The workspace list's existing load-more button requests page two and renders row 101 against the same pagination fixture. The fixture models the API's page and size contract without starting the API. |
| **14 · P2** | The production permission service grants a project-wide send key for a thread owned by another user. The mounted project composer still displays read-only. | An own-only grant permits own-thread sends and denies another author's thread, with the expected composer state in both cases. The inverse UI mismatch also appears for an owner whose role has no send key. The API permission decision is exercised before the route's session rules. |
