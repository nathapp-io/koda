# SPEC: Permissions P3e-8 — Redeemable Approvals for the Remaining Secret-Bearing Routes, and the End of the Gate Rollout

## Summary

This feature finishes the `gate-secret` rollout. It gates the 8 secret-bearing REST routes still on `PENDING_GATE_ROUTES` with the redeem mode 6a shipped. It also moves the `PATCH /projects/:slug` CI-token change, which bypasses approval today, onto a redeem command. Then it deletes the rollout allowlist:

| Route | Secret in | Secret out |
|:--|:--|:--|
| `POST /fleet/enrollments` | none | the enrollment `token` |
| `POST /projects/:slug/vcs` | `token` | `webhookSecret` |
| `PATCH /projects/:slug/vcs` | optional `token` | `webhookSecret` when the update generated one |
| `POST /projects/:slug/vcs/webhook-secret/rotate` | none | `webhookSecret` |
| `POST /projects/:slug/webhooks` | optional `secret` | the webhook's `secret` |
| `PATCH /projects/:slug/webhooks/:id` | optional `secret` | none |
| `POST /projects/:slug/invites` | none | `invitePath` (the raw invite token) |
| `POST /projects/:slug/invites/:id/resend` | none | `invitePath` |
| `PATCH /projects/:slug` with `ciWebhookToken` | `ciWebhookToken` | none |

Each command stores and hashes a redacted input, answers the raw result to the redeeming caller, and stores a `toResult` projection without the secret. As in 6a, a human caller always executes at once. An agent waits only where a policy, or the catalog default, asks it to.

The `vcs.connection.*`, `vcs.webhook-secret.*`, `webhook.*` and `fleet.enrollment.*` keys are `high` risk, catalog default `agent`. So after this feature an agent calling the first six routes answers 202 and waits even with no policy configured. The invite keys and `project.update` are `medium`, default `none`.

After this feature the contract counts 126 gated routes (118 + 8). `PENDING_GATE_ROUTES`, `SECRET_GATE_ROUTES`, `expectedPendingGateRoutes` and the `stale-pending-gate-route` violation are deleted. Every approvable write route must be gated, with no exemption list.

This is feature 6b of P3 in `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` (§4 "Approval engine"). Feature 6a (`permissions-p3-approval-gate-secret-core`, PR #352) shipped the engine mode and three pilots.

## Motivation

These 8 routes take or return a secret, so 5b to 5d-2 left them ungated, and 6a built redeem for them. The CI-token change was kept out of approvals by a stop-gap in `ProjectsController.update`:
- a token-only patch skips the gate;
- a mixed patch (token plus ordinary fields) answers 400 `approvals.invalidInput`.

So an agent can change the token under any policy, and nobody can change the token and another setting in one call.

**Rulings that bind this feature** (user, 2026-10-29 and 2026-10-30):
- The mechanism is redeem (6a); `gate-secret` is two features, and this is 6b. The `PATCH /projects/:slug` CI-token bypass is folded in: it goes through the redeem path, and mixed patches are then allowed.
- The story list (7 stories) below.
- Designer calls accepted with the story list:
  - a present optional secret is stored as the literal `'<redacted>'`, not dropped;
  - VCS update and webhook-secret rotate pin the connection id read before the gate;
  - the webhook URL DNS check moves to `prepare`;
  - the VCS polling refresh moves after commit;
  - the allowlist machinery is deleted, not left empty.
- The invite email is sent inside the redeem transaction, as today's code does inline, so `emailed` stays accurate. The rare case is accepted: the settle step rolls back after the email went out, which leaves a sent email with a dead link.
- High-risk keys keep their catalog default `agent`: agents wait on the VCS, webhook and enrollment routes by default.

## Design

### Designer's calls (not ruled by the user; change them in review if wrong)

- **One redaction helper.** `redactSecret(value)` (new, `approvals/route/redact-secret.ts`) answers `REDACTED_SECRET` (`'<redacted>'`) for a string and the value itself otherwise (`undefined`, `null`). Every redact in this feature maps its secret fields through it. A redeem then matches the approved call field for field:
  - an approval of "change `syncMode`" stores no `token` key, so a redemption that adds a `token` hashes differently and answers 409 `approvals.redeemMismatch`;
  - an approval of "set a token" stores `token: '<redacted>'`, so the redemption may carry any token value, as 6a's password does.
- **`ciWebhookToken: null` (clearing the token) is not a secret.** `redactSecret(null)` is `null`, so a clear is stored as-is. It still takes the redeem variant, as any patch carrying the field does, so one route has one variant per shape.
- **The project PATCH keeps two variants.** A patch without `ciWebhookToken` keeps `rest:projects.update` (unchanged, a normal deferred command, and its `parse` still refuses `ciWebhookToken` as defence in depth). A patch with it uses the new `rest:projects.update-ci-token` redeem command under the same key `project.update`. The controller picks the variant and passes the header only to the redeem variant. The mixed-patch 400 and the token-only bypass are deleted.
- **VCS update and rotate pin the connection.** The handler reads `vcsService.findByProject(project.id)` before the gate (404 `vcs` as today when none), and the input carries `connectionId`. `VcsConnectionService.update` and `rotateWebhookSecret` gain an optional last parameter `connectionId`: when given and the project's current connection has another id, or none, they throw `NotFoundAppException({}, 'vcs')`. So a connection deleted and recreated between approval and redemption is not changed. The redeeming call re-reads the connection before the gate, so its `connectionId` is the new one and the hash differs: 409 `approvals.redeemMismatch`, and the request stays `approved`. A connection deleted and not recreated answers 404 `vcs` from the handler's read, before the gate. The service-level 404 covers only a swap between that read and the execution (unit-tested).
- **VCS create and update refresh polling after commit.** Both await `this.vcsPollingService.refreshConnectionSchedule(id)` inline today. Inside a redeem execution that call would run before the commit and read the row through another connection. Both call a private `refreshAfterCommit(id)` instead:
  - it defers the refresh with `AfterCommitService.defer` (as 6a's `AgentsService.invalidateAfterCommit` does);
  - when `defer` answers false (no scope open: the immediate path), it awaits the refresh at once, as today;
  - the deferred task catches a refresh error and logs it as a warning through a class logger (`private readonly logger = new Logger(VcsConnectionService.name)`, per `.nax/rules/api-logging.md`), so a failed schedule refresh after commit never turns a redemption that already executed into a 500 that loses the one-time `webhookSecret`. The immediate path keeps today's propagation.

  `committedEffect` is not used: it takes a synchronous effect and would drop the awaited refresh. `VcsConnectionService`'s constructor gains `AfterCommitService` (last), resolved from the global `PermissionsModule`.
- **The encryption key stays a route precondition.** The VCS create and update handlers keep refusing a missing `vcsConfig.encryptionKey` (400 `vcs`) before the gate. The update handler's order is `findBySlug` → key check → `findByProject` → gate, so a missing key answers 400 before a missing connection answers 404. The commands read `this.vcsConfig.encryptionKey` when they run, and throw the same 400 when it is missing then.
- **Webhook writes check the URL in `prepare`.** `WebhookService.prepareCreate(projectId, dto)` and `prepareUpdate(projectId, id, dto)` (new) run the owner check (update) and `assertUrlAllowed` (which resolves DNS), and answer a callback that writes. `create` and `update` become `(await this.prepareX(...))()`. The commands use `prepare`, so DNS resolution never runs inside the execution transaction. The callback of `prepareUpdate` re-reads the webhook and refuses a missing or foreign one (404 `webhooks`), so a webhook deleted after `prepare` is not resurrected.
- **The `accept-language` header documentation is left alone.** The invite handlers' `@Headers('accept-language')` already makes `openapi.json` list a required `accept-language` header. US-007 AC-4 counts only `X-Koda-Approval-Request` parameters, so that pre-existing entry does not fail it.
- **The invite locale is not hashed.** The invite create and resend inputs carry `locale` (from `Accept-Language`, `inviteLocale` as today). Their `redact` drops `locale`, so a redemption from a client with another language still matches, and executes with the re-sent locale.
- **The enrollment actor stays as today.** `EnrollmentService.create(actorId, labels)` records its activity row with `actorType: 'USER'` even for an agent. Fixing that is out of scope.
- **Each route story removes its own rows** from `PENDING_GATE_ROUTES` and `SECRET_GATE_ROUTES`, and sets the exact counts to its own state. US-007 deletes both.

### The gated routes

| Story | Route | Key | Scope | Variant | Input | `redact` | Run | `toResult` |
|:--|:--|:--|:--|:--|:--|:--|:--|:--|
| US-001 | `POST /fleet/enrollments` | `fleet.enrollment.create` | null | `rest:fleet-enrollments.create` | `{ labels }` (`parseBody(CreateEnrollmentDto, …)`, `labels ?? []`) | none (stored whole) | `enrollments.create(principal.id, input.labels)` | `({ token, ...rest }) => rest` |
| US-002 | `POST /projects/:slug/vcs` | `vcs.connection.create` | project | `rest:vcs.create` | `{ slug, projectId, connection: parseBody(CreateVcsConnectionDto, …) }` | `connection.token` → `redactSecret` | `vcs.create(projectId, key, connection)` | `({ webhookSecret, ...rest }) => rest` |
| US-003 | `PATCH /projects/:slug/vcs` | `vcs.connection.update` | project | `rest:vcs.update` | `{ slug, projectId, connectionId, patch: parseBody(UpdateVcsConnectionDto, …) }` | `patch.token` → `redactSecret` (absent stays absent) | `vcs.update(projectId, key, patch, connectionId)` | `({ webhookSecret, ...rest }) => rest` |
| US-003 | `POST /projects/:slug/vcs/webhook-secret/rotate` | `vcs.webhook-secret.rotate` | project | `rest:vcs.rotate-webhook-secret` | `{ slug, projectId, connectionId }` | none | `vcs.rotateWebhookSecret(projectId, connectionId)` | `() => ({ rotated: true })` |
| US-004 | `POST /projects/:slug/webhooks` | `webhook.create` | project | `rest:project-webhooks.create` | `{ slug, projectId, webhook: parseBody(CreateWebhookDto, …) }` | `webhook.secret` → `redactSecret` (absent stays absent) | `prepare`: `webhooks.prepareCreate(projectId, webhook)`; run: `webhooks.create(projectId, webhook)` | `({ secret, ...rest }) => rest` |
| US-004 | `PATCH /projects/:slug/webhooks/:id` | `webhook.update` | project | `rest:project-webhooks.update` | `{ slug, projectId, id, patch: parseBody(UpdateWebhookDto, …) }` | `patch.secret` → `redactSecret` (absent stays absent) | `prepare`: `webhooks.prepareUpdate(projectId, id, patch)`; run: `webhooks.update(projectId, id, patch)` | `(result) => result` |
| US-005 | `POST /projects/:slug/invites` | `invite.create` | project | `rest:project-invites.create` | `{ slug, projectId, invite: parseBody(CreateInviteDto, …), locale }` | drops `locale` | `invites.create(slug, invite, principal, locale)` | `({ invitePath, ...rest }) => rest` |
| US-005 | `POST /projects/:slug/invites/:id/resend` | `invite.resend` | project | `rest:project-invites.resend` | `{ slug, projectId, id, locale }` | drops `locale` | `invites.resend(slug, id, principal, locale)` | `({ invitePath, ...rest }) => rest` |
| US-006 | `PATCH /projects/:slug` (with `ciWebhookToken`) | `project.update` | project | `rest:projects.update-ci-token` | `{ slug, patch: parseBody(UpdateProjectDto, …) }` | `patch.ciWebhookToken` → `redactSecret` | `projects.update(slug, patch)` | `(result) => result` |

`key` in the VCS rows is `this.vcsConfig.encryptionKey`, read when the command runs. Each handler keeps its `@Requires`, `@HttpCode` and `@ApiResponse`s. It gains `@ApprovalGated({ redeem: true })` and an `@ApprovalRedeemHeader() redeem?: string` parameter (last; `approvals/route/approval-redeem-header.decorator.ts`, as 6a's handlers use: `@Headers(APPROVAL_REDEEM_HEADER)` would make swagger document a second, required header). It has 6a's shape:

```ts
const outcome = await this.routeGate.run<EnrollmentCreatedDto>({
  key: 'fleet.enrollment.create', variant: ENROLLMENT_ROUTE_VARIANTS.create, projectId: null,
  input: { labels: dto.labels ?? [] }, redeem,
});
if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
return JsonResponse.Ok(outcome.result);
```

The project PATCH handler (US-006):

```ts
const { slug: parsedSlug } = parseRouteInput({ slug }, ['slug']);
const patch = parseBody(UpdateProjectDto, updateProjectDto ?? {});
const secret = patch.ciWebhookToken !== undefined;
const outcome = await this.routeGate.run<ProjectResponseDto>({
  key: 'project.update',
  variant: secret ? PROJECT_ROUTE_VARIANTS.updateCiToken : PROJECT_ROUTE_VARIANTS.update,
  projectId: project.project.id,
  input: { slug: parsedSlug, patch },
  ...(secret ? { redeem } : {}),
});
```

Handler signatures (the `@ApprovalRedeemHeader()` parameter is always last; existing calls in specs that omit it stay valid; a `principal` parameter the handler no longer reads is removed, not kept unused):
- `EnrollmentsController.create(dto, redeem?)` (the command loads the principal itself);
- `VcsController.createConnection(slug, dto, redeem?)` and `updateConnection(slug, dto, redeem?)` keep resolving the project with `projectsService.findBySlug(slug)`; `rotateWebhookSecret(ctx, redeem?)`;
- `WebhookController.register(slug, dto, redeem?)` and `update(slug, id, dto, redeem?)` keep `webhookService.getProjectBySlug(slug)`;
- `ProjectInvitesController.create(slug, dto, ctx, acceptLanguage?, redeem?)` and `resend(slug, id, ctx, acceptLanguage?, redeem?)` drop `principal` (the command loads it) and gain `@CurrentProject() ctx` (the class-level `ProjectMembershipGuard` sets it, as `cancel` uses). `@Headers('accept-language')` stays: it is documented today as a required header, and this feature does not change that;
- `ProjectsController.update(slug, dto, project, redeem?)`.

A header sent on a patch without `ciWebhookToken` is ignored. The patch then takes the ordinary variant, as any non-redeem gated route ignores the header.

The VCS rotate route has no body. Its stored input is `{ slug, projectId, connectionId }`, so a redemption matches when the connection is still the one read before the gate.

### Shared names

| Name | Where | What |
|:--|:--|:--|
| `ENROLLMENT_ROUTE_VARIANTS.create` | `fleet/runners/runner-route.commands.ts` | new, registered by `RunnerRouteCommands` (US-001) |
| `REDACTED_SECRET`, `redactSecret` | `approvals/route/redact-secret.ts` | new (US-002) |
| `VCS_ROUTE_VARIANTS.create`, `.update`, `.rotateWebhookSecret` | `vcs/vcs-route.commands.ts` | new (US-002, US-003) |
| `VcsConnectionService` constructor gains `AfterCommitService`; private `refreshAfterCommit` | `vcs/vcs-connection.service.ts` | new (US-002) |
| `VcsConnectionService.update(…, connectionId?)`, `.rotateWebhookSecret(projectId, connectionId?)` | `vcs/vcs-connection.service.ts` | new optional parameter (US-003) |
| `WEBHOOK_ROUTE_VARIANTS.create`, `.update`; `WebhookService.prepareCreate`, `.prepareUpdate` | `webhook/webhook-route.commands.ts`, `webhook/webhook.service.ts` | new (US-004) |
| `INVITE_ROUTE_VARIANTS.create`, `.resend` | `projects/invites/invite-route.commands.ts` | new (US-005) |
| `PROJECT_ROUTE_VARIANTS.updateCiToken` | `projects/project-route.commands.ts` | new (US-006) |

### Failure Handling

| Situation | Behaviour | Story |
|:--|:--|:--|
| An agent under no policy, on a `high` key (default `agent`) | 202, a pending redeem request | US-001, US-002, US-003, US-004 |
| An agent under no policy, on an invite key or `project.update` (default `none`) | Executes at once, no request | US-005, US-006 |
| A human caller under a policy | Executes at once, no request | US-006 |
| An approved enrollment redeemed | 201 with the raw `token`; the stored result has no `token` | US-001 |
| A VCS create redeemed with another token value | Executes with the re-sent token | US-002 |
| A VCS update approved without a token, redeemed with one | 409 `approvals.redeemMismatch`; nothing changes | US-003 |
| A VCS update or rotate redeemed after the connection was deleted and recreated | 409 `approvals.redeemMismatch`; the request stays `approved`; the new connection is unchanged | US-003 |
| A missing encryption key at redemption | 400 `vcs` from the handler, before the gate; the request stays `approved` | US-002 |
| A webhook URL that resolves to a blocked address at redemption | 400 `webhooks` from `prepare`; the request settles `failed`; nothing is written | US-004 |
| A webhook deleted between approval and redemption | 404 `webhooks`; the request settles `failed` | US-004 |
| An invite redeemed with another `Accept-Language` | Executes; the email uses the re-sent locale | US-005 |
| An invite resend redeemed after the invite was cancelled | 409 `invites.final`; the request settles `failed` | US-005 |
| A project patch with `ciWebhookToken` and ordinary fields | Accepted (no 400); one redeem request covers both | US-006 |
| A project patch without `ciWebhookToken` | The ordinary `rest:projects.update` variant, as today | US-006 |
| A new ungated approvable write route after this feature | `ungated-approvable-write`, with no exemption list | US-007 |

### Integration

**Read-only, verified:**
- 6a's engine: `ApprovalRouteGate.run` (the redeem branch), `ApprovalExecutionService.redeem`, `ApprovalGated({ redeem: true })`, `APPROVAL_REDEEM_HEADER`, `routeCommand` with `redeem`, `prepare` and `toResult`; `parseBody`, `parseRouteInput`.
- `EnrollmentService.create`; `VcsConnectionService.create`, `update`, `rotateWebhookSecret`, `findByProject`, `delete` (its `committedEffect`); `WebhookService.create`, `update`, `assertUrlAllowed`, `toView`; `ProjectInvitesService.create`, `resend` (each sends its email inline when `EmailAvailability.configured`); `ProjectsService.update`.
- `AfterCommitService.scope` / `.defer` (`permissions/after-commit.service.ts`); `AgentsService.invalidateAfterCommit` (the pattern); `GlobalStubsModule` already provides `AfterCommitService` to module specs.
- Test helpers: `seedWaitPolicy`, `grantKeys`; `seedFleetHttpWorld`, `seedFleetHttpAgent`; `bootHttpApp`, `data`, `resetThrottle`; `fixtureDb`; `resetDb`; the structure of `test/integration/webhook/gated-webhook-vcs-routes.integration.spec.ts` (it stubs `VCS_ENCRYPTION_KEY`) and `test/integration/agents/gated-agent-key-routes.integration.spec.ts`.

**Changed** (the baseline only locates the code; implement the target):

| Symbol | Baseline | Target |
|:--|:--|:--|
| `EnrollmentsController.create` | calls the service | runs the route gate; the constructor gains `ApprovalRouteGate` (last) |
| `VcsController.createConnection`, `.updateConnection`, `.rotateWebhookSecret` | call the service | run the route gate |
| `VcsConnectionService` constructor; `.create`, `.update` | 4 parameters; refresh polling inline | `AfterCommitService` last; refresh polling through `refreshAfterCommit` |
| `VcsConnectionService.update`, `.rotateWebhookSecret` | find the connection by project | also refuse a `connectionId` that is not the current one (404 `vcs`) |
| `WebhookController.register`, `.update` | call the service | run the route gate |
| `WebhookService.create`, `.update` | check the URL, then write | `(await this.prepareX(...))()` |
| `ProjectInvitesController.create`, `.resend` | call the service | run the route gate |
| `ProjectsController.update` | token-only patch bypasses the gate; mixed patch 400 | every patch runs the gate; a patch with `ciWebhookToken` uses the redeem variant |
| `PENDING_GATE_ROUTES`, `SECRET_GATE_ROUTES` | 8 rows each | shrink per story; deleted in US-007 |
| `findContractViolations` | 4th parameter `pendingGateRoutes`; reports `stale-pending-gate-route` | 3 parameters; every ungated approvable write is a violation |

## Out of Scope

- Changing any catalog default or risk: the high-risk keys keep default `agent` (ruling 2026-10-30).
- Treating a webhook `url` as a secret: it is stored whole in `ApprovalRequest.input` (a URL is already readable through `GET …/webhooks`), and the URL guard runs only in `prepare`, so a pending request may hold a URL the guard would refuse.
- Fixing `EnrollmentService.create`'s hard-coded activity `actorType: 'USER'` for an agent caller.
- Moving the invite email after commit (ruling 2026-10-30: it stays inside the transaction).
- Cancelling an approved, unredeemed request (6a ruling).
- Validating the header's format; a second key re-check inside the redemption (6a).
- MCP, assistant or fleet commands for these keys: only the REST routes open or redeem these requests.
- The read routes `GET /projects/:slug/ci-webhook-token`, `GET /projects/:slug/vcs`, `GET /fleet/enrollments`, `GET …/webhooks`, `GET …/invites`.
- The cross-project admin route `DELETE /webhooks/:id` and the project webhook delete: gated in 5c-2.
- The public invite routes (`/invites/:token` preview and accept): they are not approvable.
- Regenerating `apps/cli/src/generated`: only `openapi.json` is regenerated.
- Any change to `apps/web`, `apps/cli` or `apps/runner`.
- `endpoint.e2e.spec.ts` coverage for these routes: the integration files below cover them over the booted app.
- An SMTP-backed invite email check: integration tests run with email unconfigured (`emailed: false`), as the existing invite integration tests do.

## Stories

1. **US-001: Gated runner enrollment create, redeemed with the token** — `Workdir: apps/api` — No dependencies.
2. **US-002: Gated VCS connection create with the token redacted** — `Workdir: apps/api` — Depends on US-001.
3. **US-003: Gated VCS connection update and webhook-secret rotation, pinned to the connection** — `Workdir: apps/api` — Depends on US-002.
4. **US-004: Gated webhook create and update, with the URL check in prepare** — `Workdir: apps/api` — Depends on US-003.
5. **US-005: Gated invite create and resend, with the invite link redacted** — `Workdir: apps/api` — Depends on US-004.
6. **US-006: The CI-token project patch through the redeem path** — `Workdir: apps/api` — Depends on US-005.
7. **US-007: Delete the rollout allowlist; the contract counts 126** — `Workdir: apps/api` — Depends on US-006.

The stories are chained because each sets the exact allowlist and gated-route counts in the same two contract spec files.

### Context Files

**US-001**
- `apps/api/src/fleet/runners/enrollments.controller.ts`
- `apps/api/src/fleet/runners/runner-route.commands.ts`
- `apps/api/src/fleet/runners/enrollment.service.ts`
- `apps/api/test/integration/agents/gated-agent-key-routes.integration.spec.ts`
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts`
- `apps/api/src/permissions/pending-gate-routes.ts`
- `apps/api/test/integration/permissions/permission-contract.integration.spec.ts`

**US-002**
- `apps/api/src/vcs/vcs.controller.ts`
- `apps/api/src/vcs/vcs-route.commands.ts`
- `apps/api/src/vcs/vcs-connection.service.ts`
- `apps/api/test/integration/webhook/gated-webhook-vcs-routes.integration.spec.ts`

**US-003**
- `apps/api/src/vcs/vcs.controller.ts`
- `apps/api/src/vcs/vcs-route.commands.ts`
- `apps/api/src/vcs/vcs-connection.service.ts`
- `apps/api/src/vcs/vcs.controller.spec.ts`

**US-004**
- `apps/api/src/webhook/webhook.controller.ts`
- `apps/api/src/webhook/webhook-route.commands.ts`
- `apps/api/src/webhook/webhook.service.ts`
- `apps/api/src/webhook/webhook-routes.spec.ts`

**US-005**
- `apps/api/src/projects/invites/project-invites.controller.ts`
- `apps/api/src/projects/invites/invite-route.commands.ts`
- `apps/api/src/projects/invites/project-invites.service.ts`
- `apps/api/test/integration/projects/gated-member-invite-routes.integration.spec.ts`

**US-006**
- `apps/api/src/projects/projects.controller.ts`
- `apps/api/src/projects/project-route.commands.ts`
- `apps/api/src/projects/projects.controller.spec.ts`
- `apps/api/test/integration/projects/gated-project-routes.integration.spec.ts`

**US-007**
- `apps/api/src/permissions/test-helpers/permission-contract.ts`
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts`
- `apps/api/test/integration/permissions/permission-contract.integration.spec.ts`
- `apps/api/src/approvals/approval-openapi.contract.spec.ts`

### Creates

**US-001**
- `apps/api/test/integration/fleet/gated-enrollment-create-route.integration.spec.ts`

**US-002**
- `apps/api/src/approvals/route/redact-secret.ts`
- `apps/api/src/approvals/route/redact-secret.spec.ts`
- `apps/api/test/integration/vcs/gated-vcs-secret-routes.integration.spec.ts`

**US-003**

None: US-003 adds its cases to the file US-002 created (see the note under Modifies).

**US-004**
- `apps/api/test/integration/webhook/gated-webhook-secret-routes.integration.spec.ts`

**US-005**
- `apps/api/test/integration/projects/gated-invite-secret-routes.integration.spec.ts`

**US-006**
- `apps/api/test/integration/projects/gated-project-ci-token-route.integration.spec.ts`

**US-007**

None: US-007 only changes and deletes existing files.

### Modifies

No existing integration or e2e test opens a request on these nine routes under a policy. Every existing caller of the enrollment, VCS create and update, webhook create and update, and invite routes is a user, and a user executes at once. The only existing agent callers of a `high` route are the two rotate cases US-003 lists, which now wait under the default `agent` mode.

US-003 adds its integration cases to `test/integration/vcs/gated-vcs-secret-routes.integration.spec.ts`, which US-002 creates. Spec lint refuses a Modifies entry for a file an earlier story of this feature creates, so the entry is only this note and US-003's Context Files.

**US-001**
- `apps/api/src/fleet/runners/enrollments.controller.ts` — `create` gated with `@ApprovalGated({ redeem: true })` and the header parameter; the constructor gains `ApprovalRouteGate` (last)
- `apps/api/src/fleet/runners/runner-route.commands.ts` — `ENROLLMENT_ROUTE_VARIANTS` and the enrollment redeem command; the constructor gains `EnrollmentService` (last)
- `apps/api/src/fleet/runners/runner-route.commands.spec.ts` — every construction passes an `EnrollmentService` double as the last argument; the enrollment registration and command cases
- `apps/api/src/permissions/pending-gate-routes.ts` — drops the POST /fleet/enrollments row from both `SECRET_GATE_ROUTES` and the assignments
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts` — the "US-001 AC-1: explicitly lists exactly the 8 secret-bearing routes" case lists the 7 left; the "US-007 AC-13: pending gate assignments hold exactly the 8 remaining secret routes" case asserts 7 (titles follow)
- `apps/api/test/integration/permissions/permission-contract.integration.spec.ts` — the "AC-12 (US-007): collects exactly 118 gated routes" case asserts 119 (title follows)

**US-002**
- `apps/api/src/vcs/vcs.controller.ts` — `createConnection` gated with `@ApprovalGated({ redeem: true })` and the header parameter; the encryption key check stays before the gate
- `apps/api/src/vcs/vcs-route.commands.ts` — `VCS_ROUTE_VARIANTS.create` and its redeem command
- `apps/api/src/vcs/vcs-route.commands.spec.ts` — the create registration and command cases
- `apps/api/src/vcs/vcs-connection.service.ts` — the constructor gains `AfterCommitService` (last); `refreshAfterCommit`; `create` uses it
- `apps/api/src/vcs/vcs-connection.service.spec.ts` — the testing module provides `AfterCommitService`; the deferred-refresh case; existing `refreshConnectionSchedule` assertions still hold (no scope is open there)
- `apps/api/test/integration/vcs/vcs-connection.service.spec.ts` — the testing module provides `AfterCommitService`
- `apps/api/src/vcs/vcs-connection.webhook-secret.spec.ts` — its `new VcsConnectionService(...)` passes `new AfterCommitService()` as the 5th argument
- `apps/api/src/vcs/vcs-connection.gitlab.spec.ts` — its `new VcsConnectionService(...)` passes `new AfterCommitService()` as the 5th argument
- `apps/api/src/approvals/approval-execution.service.spec.ts` — the `new VcsConnectionService(...)` in "real VCS deletion preserves polling on %s failure" passes `new AfterCommitService()` as the 5th argument
- `apps/api/src/vcs/vcs.controller.spec.ts` — the `ApprovalRouteGate` double's `run` answers `{ status: 'executed', result: await mockVcsService.create(call.input.projectId, encryptionKey, call.input.connection) }` for `rest:vcs.create`, so the `createConnection` cases still hold
- `apps/api/test/integration/vcs/vcs-controller.spec.ts` — the same double change for `rest:vcs.create`
- `apps/api/src/permissions/pending-gate-routes.ts` — drops the POST /projects/:slug/vcs row from both sets
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts` — the explicit-list and size cases assert 6 (titles follow)
- `apps/api/test/integration/permissions/permission-contract.integration.spec.ts` — the gated-route count is exactly 120

**US-003**
- `apps/api/src/vcs/vcs.controller.ts` — `updateConnection` and `rotateWebhookSecret` read the connection first and run the route gate with `@ApprovalGated({ redeem: true })` and the header parameter
- `apps/api/src/vcs/vcs-route.commands.ts` — `VCS_ROUTE_VARIANTS.update`, `.rotateWebhookSecret` and their redeem commands
- `apps/api/src/vcs/vcs-route.commands.spec.ts` — the update and rotate registration and command cases
- `apps/api/src/vcs/vcs-connection.service.ts` — `update` and `rotateWebhookSecret` take `connectionId?`; `update` refreshes polling through `refreshAfterCommit`
- `apps/api/src/vcs/vcs-connection.service.spec.ts` — the pinned-connection cases; existing assertions still hold (no `connectionId` passed)
- `apps/api/src/vcs/vcs.controller.spec.ts` — the gate double also dispatches `rest:vcs.update` to `mockVcsService.update(input.projectId, encryptionKey, input.patch)` and `rest:vcs.rotate-webhook-secret` to `mockVcsService.rotateWebhookSecret(input.projectId)` (exactly those arguments, no `connectionId`), so the existing `toHaveBeenCalledWith` assertions still hold; `findByProject` resolves a connection by default
- `apps/api/test/integration/vcs/vcs-controller.spec.ts` — the same double change for `rest:vcs.update` (`update(projectId, encryptionKey, patch)`); `findByProject` gets a resolved default (`{ id: 'conn-1' }`), and "returns 404 when no connection exists" makes `findByProject` reject with the 404 instead of `update`
- `apps/api/test/integration/vcs/vcs-webhook-secret.integration.spec.ts` — "AC-11: project-admin-bound agent rotates and persists the new secret" expects 202, approves with the root token and redeems; its secret assertions run on the redemption's 200 response. The 403 cases are unchanged (the guard refuses before the gate)
- `apps/api/test/integration/vcs/vcs-permissions.integration.spec.ts` — "AC-11: project-admin-bound agent rotates and persists the secret": the same change
- `apps/api/src/permissions/pending-gate-routes.ts` — drops the PATCH /projects/:slug/vcs and POST /projects/:slug/vcs/webhook-secret/rotate rows from both sets
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts` — the explicit-list and size cases assert 4 (titles follow)
- `apps/api/test/integration/permissions/permission-contract.integration.spec.ts` — the gated-route count is exactly 122

**US-004**
- `apps/api/src/webhook/webhook.controller.ts` — `register` and `update` gated with `@ApprovalGated({ redeem: true })` and the header parameter
- `apps/api/src/webhook/webhook-route.commands.ts` — `WEBHOOK_ROUTE_VARIANTS.create`, `.update` and their redeem commands
- `apps/api/src/webhook/webhook-route.commands.spec.ts` — the create and update registration and command cases
- `apps/api/src/webhook/webhook.service.ts` — `prepareCreate`, `prepareUpdate`; `create` and `update` run them
- `apps/api/src/webhook/webhook.service.spec.ts` — the prepare cases; existing `create` and `update` assertions still hold
- `apps/api/src/webhook/webhook-routes.spec.ts` — the `ApprovalRouteGate` double's factory also dispatches `rest:project-webhooks.create` to `service.create(ids.projectId, input.webhook)` and `rest:project-webhooks.update` to `service.update(ids.projectId, ids.id, input.patch)`, so its HTTP assertions still hold
- `apps/api/src/permissions/pending-gate-routes.ts` — drops the POST /projects/:slug/webhooks and PATCH /projects/:slug/webhooks/:id rows from both sets
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts` — the explicit-list and size cases assert 2 (titles follow)
- `apps/api/test/integration/permissions/permission-contract.integration.spec.ts` — the gated-route count is exactly 124

**US-005**
- `apps/api/src/projects/invites/project-invites.controller.ts` — `create` and `resend` run the route gate with `@ApprovalGated({ redeem: true })`, the header parameter and `@CurrentProject()` for the project id
- `apps/api/src/projects/invites/invite-route.commands.ts` — `INVITE_ROUTE_VARIANTS.create`, `.resend` and their redeem commands
- `apps/api/src/projects/invites/invite-route.commands.spec.ts` — the create and resend registration and command cases
- `apps/api/src/projects/invites/project-invites.controller.spec.ts` — the "create passes the accept-language locale through" case asserts the `gate.run` call (input `locale: 'zh'`) instead of `service.create`; a resend case does the same
- `apps/api/src/permissions/pending-gate-routes.ts` — drops the POST /projects/:slug/invites and POST /projects/:slug/invites/:id/resend rows; `SECRET_GATE_ROUTES` is `new Set()` and `PENDING_GATE_ROUTES` is `new Map()` (the string parser and `ROUTE_ASSIGNMENTS` are removed: `''.trim().split('\n')` is `['']`, which the parser rejects at import)
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts` — the explicit-list and size cases assert 0 (titles follow); the "US-001 AC-2: assigns invite resend to gate-secret" case is deleted (its row leaves)
- `apps/api/test/integration/permissions/permission-contract.integration.spec.ts` — the gated-route count is exactly 126

**US-006**
- `apps/api/src/projects/projects.controller.ts` — `update` drops the token bypass and the mixed-patch 400, picks the variant, takes the header parameter, and `@ApprovalGated({ redeem: true })`
- `apps/api/src/projects/project-route.commands.ts` — `PROJECT_ROUTE_VARIANTS.updateCiToken` and its redeem command; the `rest:projects.update` command is unchanged
- `apps/api/src/projects/project-route.commands.spec.ts` — the ci-token registration and command cases; the existing "refuses ciWebhookToken" case for `rest:projects.update` stays
- `apps/api/src/projects/projects.controller.spec.ts` — the "keeps token-only patches out of approvals" `it.each` and the "B3: rejects mixed secret and ordinary patches" `it.each` are replaced by the US-006 controller cases (AC-9, AC-10)

**US-007**
- `apps/api/src/permissions/pending-gate-routes.ts` — deleted
- `apps/api/src/permissions/test-helpers/permission-contract.ts` — drops the import, the `pendingGateRoutes` parameter, the exemption in the `ungated-approvable-write` check, the `stale-pending-gate-route` loop and kind, and `expectedPendingGateRoutes`
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts` — drops the `pending-gate-routes` import and `expectedPendingGateRoutes`; the local `findContractViolations` wrapper drops its 4th parameter, and the `isolated` helper drops its 4th `new Map()` argument. These cases are deleted (each reads `PENDING_GATE_ROUTES`, `SECRET_GATE_ROUTES` or `expectedPendingGateRoutes`, or passes a pending map), by exact title: "AC-2: a pending gate route exempts an ungated approvable write"; "AC-4: reports a pending gate route that is gated"; "AC-5: reports a pending gate route absent from declarations"; "AC-9: rollout gate map excludes all routes already gated in this feature"; the explicit-list case (titled "US-001 AC-1: explicitly lists exactly the 0 secret-bearing routes" after US-005); "US-001 AC-1/2: assigns every explicit secret route to gate-secret"; "US-006: the agent credential routes are gated, so they leave the pending rollout lists"; "US-007: the gated admin user create leaves the pending rollout lists"; both `it.each` blocks "US-001 AC-6: removes non-approvable read route %s from pending gates" and "US-001 AC-5: removes non-approvable test-hook route %s from pending gates"; "US-007: removes gated workspace thread actions from pending rollout routes"; the size case (titled "US-007 AC-13: pending gate assignments hold exactly the 0 remaining secret routes" after US-005); "AC-4: classifies an unexpected core-domain write and reports it ungated"; "AC-1 (US-010): has no gate-high pending assignments"; "US-008 AC-8: gated project create and update are not pending rollout routes"; "AC-10: has no pending entry for gated project deletion"; "US-009: member addition and invite cancellation are no longer pending"; the `it.each` "gated project thread write %s is no longer pending". These stay unchanged: AC-1, AC-3, AC-6, AC-7, "AC-8: approval.decide is no longer pending" and "AC-14: audit.read is no longer pending" (both read `PENDING_SURFACE_KEYS`), and every case from "defines exactly the pending surface keys and each exists in the catalog" on
- `apps/api/test/integration/permissions/permission-contract.integration.spec.ts` — drops both imports; the "US-010: pending gate map matches every remaining approvable write route and rollout rule" and "AC-12 (US-010): rollout expectations reject a new high-risk route after closure" cases are deleted; "FM-1 (US-011): catches an unlisted ungated approvable write" stays
- `apps/api/src/approvals/approval-openapi.contract.spec.ts` — `gatedOperations` gains the 8 operations; the `describe('OpenAPI contract for 118 gated operations')` title and the "AC-15 (US-007): 202 responses exist on exactly the 118 gated operations" case become 126; "AC-7 (US-010): POST /api/fleet/enrollments remains ungated" and "AC-5: POST /api/projects/{slug}/invites has no 202 response" are deleted (US-007 AC-4 replaces them)
- `openapi.json` — regenerated: the 9 redeem operations list 202 (8 new) and the header parameter

### Seams

- 6a → US-001 to US-006: `ApprovalRouteGate.run({ redeem })`, `ApprovalGated({ redeem: true })`, `APPROVAL_REDEEM_HEADER`, `routeCommand({ redeem })`, the approve and sweeper behaviour of a redeem request.
- US-002 → US-003 to US-006: `redactSecret`. US-003 AC-3, US-004 AC-3 and US-006 AC-2 read the stored marker.
- US-001 to US-005 → US-007: each removes its rows; US-005 leaves both sets empty, and US-007 deletes them.
- US-006 → US-007: `PATCH /projects/:slug` is already gated and counted, so the count stays 126; US-007 AC-4 reads its header parameter in the regenerated `openapi.json`.

## Acceptance Criteria

Integration tests run with `bun run test:db:up` in `apps/api` first. HTTP fixtures follow `test/integration/webhook/gated-webhook-vcs-routes.integration.spec.ts`:
- `seedFleetHttpWorld` gives the Owner (`root`) token; `seedFleetHttpAgent` gives an agent and its API key.
- Each agent holds only the `grantKeys` bindings its story names (project-scoped on the test project, global for US-001), followed by `PermissionCache.invalidate()`. Project-scoped stories also grant `project.read`.
- The VCS stories stub `VCS_ENCRYPTION_KEY` with `vi.stubEnv` before booting.

"Under a wait policy" means `seedWaitPolicy(db, <the route's key>, <scope>)` ran in that test. "Under no policy" means none did. Each file deletes every `ApprovalPolicy`, `ApprovalDecision` and `ApprovalRequest` row in `beforeEach`, and calls `resetThrottle(app)` there. "Approving" means `POST /api/approvals/:id/decisions` `{ decision: 'approve' }` with the root token. "Answers 202" means status 202 with `data` the pending request summary. "Redeeming R" means repeating the call that opened R with the header `X-Koda-Approval-Request: <R's id>`.

"Answers 409 with key `approvals.X`" uses the file-local `message(<unprefixed key>, <status>)` helper over `src/i18n/en/approvals.json`, as `gated-agent-key-routes.integration.spec.ts` does. Each AC is its own test with its own rows, per `.nax/rules/api-test-isolation.md`. "Approving AC-n's request" means the test repeats AC-n's call and approves the request it opened. A tail such as "and writes no `ApprovalRequest` row" is part of the behaviour it follows (sizing ruling 2026-10-26). Every prototype stub and spy is restored in `afterEach` (`vi.restoreAllMocks()`), and an env stub is undone in `afterAll` (`vi.unstubAllEnvs()`).

### US-001: Gated runner enrollment create, redeemed with the token

The requesting agent holds global `fleet.enrollment.create`. A create body is `{ labels: ['gpu'] }`.

- AC-1 [integration] `POST /api/fleet/enrollments` with a create body by the agent under no policy answers 202 with `data` matching `{ permissionKey: 'fleet.enrollment.create', projectId: null, redeem: true }`, and no `RunnerEnrollment` row exists.
- AC-2 [integration] Approving AC-1's request and redeeming it answers 201 with `data.token` a string starting with `ke_` and `data.labels` `['gpu']`, and exactly one `RunnerEnrollment` row exists.
- AC-3 [integration] After AC-2, the request row has status `executed`, its `input` is `{ labels: ['gpu'] }`, and its `result` has `labels` `['gpu']` and no `token` property.
- AC-4 [integration] Redeeming an approved enrollment request with the body `{ labels: ['cpu'] }` answers 409 with key `approvals.redeemMismatch`, and no `RunnerEnrollment` row exists.
- AC-5 [integration] `POST /api/fleet/enrollments` with the root token answers 201 with a `data.token`, and writes no `ApprovalRequest` row.
- AC-6 [unit] After `onModuleInit`, the registry answers `fleet.enrollment.create` for `rest:fleet-enrollments.create`, with a `redeem` and no `redeem.redact`.
- AC-7 [unit] That command's `toResult` of `{ id: 'e1', labels: [], token: 'ke_x', expiresAt: 'x', usedAt: null, runnerId: null, createdById: 'u1', createdAt: 'x' }` answers the same object without `token`.
- AC-8 [unit] `EnrollmentsController.create({ labels: ['gpu'] }, 'r1')` calls `routeGate.run` with `{ key: 'fleet.enrollment.create', variant: 'rest:fleet-enrollments.create', projectId: null, input: { labels: ['gpu'] }, redeem: 'r1' }`.
- AC-9 [unit] `PENDING_GATE_ROUTES` holds exactly 7 entries and does not contain `POST /fleet/enrollments`.

### US-002: Gated VCS connection create with the token redacted

The requesting agent holds `vcs.connection.create` on the test project. A create body is `{ provider: 'github', repoOwner: 'acme', repoName: <unique>, token: 'tok-1', syncMode: 'off' }`. Each test deletes the project's `VcsConnection` in `beforeEach`.

- AC-1 [unit] `redactSecret('s')` answers `'<redacted>'`, `redactSecret('')` answers `'<redacted>'`, `redactSecret(null)` answers `null`, and `redactSecret(undefined)` answers `undefined`; `REDACTED_SECRET` is `'<redacted>'`.
- AC-2 [integration] `POST /api/projects/<slug>/vcs` with a create body by the agent under no policy answers 202 with `data` matching `{ permissionKey: 'vcs.connection.create', redeem: true }`, and the project has no `VcsConnection`.
- AC-3 [integration] `GET /api/approvals/<AC-2's request>` with the root token answers `data.input.connection.token` `'<redacted>'`, and the string `tok-1` appears nowhere in `data.input`.
- AC-4 [integration] Approving AC-2's request and redeeming it answers 201 with `data.webhookSecret` a non-empty string and `data.repoName` the body's; the request row's `result` has no `webhookSecret` property.
- AC-5 [integration] Redeeming an approved create request with `token: 'tok-2'` answers 201, and the stored `encryptedToken` decrypts (`decryptToken`, the stubbed key) to `tok-2`.
- AC-6 [integration] Redeeming an approved create request with another `repoName` answers 409 with key `approvals.redeemMismatch`, and the project has no `VcsConnection`.
- AC-7 [integration] `POST /api/projects/<slug>/vcs` with the root token answers 201 with a `data.webhookSecret`, and writes no `ApprovalRequest` row.
- AC-8 [unit] After `onModuleInit`, the registry answers `vcs.connection.create` for `rest:vcs.create` with a `redeem`, and its `redeem.redact` of `{ slug: 's', projectId: 'p1', connection: { provider: 'github', repoOwner: 'o', repoName: 'r', token: 't' } }` answers the same with `connection.token` `'<redacted>'`.
- AC-9 [unit] That command's `execute`, with `vcsConfig.encryptionKey` empty, rejects with a `ValidationAppException` carrying key `vcs` and never calls `VcsConnectionService.create`.
- AC-10 [unit] Inside `AfterCommitService.scope`, `VcsConnectionService.create` calls `refreshConnectionSchedule` only after the scope's callback has returned; outside any scope it calls it before `create` resolves.
- AC-11 [unit] `VcsController.createConnection('s', dto, 'r1')`, with `findBySlug` answering project `p1`, calls `routeGate.run` with `{ key: 'vcs.connection.create', variant: 'rest:vcs.create', projectId: 'p1', input: { slug: 's', projectId: 'p1', connection: dto }, redeem: 'r1' }`.

### US-003: Gated VCS connection update and webhook-secret rotation, pinned to the connection

The requesting agent holds `vcs.connection.update` and `vcs.webhook-secret.rotate` on the test project. Each test creates the project's connection with the root token first (`createConnection` as in `gated-webhook-vcs-routes.integration.spec.ts`).

- AC-1 [integration] `PATCH /api/projects/<slug>/vcs` `{ syncMode: 'polling' }` by the agent under no policy answers 202 with `data` matching `{ permissionKey: 'vcs.connection.update', redeem: true }`, and the connection's `syncMode` is still `off`.
- AC-2 [integration] Approving AC-1's request and redeeming it answers 200 with `data.syncMode` `polling`, and the request row is `executed`.
- AC-3 [integration] A request opened by `PATCH … { token: 'tok-new' }` stores `input.patch.token` `'<redacted>'`; approving and redeeming it answers 200, and the stored `encryptedToken` decrypts to `tok-new`.
- AC-4 [integration] Redeeming an approved `{ syncMode: 'polling' }` request with the body `{ syncMode: 'polling', token: 'tok-x' }` answers 409 with key `approvals.redeemMismatch`, and the stored token is unchanged.
- AC-5 [integration] An approved update request, redeemed after the test deleted the connection and created a new one with the root token, answers 409 with key `approvals.redeemMismatch`; the request row stays `approved`, and the new connection's `syncMode` is unchanged.
- AC-6 [integration] `POST /api/projects/<slug>/vcs/webhook-secret/rotate` by the agent under no policy answers 202; approving and redeeming it answers 200 with `data.webhookSecret` a non-empty string different from the connection's previous `webhookSecret`.
- AC-7 [integration] After AC-6, the request row's `input` is `{ slug, projectId, connectionId: <the connection id> }` and its `result` is `{ rotated: true }`.
- AC-8 [integration] An approved rotate request, redeemed after the connection was deleted and recreated, answers 409 with key `approvals.redeemMismatch`, and the new connection's `webhookSecret` is unchanged.
- AC-9 [integration] `PATCH /api/projects/<slug>/vcs` and the rotate route with the root token answer 200 and write no `ApprovalRequest` row.
- AC-10 [unit] `VcsConnectionService.update('p1', key, dto, 'c-other')` for a project whose connection id is `c1` throws `NotFoundAppException` with key `vcs` and never calls `updateVcsConnection`; with `'c1'` or no `connectionId` it updates.
- AC-11 [unit] `rotateWebhookSecret('p1', 'c-other')` throws `NotFoundAppException` with key `vcs` and never calls `updateVcsConnection`.
- AC-12 [unit] After `onModuleInit`, the registry answers `rest:vcs.update` and `rest:vcs.rotate-webhook-secret` with a `redeem`; the update `redeem.redact` of `{ slug: 's', projectId: 'p1', connectionId: 'c1', patch: { syncMode: 'off' } }` answers it unchanged (no `token` key added).
- AC-13 [unit] `VcsController.updateConnection('s', dto, 'r1')` calls `findByProject` before `routeGate.run`, whose `input.connectionId` is the connection's id; a `findByProject` 404 rejects before `routeGate.run` is called; with an empty `encryptionKey` it rejects 400 `vcs` without calling `findByProject`.
- AC-14 [integration] With the connection's `webhookSecret` set to null in the database, redeeming an approved `{ syncMode: 'webhook' }` update request answers 200 with a non-empty `data.webhookSecret`, and the request row's `result` has no `webhookSecret` property.
- AC-15 [unit] Inside `AfterCommitService.scope`, `VcsConnectionService.update` calls `refreshConnectionSchedule` only after the scope's callback has returned; when that deferred refresh rejects, the scope resolves with the update's result (its `webhookSecret` intact) and the class logger's `warn` is called once.

### US-004: Gated webhook create and update, with the URL check in prepare

The requesting agent holds `webhook.create` and `webhook.update` on the test project. A create body is `{ url: 'https://93.184.215.14/hook', events: ['ticket.created'] }` (an IP literal, so no DNS is needed).

- AC-1 [integration] `POST /api/projects/<slug>/webhooks` with a create body by the agent under no policy answers 202 with `data` matching `{ permissionKey: 'webhook.create', redeem: true }`, and the project has no `Webhook`.
- AC-2 [integration] Approving AC-1's request and redeeming it answers 201 with `data.secret` a 40-character hex string; the request row's `result` has no `secret` property.
- AC-3 [integration] A request opened with `secret: 's'.repeat(32)` in the body stores `input.webhook.secret` `'<redacted>'`; approving and redeeming it answers 201, and the `Webhook` row's `secret` is `'s'.repeat(32)`.
- AC-4 [integration] Redeeming an approved create request (no `secret`) with a body that adds `secret: 'x'.repeat(32)` answers 409 with key `approvals.redeemMismatch`, and the project has no `Webhook`.
- AC-5 [integration] Redeeming an approved update request (`{ active: false }`) with the body `{ active: false, url: 'https://93.184.215.15/hook' }` answers 409 with key `approvals.redeemMismatch`, and the webhook's `url` and `active` are unchanged.
- AC-6 [integration] `PATCH /api/projects/<slug>/webhooks/<id>` `{ active: false }` by the agent under no policy answers 202; approving and redeeming it answers 200 with `data.active` `false`, and `data` has no `secret` property.
- AC-7 [integration] An approved update request, redeemed after the test deleted the webhook, answers 404 (`webhooks`), and the request row is `failed`.
- AC-8 [integration] `POST …/webhooks` and `PATCH …/webhooks/<id>` with the root token answer 201 and 200 and write no `ApprovalRequest` row.
- AC-9 [unit] After `onModuleInit`, the registry answers `rest:project-webhooks.create` and `rest:project-webhooks.update`, each with a `prepare` and a `redeem`.
- AC-10 [unit] `prepareCreate(projectId, dto)` calls `urlGuard.checkUrl(dto.url)` once and calls no repository write; its callback calls `createWebhook` once.
- AC-11 [unit] `prepareCreate` with a URL the guard rejects (`OutboundUrlRejection('blocked_destination')`) throws `ValidationAppException` with key `webhooks` and answers no callback.
- AC-12 [unit] `prepareUpdate(projectId, id, dto)` for a webhook of another project throws `NotFoundAppException` with key `webhooks`; for a webhook deleted after `prepareUpdate` resolved, its callback throws `NotFoundAppException` with key `webhooks` and calls no `update`.
- AC-13 [integration] `PATCH /api/projects/<slug>/webhooks/<id>` `{ secret: 's'.repeat(32) }` by the agent under no policy stores `input.patch.secret` `'<redacted>'` (read through `GET /api/approvals/:id` with the root token); approving it and redeeming with `{ secret: 't'.repeat(32) }` answers 200, and the `Webhook` row's `secret` is `'t'.repeat(32)`.

### US-005: Gated invite create and resend, with the invite link redacted

The requesting agent holds `invite.create` and `invite.resend` on the test project, and the `viewer` role there (`grantRole(db, { type: 'AGENT', id }, 'viewer', <project id>)`, as `gated-member-invite-routes.integration.spec.ts` does), so granting `viewer` passes `assertNoEscalation`. "Under a wait policy" uses `seedWaitPolicy(db, <key>, <project id>)`. Email is unconfigured in the test app, so results carry `emailed: false`. A create body is `{ email: <unique>, roleKey: 'viewer' }`.

- AC-1 [integration] `POST /api/projects/<slug>/invites` with a create body by the agent under a wait policy answers 202 with `data` matching `{ permissionKey: 'invite.create', redeem: true }`, and no `ProjectInvite` row exists for that email.
- AC-2 [integration] Approving AC-1's request and redeeming it answers 201 with `data.outcome` `INVITED` and `data.invitePath` starting with `/invite/`; the request row's `result` has `outcome` `INVITED` and no `invitePath` property.
- AC-3 [integration] After AC-2, the request row's `input` has `invite.email` the body's email and no `locale` property.
- AC-4 [integration] Redeeming an approved create request with the header `Accept-Language: zh-CN` answers 201 (the stored hash ignores the locale).
- AC-5 [integration] Redeeming an approved create request with another email answers 409 with key `approvals.redeemMismatch`, and no `ProjectInvite` row exists for either email.
- AC-6 [integration] `POST /api/projects/<slug>/invites/<id>/resend` for a pending invite (created with the root token) by the agent under a wait policy answers 202; approving and redeeming it answers 200 with a `data.invitePath` different from the create's, and the request row's `result` has no `invitePath`.
- AC-7 [integration] An approved resend request, redeemed after the test cancelled the invite with the root token, answers 409 (`invites.final`), and the request row is `failed`.
- AC-8 [integration] `POST …/invites` by the agent under no policy answers 201 (default `none`) and writes no `ApprovalRequest` row.
- AC-9 [unit] After `onModuleInit`, the registry answers `rest:project-invites.create` and `rest:project-invites.resend` with a `redeem`, and the create `redeem.redact` of `{ slug: 's', projectId: 'p1', invite: { email: 'e@x.test', roleKey: 'viewer' }, locale: 'zh' }` answers it without `locale`.
- AC-10 [unit] `ProjectInvitesController.create('proj', dto, { project: { id: 'p1' } }, 'zh-CN', 'r1')` calls `gate.run` with `{ key: 'invite.create', variant: 'rest:project-invites.create', projectId: 'p1', input: { slug: 'proj', projectId: 'p1', invite: dto, locale: 'zh' }, redeem: 'r1' }`.
- AC-11 [unit] `PENDING_GATE_ROUTES` and `SECRET_GATE_ROUTES` are empty.

### US-006: The CI-token project patch through the redeem path

The requesting agent holds `project.update` on the test project. A token is `'t'.repeat(32)`.

- AC-1 [integration] `PATCH /api/projects/<slug>` `{ ciWebhookToken: <token> }` by the agent under a wait policy answers 202 with `data` matching `{ permissionKey: 'project.update', redeem: true }`, and the project's `ciWebhookToken` is unchanged.
- AC-2 [integration] `GET /api/approvals/<AC-1's request>` with the root token answers `data.input.patch.ciWebhookToken` `'<redacted>'`.
- AC-3 [integration] Approving AC-1's request and redeeming it answers 200, and `GET /api/projects/<slug>/ci-webhook-token` with the root token answers `data.ciWebhookToken` equal to that token.
- AC-4 [integration] `PATCH /api/projects/<slug>` `{ name: 'Renamed', ciWebhookToken: <token> }` by the root token under a wait policy answers 200 (no 400, no 202), both the name and the token changed, and no `ApprovalRequest` row exists.
- AC-5 [integration] A mixed patch `{ name: 'Renamed', ciWebhookToken: <token> }` by the agent under a wait policy answers 202; approving and redeeming it answers 200 with `data.name` `Renamed`.
- AC-6 [integration] Redeeming an approved `{ ciWebhookToken: <token> }` request with the body `{ name: 'Other', ciWebhookToken: <token> }` answers 409 with key `approvals.redeemMismatch`.
- AC-7 [integration] `PATCH /api/projects/<slug>` `{ name: 'Plain' }` by the agent under a wait policy answers 202 with `redeem` `false`; approving it answers `status` `executed` (the ordinary variant runs on approval).
- AC-8 [integration] `PATCH /api/projects/<slug>` `{ ciWebhookToken: null }` by the root token answers 200, and the CI token read answers `data.ciWebhookToken` `null`.
- AC-9 [unit] `ProjectsController.update('alpha', { ciWebhookToken: <token>, name: 'N' }, ctx, 'r1')` calls `routeGate.run` with `variant` `'rest:projects.update-ci-token'`, `input` `{ slug: 'alpha', patch: { ciWebhookToken: <token>, name: 'N' } }` and `redeem` `'r1'`, and never calls `projectsService.update` directly.
- AC-10 [unit] `update('alpha', { name: 'N' }, ctx, 'r1')` calls `routeGate.run` with `variant` `'rest:projects.update'` and no `redeem` property.
- AC-11 [unit] After `onModuleInit`, the registry answers `project.update` for `rest:projects.update-ci-token` with a `redeem`, whose `redact` of `{ slug: 'a', patch: { ciWebhookToken: 's'.repeat(32), name: 'N' } }` answers `{ slug: 'a', patch: { ciWebhookToken: '<redacted>', name: 'N' } }` and of `{ slug: 'a', patch: { ciWebhookToken: null } }` answers it unchanged.
- AC-12 [unit] The `rest:projects.update` command's `parse` still throws `ValidationAppException` for a patch carrying `ciWebhookToken`.

### US-007: Delete the rollout allowlist; the contract counts 126

- AC-1 [unit] `findContractViolations` of declarations holding an ungated `DELETE /labels/:id` route requiring an approvable `label.delete` reports `{ kind: 'ungated-approvable-write', route: 'DELETE /labels/:id' }`.
- AC-2 [integration] Over the booted app, the collected routes contain exactly 126 gated routes, and `findContractViolations` reports no violation.
- AC-3 [integration] Over the booted app, every write route (`POST`, `PUT`, `PATCH`, `DELETE`) whose required keys include an approvable key is gated.
- AC-4 [unit] `openapi.json`'s `post /api/fleet/enrollments`, `post /api/projects/{slug}/vcs`, `patch /api/projects/{slug}/vcs`, `post /api/projects/{slug}/vcs/webhook-secret/rotate`, `post /api/projects/{slug}/webhooks`, `patch /api/projects/{slug}/webhooks/{id}`, `post /api/projects/{slug}/invites`, `post /api/projects/{slug}/invites/{id}/resend` and `patch /api/projects/{slug}` operations each have a `202` response and exactly one parameter named `X-Koda-Approval-Request` (in `header`, not required). Other header parameters (the invite routes' pre-existing `accept-language`) are not counted.
- AC-5 [unit] The operations of `openapi.json` with a `202` response are exactly the 126 gated ones.

Verification note: `openapi.json` is regenerated with `bun run api:export-spec` (repo root); `bun run --cwd apps/api type-check` and `bun run --cwd apps/api lint` pass. AC-4 and AC-5 live in `src/approvals/approval-openapi.contract.spec.ts`; AC-1 in `src/permissions/test-helpers/permission-contract.spec.ts`; AC-2 and AC-3 in `test/integration/permissions/permission-contract.integration.spec.ts`. The deletion itself (no import of `pending-gate-routes` left, three `findContractViolations` parameters) is pinned by `type-check`, not an AC.
