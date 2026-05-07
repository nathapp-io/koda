---
paths:
  - "apps/api/*"
appliesTo:
  - "**/vcs/**"
  - "**/*webhook*"
priority: 80
---

# API Webhooks — apps/api

## Catch Block Integrity
- A `catch` block guarding a deduplication or idempotency pre-check must return a non-2xx response — never fall through to the main enqueue/process path
- If the DB dedup check throws, reject the webhook so the provider retries; continuing after a failed pre-check creates duplicates

## Optional Header Exhaustiveness
- When detecting event type from an optional header (e.g. `x-github-event`), explicitly handle all absent-header cases
- Do not rely on `undefined → 'unknown' → silently ignored`; a valid event delivered without the header must not be silently dropped
