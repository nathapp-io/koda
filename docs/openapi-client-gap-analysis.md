# OpenAPI Client Gap Analysis

Generated on: 2026-04-08
Source of truth: `openapi.json` (63 operations)

## Summary

- CLI missing operations: 1
- Web missing operations: 18

## CLI Missing Operations

### Projects

- None (all applicable operations implemented)

### System / Infra

- `GET /health`

## Web Missing Operations

### Auth

- `POST /auth/refresh`

### Projects

- `GET /projects/{slug}`
- `PATCH /projects/{slug}`
- `DELETE /projects/{slug}`

### Comments

- `DELETE /comments/{id}`

### Labels

- `PATCH /projects/{slug}/labels/{id}`

### Tickets

- `DELETE /projects/{slug}/tickets/{ref}`
- `POST /projects/{slug}/tickets/{ref}/assign`
- `POST /projects/{slug}/tickets/{ref}/close`

### Ticket Labels

- `POST /projects/{slug}/tickets/{ref}/labels`
- `DELETE /projects/{slug}/tickets/{ref}/labels/{labelId}`

### Ticket Links

- `GET /projects/{slug}/tickets/{ref}/links`
- `POST /projects/{slug}/tickets/{ref}/links`
- `DELETE /projects/{slug}/tickets/{ref}/links/{linkId}`

### KB

- `DELETE /projects/{slug}/kb/documents/{sourceId}`
- `POST /projects/{slug}/kb/optimize`

### VCS

- `POST /projects/{slug}/vcs/sync-pr`
- `POST /projects/{slug}/vcs-webhook`
