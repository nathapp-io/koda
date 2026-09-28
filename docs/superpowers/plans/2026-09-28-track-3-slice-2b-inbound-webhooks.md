# Track 3 Slice 2b — Inbound Webhook Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inbound CI and VCS webhooks no longer reveal which project slugs exist, never show validation errors to an unauthenticated caller, and the VCS webhook processes deliveries only for an active connection in `webhook` sync mode. `DELETE projects/:slug/webhooks/:id` is scoped to its project.

**Architecture:** Each inbound controller does one lookup by slug that returns either the signing target (project id + secret) or `null`. Every miss (unknown slug, soft-deleted project, no secret, no VCS connection) and a bad signature throw the same `AuthException`. The `@Body()` parameter goes away: the controllers read `request.rawBody` / `request.body` through a small shared helper in `webhook-security/`, verify the HMAC first, and only then validate the CI payload with class-validator. The VCS connection-state gate runs after the signature check and before replay dedup. The outbound webhook delete route gains the same project check that `update()` already has.

**Tech Stack:** NestJS 10 + `@nathapp/nestjs-*` (auth, common), class-validator / class-transformer, Prisma on Postgres, Jest (unit, DB integration, api e2e via supertest), `@hey-api/openapi-ts` generated CLI client.

**Spec:** `docs/superpowers/specs/2026-09-27-track-3-review-remediation-design.md`, section "Slice 2 — Webhooks", subsection "2b — Inbound CI and VCS webhooks (LOWs)" and its "Tests" bullets. Source findings: `docs/20260925-review-whole-repo.md` lines 326-333 ("Webhook routes before the signature check", all four sub-claims CONFIRMED; "`DELETE projects/:slug/webhooks/:id` ignores `:slug`" CONFIRMED).

**Branch:** `feat/track3-inbound-webhooks` in the main checkout `repos/koda`, branched from `main` `8fc552bb`. No other slice is in flight, so the shared test database has no concurrent user.

---

## Global Constraints

- API stays single-instance. Postgres only. String-typed enum / JSON-as-String columns stay.
- Follow `nathapp-nestjs-patterns`: `JsonResponse.Ok`, `AppException` subclasses (`AuthException`, `NotFoundAppException`, `ValidationAppException` from `@nathapp/nestjs-common`), repository -> service -> controller.
- TDD for every task: failing test first, then implementation.
- DB-backed behaviour gets integration tests on real Postgres (`KODA_DB_TESTS=1`, via `bun run test:integration`). Run `cd apps/api && bun run test:db:up` once before the first DB-backed command (idempotent).
- Contract changes regenerate `openapi.json` and the CLI client in the same PR (`bun run generate` at the repo root). Never hand-edit `openapi.json` or `apps/cli/src/generated/**`.
- All ten CI checks are required on `main` (`changes`, `lint`, `type-check`, `web build`, `policy-gates`, `test`, `integration`, `e2e`, `evaluate`, `smoke`).
- **No slug enumeration (spec, verbatim):** "unknown slug, missing secret, missing connection and bad signature all return the same 401 with the same body." Replay dedup still runs after verification.
- **Signature before DTO validation (spec):** "The `@Body()` DTO parameter is removed. The controller verifies `rawBody`, then parses and validates with class-validator (`plainToInstance` + `validate`), 400 on failure. An unauthenticated caller never sees validation errors."
- `CiWebhookPayloadDto.line` gets `@IsInt() @Min(1)`.
- **VCS gate (spec):** 200 `{ ignored: true, reason }` unless the connection `isActive` is true **and** `syncMode === 'webhook'` (values are `off | polling | webhook`). 200 avoids GitHub retry storms.
- **Delete scope (spec):** `DELETE projects/:slug/webhooks/:id` looks the webhook up by project id; another project's id -> 404. The slug-less `DELETE webhooks/:id` (global ADMIN only) stays as the deliberate cross-project admin route.
- Out of scope (spec): GitLab inbound webhooks; `syncMode` `@IsEnum` on VCS connection create (a VCS LOW, Slice 4). Also out of scope for this plan: equalising response *timing* between an unknown slug (no HMAC computed) and a bad signature. The spec's requirement is the identical status and body.
- `nestjs-i18n` is not a direct dependency of `apps/api`. Do not import `I18nValidationException`; use `ValidationAppException` (code `-2`, message `exception.-2` = "Request Parameter Error: {param}", present in `en` and `zh`).

## Review Focus

Inputs the spec implies but does not spell out. Each has a test in the task that owns the code.

1. **An empty-string secret** (`Project.ciWebhookToken = ''` or `VcsConnection.webhookSecret = ''`) must count as "no secret" and get the same 401. An HMAC keyed with `''` can be forged by anyone. Tests: Task 2 (service `findInboundTarget`), Task 4 (controller, `webhookSecret: ''`).
2. **A signed body that is not a JSON object** (`[]`, `null`, a string) must give a 400 on the CI route, not a 500 or a silent "event ignored" 200. On the VCS route it must not crash with a `TypeError`. Tests: Task 1 (helper), Task 2 (CI controller), Task 4 (VCS controller).
3. **A signed but invalid CI payload must not consume its delivery id.** Validation runs before `replayGuard.assertFresh`, so the sender's corrected retry with the same `X-CI-Delivery` is accepted. Test: Task 2.
4. **Connection state must not leak before the signature check.** An inactive or polling connection with a bad signature gets the 401, not the 200 `ignored`. Otherwise the 200 would itself reveal that the slug has a connection. Test: Task 4.
5. **A numeric-string `line`** (`"87"`) keeps working (class-transformer's `@Type(() => Number)` coerces it to `87`), while `"abc"`, `0` and `1.5` are 400. Tests: Task 1 (helper, with a local DTO) and Task 2 (CI controller with the real DTO).

---

## File Structure

| File | Change | Responsibility |
|:--|:--|:--|
| `apps/api/src/webhook-security/inbound-webhook-request.ts` | Create | `InboundWebhookRequest` type, `signedBytesOf()`, `parseInboundPayload()` |
| `apps/api/src/webhook-security/inbound-webhook-request.spec.ts` | Create | Unit tests for the helper |
| `apps/api/src/ci-webhook/ci-webhook.dto.ts` | Modify | `line`: `@IsInt() @Min(1)`, OpenAPI `type: 'integer', minimum: 1` |
| `apps/api/src/ci-webhook/ci-webhook.service.ts` | Modify | Replace `getWebhookSecret` + `resolveProject` with `findInboundTarget` |
| `apps/api/src/ci-webhook/ci-webhook.service.spec.ts` | Modify | `findInboundTarget` tests |
| `apps/api/src/ci-webhook/ci-webhook.controller.ts` | Modify | One lookup, one 401, signature -> validate -> replay -> process |
| `apps/api/src/ci-webhook/ci-webhook.controller.spec.ts` | Rewrite | New signature (no payload argument) plus the 2b cases |
| `apps/api/src/vcs/domain/vcs.repository.ts` | Modify | `findVcsConnectionByProjectSlug` on `IVcsRepository` |
| `apps/api/src/vcs/prisma-vcs.repository.ts` | Modify | Implementation (live projects only) |
| `apps/api/src/vcs/vcs-connection.service.ts` | Modify | `findInboundTarget(slug)` |
| `apps/api/src/vcs/vcs-connection.service.spec.ts` | Modify | `findInboundTarget` test |
| `apps/api/test/integration/vcs/vcs-inbound-target.integration.spec.ts` | Create | Real-Postgres test of the slug lookup |
| `apps/api/src/vcs/vcs-webhook.controller.ts` | Modify | One lookup, one 401, `isActive`/`syncMode` gate, no `ProjectsService` |
| `apps/api/src/vcs/vcs-webhook.controller.spec.ts` | Rewrite | New signature plus the 2b cases |
| `apps/api/test/integration/vcs/vcs-webhook.integration.spec.ts` | Modify | Codemod the call sites; mock `findInboundTarget`; 404 cases -> 401 |
| `apps/api/test/integration/vcs/vcs-webhook-pull-request.integration.spec.ts` | Modify | Codemod the call sites; mock `findInboundTarget` |
| `apps/api/src/webhook/webhook.service.ts` | Modify | `removeForProject(projectId, id)` |
| `apps/api/src/webhook/webhook.service.spec.ts` | Modify | `removeForProject` tests |
| `apps/api/src/webhook/webhook.controller.ts` | Modify | `removeByProject` resolves the slug and calls `removeForProject` |
| `apps/api/test/integration/webhook/webhook-routes.integration.spec.ts` | Modify | DELETE scope over HTTP |
| `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` | Modify | 404 -> 401 expectations; identical-body checks; signed-invalid 400 |
| `openapi.json`, `apps/cli/src/generated/**` | Regenerate | Contract follows the controllers |

---

### Task 0: Commit the plan

**Files:**
- Create: `docs/superpowers/plans/2026-09-28-track-3-slice-2b-inbound-webhooks.md` (this file)

- [ ] **Step 1: Confirm the branch**

Run: `git -C repos/koda branch --show-current && git -C repos/koda log --oneline -1`
Expected: `feat/track3-inbound-webhooks` and `8fc552bb ...`

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/plans/2026-09-28-track-3-slice-2b-inbound-webhooks.md
git commit -m "docs(track3-slice2b): inbound webhook hardening plan"
```

---

### Task 1: Shared inbound-request helper

**Files:**
- Create: `apps/api/src/webhook-security/inbound-webhook-request.ts`
- Test: `apps/api/src/webhook-security/inbound-webhook-request.spec.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (used by Tasks 2 and 4):
  - `export type InboundWebhookRequest = { rawBody?: Buffer; body?: unknown }`
  - `export function signedBytesOf(request: InboundWebhookRequest): string`
  - `export async function parseInboundPayload<T extends object>(cls: ClassConstructor<T>, body: unknown): Promise<T>`: throws `ValidationAppException({ param: <dotted path of the first failing property> })` (HTTP 400); returns the class instance.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/webhook-security/inbound-webhook-request.spec.ts`:

```ts
import 'reflect-metadata';
import { Type } from 'class-transformer';
import { IsArray, IsInt, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { parseInboundPayload, signedBytesOf } from './inbound-webhook-request';

class ItemDto {
  @IsString()
  name!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  line?: number;
}

class PayloadDto {
  @IsString()
  event!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ItemDto)
  items!: ItemDto[];
}

async function rejectionOf(promise: Promise<unknown>): Promise<ValidationAppException> {
  try {
    await promise;
  } catch (err) {
    return err as ValidationAppException;
  }
  throw new Error('expected the call to reject');
}

describe('signedBytesOf', () => {
  it('returns the raw bytes when the preParsing hook captured them (KODA-02)', () => {
    const raw = '{ "b": 1,   "a": 2 }';
    expect(signedBytesOf({ rawBody: Buffer.from(raw), body: { a: 2, b: 1 } })).toBe(raw);
  });

  it('falls back to the re-serialized body when there is no rawBody (Express test setups)', () => {
    expect(signedBytesOf({ body: { a: 1 } })).toBe('{"a":1}');
  });

  it('serializes a missing body as {}', () => {
    expect(signedBytesOf({})).toBe('{}');
  });
});

describe('parseInboundPayload', () => {
  it('returns a validated class instance', async () => {
    const result = await parseInboundPayload(PayloadDto, { event: 'e', items: [{ name: 'n', line: 3 }] });
    expect(result).toBeInstanceOf(PayloadDto);
    expect(result.items[0]).toBeInstanceOf(ItemDto);
    expect(result.items[0].line).toBe(3);
  });

  it('coerces a numeric-string line through @Type(() => Number)', async () => {
    const result = await parseInboundPayload(PayloadDto, { event: 'e', items: [{ name: 'n', line: '87' }] });
    expect(result.items[0].line).toBe(87);
  });

  it.each([
    ['a zero line', { event: 'e', items: [{ name: 'n', line: 0 }] }, 'items.0.line'],
    ['a fractional line', { event: 'e', items: [{ name: 'n', line: 1.5 }] }, 'items.0.line'],
    ['a non-numeric line', { event: 'e', items: [{ name: 'n', line: 'abc' }] }, 'items.0.line'],
    ['a missing top-level field', { items: [] }, 'event'],
  ])('rejects %s with a 400 naming the failing path', async (_label, body, path) => {
    const err = await rejectionOf(parseInboundPayload(PayloadDto, body));
    expect(err).toBeInstanceOf(ValidationAppException);
    expect(err.getStatus()).toBe(400);
    expect(err.args).toEqual({ param: path });
  });

  it.each([
    ['an array', []],
    ['null', null],
    ['a string', 'pipeline_failed'],
    ['undefined', undefined],
  ])('rejects %s body with a 400 on "body"', async (_label, body) => {
    const err = await rejectionOf(parseInboundPayload(PayloadDto, body));
    expect(err).toBeInstanceOf(ValidationAppException);
    expect(err.args).toEqual({ param: 'body' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && bun run test -- src/webhook-security/inbound-webhook-request.spec.ts`
Expected: FAIL with "Cannot find module './inbound-webhook-request'"

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/webhook-security/inbound-webhook-request.ts`:

```ts
import { plainToInstance, type ClassConstructor } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import { ValidationAppException } from '@nathapp/nestjs-common';

/** The parts of the Fastify request an inbound webhook controller reads. */
export type InboundWebhookRequest = { rawBody?: Buffer; body?: unknown };

/**
 * The bytes the sender signed. Prefer the raw bytes captured by the preParsing
 * hook (KODA-02). Without the hook (Express-based test setups) fall back to the
 * re-serialized body, which the platform round-trips from the same JSON.
 */
export function signedBytesOf(request: InboundWebhookRequest): string {
  return request.rawBody ? request.rawBody.toString('utf8') : JSON.stringify(request.body ?? {});
}

/**
 * Validates an inbound webhook body against a class-validator DTO. Call it only
 * after the signature check, so an unauthenticated caller never sees a
 * validation error. The options mirror the global ValidationPipe.
 */
export async function parseInboundPayload<T extends object>(
  cls: ClassConstructor<T>,
  body: unknown,
): Promise<T> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationAppException({ param: 'body' });
  }

  const instance = plainToInstance(cls, body as Record<string, unknown>);
  const errors = await validate(instance, { forbidUnknownValues: false, stopAtFirstError: true });
  if (errors.length > 0) {
    throw new ValidationAppException({ param: firstErrorPath(errors) });
  }
  return instance;
}

function firstErrorPath(errors: ValidationError[], parent = ''): string {
  const [first] = errors;
  const path = parent ? `${parent}.${first.property}` : first.property;
  return first.children && first.children.length > 0 ? firstErrorPath(first.children, path) : path;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && bun run test -- src/webhook-security/inbound-webhook-request.spec.ts`
Expected: PASS (all cases)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/webhook-security/inbound-webhook-request.ts apps/api/src/webhook-security/inbound-webhook-request.spec.ts
git commit -m "feat(track3-slice2b): shared inbound webhook request helper"
```

---

### Task 2: CI webhook: one 401, signature before validation, `line` integer

**Files:**
- Modify: `apps/api/src/ci-webhook/ci-webhook.dto.ts:37-40`
- Modify: `apps/api/src/ci-webhook/ci-webhook.service.ts:12-30`
- Modify: `apps/api/src/ci-webhook/ci-webhook.service.spec.ts` (add a `describe`)
- Modify: `apps/api/src/ci-webhook/ci-webhook.controller.ts` (whole handler)
- Rewrite: `apps/api/src/ci-webhook/ci-webhook.controller.spec.ts`

**Interfaces:**
- Consumes (Task 1): `InboundWebhookRequest`, `signedBytesOf`, `parseInboundPayload`.
- Produces:
  - `CiWebhookService.findInboundTarget(projectSlug: string): Promise<{ projectId: string; secret: string } | null>`
  - `CiWebhookController.handleCiWebhook(slug: string, request: InboundWebhookRequest, signature?: string, deliveryId?: string, dateHeader?: string)`. The payload argument is gone.
  - `CiWebhookService.getWebhookSecret` and `CiWebhookService.resolveProject` are **deleted**. Their only caller is this controller (verified with grep at `8fc552bb`).

- [ ] **Step 1: Write the failing service test**

In `apps/api/src/ci-webhook/ci-webhook.service.spec.ts`, add this `describe` block inside `describe('CiWebhookService', ...)`, directly before `describe('processCiWebhook', ...)`:

```ts
  describe('findInboundTarget', () => {
    it('returns the project id and secret for a live project with a token', async () => {
      mockRepo.findProjectBySlug.mockResolvedValue({ ...mockProject, ciWebhookToken: 'tok-123' });

      await expect(service.findInboundTarget('koda')).resolves.toEqual({ projectId: 'proj-123', secret: 'tok-123' });
      expect(mockRepo.findProjectBySlug).toHaveBeenCalledWith('koda');
    });

    it.each([
      ['an unknown slug', null],
      ['a soft-deleted project', { ...mockProject, ciWebhookToken: 'tok-123', deletedAt: new Date() }],
      ['a project without a token', { ...mockProject, ciWebhookToken: null }],
      ['a project with an empty-string token', { ...mockProject, ciWebhookToken: '' }],
    ])('returns null (never throws) for %s', async (_label, row) => {
      mockRepo.findProjectBySlug.mockResolvedValue(row);

      await expect(service.findInboundTarget('koda')).resolves.toBeNull();
    });
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test -- src/ci-webhook/ci-webhook.service.spec.ts`
Expected: FAIL with "service.findInboundTarget is not a function"

- [ ] **Step 3: Implement `findInboundTarget` and delete the two old methods**

In `apps/api/src/ci-webhook/ci-webhook.service.ts`, replace `getWebhookSecret` and `resolveProject` (lines 12-30) with:

```ts
  /**
   * The project id and HMAC secret for an inbound CI webhook, or null when the
   * slug is unknown, the project is soft-deleted, or no token is configured.
   * Callers answer every null with the same 401 as a bad signature, so slugs
   * are not enumerable. An empty-string token counts as "no token": an HMAC
   * keyed with '' could be forged by anyone.
   */
  async findInboundTarget(projectSlug: string): Promise<{ projectId: string; secret: string } | null> {
    const project = await this.repo.findProjectBySlug(projectSlug);

    if (!project || project.deletedAt || !project.ciWebhookToken) {
      return null;
    }

    return { projectId: project.id, secret: project.ciWebhookToken };
  }
```

- [ ] **Step 4: Run the service test to verify it passes**

Run: `cd apps/api && bun run test -- src/ci-webhook/ci-webhook.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Rewrite the controller spec (failing)**

Replace the whole of `apps/api/src/ci-webhook/ci-webhook.controller.spec.ts` with:

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { AuthException, ValidationAppException } from '@nathapp/nestjs-common';
import { createHmac } from 'node:crypto';
import { CiWebhookController } from './ci-webhook.controller';
import { CiWebhookService } from './ci-webhook.service';
import { CiWebhookPayloadDto } from './ci-webhook.dto';
import { WebhookReplayGuard } from '../webhook-security/webhook-replay.guard';
import type { InboundWebhookRequest } from '../webhook-security/inbound-webhook-request';

const SECRET = 'test-secret';

function sign(rawBody: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(rawBody).digest('hex')}`;
}

/** A Fastify-shaped request: the raw bytes the sender signed plus the parsed body. */
function requestOf(body: unknown, rawBody: string = JSON.stringify(body)): InboundWebhookRequest {
  return { rawBody: Buffer.from(rawBody), body };
}

async function rejectionOf(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (err) {
    return err as HttpException;
  }
  throw new Error('expected the call to reject');
}

describe('CiWebhookController', () => {
  let controller: CiWebhookController;

  const mockCiWebhookService = {
    findInboundTarget: jest.fn(),
    processCiWebhook: jest.fn(),
  };

  const mockReplayGuard = {
    assertFresh: jest.fn(),
    forget: jest.fn(),
  };

  const validPayload: CiWebhookPayloadDto = {
    event: 'pipeline_failed',
    pipeline: { id: '12345', url: 'https://github.com/org/repo/actions/runs/12345' },
    commit: { sha: 'abc123def456', message: 'feat: add dark mode' },
    failures: [
      { test: 'AuthService.validateToken', file: 'apps/api/src/auth/auth.service.ts', line: 87 },
    ],
  };

  beforeEach(async () => {
    mockCiWebhookService.findInboundTarget.mockReset().mockResolvedValue({ projectId: 'proj-1', secret: SECRET });
    mockCiWebhookService.processCiWebhook.mockReset().mockResolvedValue({ success: true, message: 'ok' });
    mockReplayGuard.assertFresh.mockReset().mockResolvedValue(undefined);
    mockReplayGuard.forget.mockReset().mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CiWebhookController],
      providers: [
        { provide: CiWebhookService, useValue: mockCiWebhookService },
        { provide: WebhookReplayGuard, useValue: mockReplayGuard },
      ],
    }).compile();

    controller = module.get<CiWebhookController>(CiWebhookController);
  });

  /** The 401 a caller gets for a bad signature on an existing project: the reference shape. */
  async function badSignatureRejection(): Promise<HttpException> {
    return rejectionOf(controller.handleCiWebhook('koda', requestOf(validPayload), 'sha256=bad'));
  }

  describe('happy path', () => {
    it('resolves the target once, verifies, and forwards the validated payload', async () => {
      const expectedResult = {
        success: true,
        ticketRef: 'KODA-1',
        message: 'Created ticket for CI failure: AuthService.validateToken',
      };
      mockCiWebhookService.processCiWebhook.mockResolvedValue(expectedResult);
      const request = requestOf(validPayload);

      const result = await controller.handleCiWebhook('koda', request, sign(request.rawBody!.toString('utf8')));

      expect(result.data).toEqual(expectedResult);
      expect(mockCiWebhookService.findInboundTarget).toHaveBeenCalledTimes(1);
      expect(mockCiWebhookService.findInboundTarget).toHaveBeenCalledWith('koda');
      expect(mockCiWebhookService.processCiWebhook).toHaveBeenCalledWith('koda', validPayload);
    });

    it('passes a class instance to the service (validated, with @Type conversions applied)', async () => {
      const payload = { ...validPayload, failures: [{ test: 'T', line: '87' }] };
      const raw = JSON.stringify(payload);

      await controller.handleCiWebhook('koda', requestOf(payload, raw), sign(raw));

      const forwarded = mockCiWebhookService.processCiWebhook.mock.calls[0][1];
      expect(forwarded).toBeInstanceOf(CiWebhookPayloadDto);
      expect(forwarded.failures[0].line).toBe(87);
    });

    it('verifies against the raw bytes, not JSON.stringify of the parsed body (KODA-02)', async () => {
      const raw = '{"failures":[{"test":"T"}],"commit":{"sha":"abc"},"pipeline":{"id":"1"},"event":"pipeline_failed"}';

      await controller.handleCiWebhook('koda', requestOf(JSON.parse(raw), raw), sign(raw));

      expect(mockCiWebhookService.processCiWebhook).toHaveBeenCalled();
    });

    it('falls back to JSON.stringify(body) when rawBody is absent (Express test setups)', async () => {
      await controller.handleCiWebhook('koda', { body: validPayload }, sign(JSON.stringify(validPayload)));

      expect(mockCiWebhookService.processCiWebhook).toHaveBeenCalledWith('koda', validPayload);
    });
  });

  describe('every inbound auth failure is the same 401 (no slug enumeration)', () => {
    it('a bad signature is an AuthException 401 and processes nothing', async () => {
      const err = await badSignatureRejection();

      expect(err).toBeInstanceOf(AuthException);
      expect(err.getStatus()).toBe(401);
      expect(mockCiWebhookService.processCiWebhook).not.toHaveBeenCalled();
      expect(mockReplayGuard.assertFresh).not.toHaveBeenCalled();
    });

    it('an unknown slug (or deleted project, or no token) gets the identical 401', async () => {
      const reference = await badSignatureRejection();
      mockCiWebhookService.findInboundTarget.mockResolvedValueOnce(null);
      const request = requestOf(validPayload);

      const err = await rejectionOf(
        controller.handleCiWebhook('nonexistent', request, sign(request.rawBody!.toString('utf8'))),
      );

      expect(err).toBeInstanceOf(AuthException);
      expect(err.getStatus()).toBe(401);
      expect(err.getResponse()).toEqual(reference.getResponse());
      expect(mockCiWebhookService.processCiWebhook).not.toHaveBeenCalled();
    });

    it('a missing signature header gets the identical 401', async () => {
      const reference = await badSignatureRejection();

      const err = await rejectionOf(controller.handleCiWebhook('koda', requestOf(validPayload), undefined));

      expect(err).toBeInstanceOf(AuthException);
      expect(err.getResponse()).toEqual(reference.getResponse());
    });
  });

  describe('validation runs only after a valid signature', () => {
    const invalidPayload = { event: 'invalid_event', pipeline: { id: '1' }, commit: { sha: 'abc' }, failures: [] };

    it('an unsigned invalid payload gets the 401, not a validation error', async () => {
      const err = await rejectionOf(controller.handleCiWebhook('koda', requestOf(invalidPayload), 'sha256=bad'));

      expect(err).toBeInstanceOf(AuthException);
    });

    it('an unknown slug with an invalid payload gets the 401, not a validation error', async () => {
      mockCiWebhookService.findInboundTarget.mockResolvedValueOnce(null);

      const err = await rejectionOf(controller.handleCiWebhook('nonexistent', requestOf(invalidPayload), undefined));

      expect(err).toBeInstanceOf(AuthException);
    });

    it.each([
      ['an unknown event', invalidPayload],
      ['a zero line', { ...validPayload, failures: [{ test: 'T', line: 0 }] }],
      ['a fractional line', { ...validPayload, failures: [{ test: 'T', line: 1.5 }] }],
      ['a non-numeric line', { ...validPayload, failures: [{ test: 'T', line: 'abc' }] }],
      ['an array body', [validPayload]],
      ['a null body', null],
    ])('a signed payload with %s is a 400 that neither processes nor records the delivery', async (_label, body) => {
      const raw = JSON.stringify(body);

      const err = await rejectionOf(controller.handleCiWebhook('koda', requestOf(body, raw), sign(raw), 'delivery-invalid'));

      expect(err).toBeInstanceOf(ValidationAppException);
      expect(err.getStatus()).toBe(400);
      expect(mockCiWebhookService.processCiWebhook).not.toHaveBeenCalled();
      expect(mockReplayGuard.assertFresh).not.toHaveBeenCalled();
    });
  });

  describe('replay protection (SEC-1)', () => {
    it('checks replay after verification and validation, with the resolved project id', async () => {
      const request = requestOf(validPayload);

      await controller.handleCiWebhook('koda', request, sign(request.rawBody!.toString('utf8')), 'delivery-abc-123');

      expect(mockReplayGuard.assertFresh).toHaveBeenCalledWith({
        projectId: 'proj-1',
        source: 'ci',
        deliveryId: 'delivery-abc-123',
        dateHeader: undefined,
      });
    });

    it('rejects a replayed delivery with 409 and does not process it', async () => {
      mockReplayGuard.assertFresh.mockRejectedValueOnce(new HttpException('Webhook already processed', HttpStatus.CONFLICT));
      const request = requestOf(validPayload);

      await expect(
        controller.handleCiWebhook('koda', request, sign(request.rawBody!.toString('utf8')), 'delivery-dup'),
      ).rejects.toMatchObject({ status: HttpStatus.CONFLICT });

      expect(mockCiWebhookService.processCiWebhook).not.toHaveBeenCalled();
    });

    it('forgets the delivery when processing fails so sender retries are accepted', async () => {
      mockCiWebhookService.processCiWebhook.mockRejectedValueOnce(new Error('boom'));
      const request = requestOf(validPayload);

      await expect(
        controller.handleCiWebhook('koda', request, sign(request.rawBody!.toString('utf8')), 'delivery-retry-1'),
      ).rejects.toThrow('boom');

      expect(mockReplayGuard.forget).toHaveBeenCalledWith({
        projectId: 'proj-1',
        source: 'ci',
        deliveryId: 'delivery-retry-1',
      });
    });
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd apps/api && bun run test -- src/ci-webhook/ci-webhook.controller.spec.ts`
Expected: FAIL. Most cases fail because the controller still takes `payload` as its second argument and calls the deleted `getWebhookSecret` / `resolveProject`.

- [ ] **Step 7: Tighten `line` in the DTO**

In `apps/api/src/ci-webhook/ci-webhook.dto.ts`, change the import on line 2 to:

```ts
import { IsString, IsOptional, IsArray, ValidateNested, IsIn, IsInt, Min } from 'class-validator';
```

and replace the `line` property (lines 37-40) with:

```ts
  @ApiPropertyOptional({ description: 'Line number where failure occurred', example: 87, type: 'integer', minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  line?: number;
```

- [ ] **Step 8: Rewrite the controller**

Replace the whole of `apps/api/src/ci-webhook/ci-webhook.controller.ts` with:

```ts
import { Controller, Post, Param, HttpCode, Headers, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { Public } from '@nathapp/nestjs-auth';
import { AuthException, JsonResponse } from '@nathapp/nestjs-common';
import { CiWebhookService } from './ci-webhook.service';
import { CiWebhookPayloadDto, CiWebhookResponseDto } from './ci-webhook.dto';
import { WebhookReplayGuard } from '../webhook-security/webhook-replay.guard';
import {
  InboundWebhookRequest,
  parseInboundPayload,
  signedBytesOf,
} from '../webhook-security/inbound-webhook-request';
import { createHmac, timingSafeEqual } from 'node:crypto';

@ApiTags('ci-webhooks')
@Controller()
export class CiWebhookController {
  constructor(
    private ciWebhookService: CiWebhookService,
    private readonly replayGuard: WebhookReplayGuard,
  ) {}

  @Post('projects/:slug/ci-webhook')
  @HttpCode(200)
  @Public()
  @ApiOperation({ summary: 'Receive CI pipeline failure webhook and auto-create ticket' })
  @ApiBody({ type: CiWebhookPayloadDto })
  @ApiResponse({ status: 200, type: CiWebhookResponseDto, description: 'Webhook processed' })
  @ApiResponse({ status: 400, description: 'Invalid payload (checked only after a valid signature)' })
  @ApiResponse({ status: 401, description: 'Unknown project, no CI webhook token, or invalid signature' })
  async handleCiWebhook(
    @Param('slug') slug: string,
    @Req() request: InboundWebhookRequest,
    @Headers('x-ci-signature') signature?: string,
    @Headers('x-ci-delivery') deliveryId?: string,
    @Headers('date') dateHeader?: string,
  ) {
    // One lookup. An unknown slug, a missing token and a bad signature all get
    // the same 401, so the route does not reveal which slugs exist.
    const target = await this.ciWebhookService.findInboundTarget(slug);
    if (!target || !this.verifySignature(signedBytesOf(request), signature ?? '', target.secret)) {
      throw new AuthException({}, 'ci_webhook');
    }

    // Validate only after the signature, and before the replay record, so an
    // invalid delivery does not consume its id.
    const payload = await parseInboundPayload(CiWebhookPayloadDto, request.body);

    // SEC-1: reject replayed deliveries; forget on failure so the sender's
    // retry with the same delivery id is accepted.
    await this.replayGuard.assertFresh({ projectId: target.projectId, source: 'ci', deliveryId, dateHeader });

    try {
      const result = await this.ciWebhookService.processCiWebhook(slug, payload);
      return JsonResponse.Ok(result);
    } catch (err) {
      await this.replayGuard.forget({ projectId: target.projectId, source: 'ci', deliveryId });
      throw err;
    }
  }

  private verifySignature(payload: string, signature: string, secret: string): boolean {
    try {
      const expectedSignature = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
      const expected = Buffer.from(expectedSignature);
      const received = Buffer.from(signature);

      if (expected.length !== received.length) {
        return false;
      }

      return timingSafeEqual(expected, received);
    } catch {
      return false;
    }
  }
}
```

- [ ] **Step 9: Run the CI tests to verify they pass**

Run: `cd apps/api && bun run test -- src/ci-webhook`
Expected: PASS (controller, service and module specs)

- [ ] **Step 10: Type-check**

Run: `cd apps/api && bun run type-check`
Expected: no errors. If a stray caller of `getWebhookSecret` / `resolveProject` shows up, it must move to `findInboundTarget`. At `8fc552bb` there is none.

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/ci-webhook
git commit -m "fix(track3-slice2b): CI webhook answers every miss with one 401 and validates after the signature"
```

---

### Task 3: VCS inbound lookup by slug

**Files:**
- Modify: `apps/api/src/vcs/domain/vcs.repository.ts` (the `// VcsConnection operations` block of `IVcsRepository`)
- Modify: `apps/api/src/vcs/prisma-vcs.repository.ts` (after `findVcsConnectionById`, line ~101)
- Modify: `apps/api/src/vcs/vcs-connection.service.ts` (after `getFullByProject`, line ~234)
- Modify: `apps/api/src/vcs/vcs-connection.service.spec.ts` (`createMockRepo` and a new `describe`)
- Create: `apps/api/test/integration/vcs/vcs-inbound-target.integration.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (used by Task 4):
  - `IVcsRepository.findVcsConnectionByProjectSlug(slug: string): Promise<VcsConnectionWithProjectDomain | null>`: null for an unknown slug, a soft-deleted project, or a project without a connection.
  - `VcsConnectionService.findInboundTarget(slug: string): Promise<VcsConnectionWithProjectDomain | null>`: never throws NotFound.

- [ ] **Step 1: Write the failing DB integration test**

Create `apps/api/test/integration/vcs/vcs-inbound-target.integration.spec.ts`:

```ts
/**
 * Track 3 Slice 2b: the inbound VCS webhook resolves its connection by project
 * slug in one query. Unknown slugs, soft-deleted projects and projects without a
 * connection all come back as null, so the controller can answer each with the
 * same 401.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- test/integration/vcs/vcs-inbound-target.integration.spec.ts
 */
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { ITransactionManager } from '@nathapp/nestjs-data';
import { PrismaVcsRepository } from '../../../src/vcs/prisma-vcs.repository';
import { resetDb } from '../../helpers/reset-db';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('PrismaVcsRepository.findVcsConnectionByProjectSlug (Slice 2b)', () => {
  jest.setTimeout(20000);
  let prismaService: PrismaService<PrismaClient>;
  let prisma: PrismaClient;
  let repo: PrismaVcsRepository;
  let liveProjectId: string;

  beforeAll(async () => {
    if (!DATABASE_URL) return;

    await resetDb(DATABASE_URL);

    prismaService = new PrismaService({
      client: PrismaClient,
      clientOptions: { datasources: { db: { url: DATABASE_URL } } },
    });
    await prismaService.onModuleInit();
    prisma = prismaService.client;

    // PrismaVcsRepository reads through PrismaService.client, never the tx client.
    const txManager: ITransactionManager = {
      run: <T>(fn: () => Promise<T>): Promise<T> => fn(),
      getClient: <C = unknown>(): C => prisma as unknown as C,
      isInTransaction: () => false,
    };
    repo = new PrismaVcsRepository(txManager, prismaService);

    const live = await prisma.project.create({ data: { name: 'Inbound Live', slug: 'inbound-live', key: 'INL' } });
    const deleted = await prisma.project.create({
      data: { name: 'Inbound Deleted', slug: 'inbound-deleted', key: 'IND', deletedAt: new Date() },
    });
    await prisma.project.create({ data: { name: 'Inbound Bare', slug: 'inbound-bare', key: 'INB' } });
    liveProjectId = live.id;

    for (const project of [live, deleted]) {
      await prisma.vcsConnection.create({
        data: {
          projectId: project.id,
          provider: 'github',
          repoOwner: 'owner',
          repoName: `repo-${project.key}`,
          encryptedToken: 'enc',
          syncMode: 'webhook',
          webhookSecret: `secret-${project.key}`,
        },
      });
    }
  });

  afterAll(async () => {
    if (prismaService) {
      await prismaService.onModuleDestroy();
    }
  });

  it('returns the connection with its project for a live project', async () => {
    const result = await repo.findVcsConnectionByProjectSlug('inbound-live');

    expect(result).not.toBeNull();
    expect(result!.projectId).toBe(liveProjectId);
    expect(result!.webhookSecret).toBe('secret-INL');
    expect(result!.syncMode).toBe('webhook');
    expect(result!.isActive).toBe(true);
    expect(result!.project).toEqual({ id: liveProjectId, key: 'INL', slug: 'inbound-live' });
  });

  it.each([
    ['an unknown slug', 'no-such-project'],
    ['a soft-deleted project', 'inbound-deleted'],
    ['a project without a VCS connection', 'inbound-bare'],
  ])('returns null for %s', async (_label, slug) => {
    await expect(repo.findVcsConnectionByProjectSlug(slug)).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:db:up && bun run test:integration -- test/integration/vcs/vcs-inbound-target.integration.spec.ts`
Expected: FAIL. `ts-jest` reports "Property 'findVcsConnectionByProjectSlug' does not exist on type 'PrismaVcsRepository'".

- [ ] **Step 3: Add the repository method**

In `apps/api/src/vcs/domain/vcs.repository.ts`, inside `IVcsRepository`, add after the `findVcsConnectionById` line:

```ts
  /** The connection of a live (not soft-deleted) project by slug; null for any miss. */
  findVcsConnectionByProjectSlug(slug: string): Promise<VcsConnectionWithProjectDomain | null>;
```

In `apps/api/src/vcs/prisma-vcs.repository.ts`, add after `findVcsConnectionById`:

```ts
  async findVcsConnectionByProjectSlug(slug: string): Promise<VcsConnectionWithProjectDomain | null> {
    const m = await this.db.vcsConnection.findFirst({
      where: { project: { slug, deletedAt: null } },
      include: { project: true },
    });
    return m ? this.toConnectionWithProjectDomain(m) : null;
  }
```

- [ ] **Step 4: Run the integration test to verify it passes**

Run: `cd apps/api && bun run test:integration -- test/integration/vcs/vcs-inbound-target.integration.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Write the failing service test**

In `apps/api/src/vcs/vcs-connection.service.spec.ts`:

1. In `createMockRepo()`, add after `findVcsConnectionById: jest.fn().mockResolvedValue(null),`:

```ts
    findVcsConnectionByProjectSlug: jest.fn().mockResolvedValue(null),
```

2. Add this `describe` block inside `describe('VcsConnectionService', ...)`, directly before `describe('create', ...)`:

```ts
  describe('findInboundTarget', () => {
    it('returns the connection with its project from the slug lookup', async () => {
      const target = { ...makeConnection({ syncMode: 'webhook' }), project: { id: 'proj-1', key: 'P', slug: 'p' } };
      mockRepo.findVcsConnectionByProjectSlug.mockResolvedValue(target);

      await expect(service.findInboundTarget('p')).resolves.toBe(target);
      expect(mockRepo.findVcsConnectionByProjectSlug).toHaveBeenCalledWith('p');
    });

    it('returns null instead of throwing NotFound when nothing matches', async () => {
      mockRepo.findVcsConnectionByProjectSlug.mockResolvedValue(null);

      await expect(service.findInboundTarget('missing')).resolves.toBeNull();
    });
  });
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd apps/api && bun run test -- src/vcs/vcs-connection.service.spec.ts`
Expected: FAIL with "service.findInboundTarget is not a function"

- [ ] **Step 7: Implement `findInboundTarget`**

In `apps/api/src/vcs/vcs-connection.service.ts`, change the domain import (line 3) to:

```ts
import type { VcsConnectionDomain, VcsConnectionWithProjectDomain } from './domain/vcs.domain';
```

and add after `getFullByProject`:

```ts
  /**
   * The connection (with its project) that receives inbound webhooks for
   * `slug`, or null when the slug is unknown, the project is soft-deleted, or it
   * has no connection. Never throws NotFound: the webhook route answers every
   * miss with the same 401.
   */
  async findInboundTarget(slug: string): Promise<VcsConnectionWithProjectDomain | null> {
    return this.vcsRepo.findVcsConnectionByProjectSlug(slug);
  }
```

- [ ] **Step 8: Run the VCS unit tests and type-check**

Run: `cd apps/api && bun run test -- src/vcs && bun run type-check`
Expected: PASS, no type errors. Other mocks typed `jest.Mocked<IVcsRepository>` are built with an `as` cast, so they compile without the new member.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/vcs/domain/vcs.repository.ts apps/api/src/vcs/prisma-vcs.repository.ts \
  apps/api/src/vcs/vcs-connection.service.ts apps/api/src/vcs/vcs-connection.service.spec.ts \
  apps/api/test/integration/vcs/vcs-inbound-target.integration.spec.ts
git commit -m "feat(track3-slice2b): resolve the inbound VCS connection by slug in one query"
```

---

### Task 4: VCS webhook: one 401, connection-state gate, no `@Body()`

**Files:**
- Modify: `apps/api/src/vcs/vcs-webhook.controller.ts` (whole file)
- Rewrite: `apps/api/src/vcs/vcs-webhook.controller.spec.ts`
- Modify: `apps/api/test/integration/vcs/vcs-webhook.integration.spec.ts`
- Modify: `apps/api/test/integration/vcs/vcs-webhook-pull-request.integration.spec.ts`

**Interfaces:**
- Consumes: Task 1 `InboundWebhookRequest`, `signedBytesOf`; Task 3 `VcsConnectionService.findInboundTarget(slug)`.
- Produces: `VcsWebhookController.handleWebhook(slug: string, signature: string, request: InboundWebhookRequest, githubEvent?: string, deliveryId?: string, dateHeader?: string): Promise<WebhookHandleResult>`. The payload argument is gone, and the controller no longer injects `ProjectsService`.
- Ignore reasons (exact strings, asserted by tests): `'VCS connection is inactive'` and `` `VCS connection syncMode is '${syncMode}'; webhook deliveries are processed only in 'webhook' mode` ``.

- [ ] **Step 1: Rewrite the controller spec (failing)**

Replace the whole of `apps/api/src/vcs/vcs-webhook.controller.spec.ts` with:

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { AuthException } from '@nathapp/nestjs-common';
import { VcsWebhookController } from './vcs-webhook.controller';
import { VcsConnectionService } from './vcs-connection.service';
import { VcsWebhookService, GitHubWebhookPayload } from './vcs-webhook.service';
import { WebhookReplayGuard } from '../webhook-security/webhook-replay.guard';
import type { InboundWebhookRequest } from '../webhook-security/inbound-webhook-request';
import type { VcsConnectionWithProjectDomain } from './domain/vcs.domain';

function makeTarget(overrides?: Partial<VcsConnectionWithProjectDomain>): VcsConnectionWithProjectDomain {
  return {
    id: 'conn-1',
    projectId: 'proj-1',
    provider: 'github',
    repoOwner: 'owner',
    repoName: 'repo',
    encryptedToken: 'enc-token',
    syncMode: 'webhook',
    allowedAuthors: '[]',
    pollingIntervalMs: 600000,
    webhookSecret: 'super-secret-webhook-key',
    lastSyncedAt: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    project: { id: 'proj-1', key: 'TEST', slug: 'test-project' },
    ...overrides,
  };
}

function makePushPayload(overrides?: Partial<GitHubWebhookPayload>): GitHubWebhookPayload {
  return {
    action: '',
    repository: {
      id: 12345,
      full_name: 'owner/repo',
      name: 'repo',
      owner: { login: 'owner', id: 1 },
    },
    ref: 'refs/heads/main',
    commits: [
      {
        id: 'abc123',
        message: 'fix: bug',
        timestamp: '2024-01-01T00:00:00Z',
        author: { name: 'Dev', email: 'dev@example.com', username: 'dev' },
        added: [],
        removed: [],
        modified: [],
      },
    ],
    sender: { id: 1, login: 'dev', type: 'User' },
    ...overrides,
  };
}

/** A Fastify-shaped request: the raw bytes the sender signed plus the parsed body. */
function makeRequest(body: unknown, rawBody: string = JSON.stringify(body)): InboundWebhookRequest {
  return { rawBody: Buffer.from(rawBody), body };
}

async function rejectionOf(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (err) {
    return err as HttpException;
  }
  throw new Error('expected the call to reject');
}

describe('VcsWebhookController', () => {
  let controller: VcsWebhookController;
  let mockVcsConnectionService: jest.Mocked<Pick<VcsConnectionService, 'findInboundTarget'>>;
  let mockWebhookService: jest.Mocked<Pick<VcsWebhookService, 'verifySignature' | 'handleWebhook'>>;
  let mockReplayGuard: { assertFresh: jest.Mock; forget: jest.Mock };

  beforeEach(async () => {
    mockVcsConnectionService = {
      findInboundTarget: jest.fn().mockResolvedValue(makeTarget()),
    };

    mockWebhookService = {
      verifySignature: jest.fn().mockReturnValue(true),
      handleWebhook: jest.fn().mockResolvedValue({ success: true }),
    };

    mockReplayGuard = {
      assertFresh: jest.fn().mockResolvedValue(undefined),
      forget: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [VcsWebhookController],
      providers: [
        { provide: VcsConnectionService, useValue: mockVcsConnectionService },
        { provide: VcsWebhookService, useValue: mockWebhookService },
        { provide: WebhookReplayGuard, useValue: mockReplayGuard },
      ],
    }).compile();

    controller = module.get<VcsWebhookController>(VcsWebhookController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  /** The 401 a caller gets for a bad signature on an existing connection: the reference shape. */
  async function badSignatureRejection(): Promise<HttpException> {
    mockWebhookService.verifySignature.mockReturnValueOnce(false);
    return rejectionOf(controller.handleWebhook('test-project', 'sha256=bad', makeRequest(makePushPayload()), 'push'));
  }

  describe('happy path', () => {
    it('resolves the connection by slug in one lookup and forwards a valid push webhook', async () => {
      const payload = makePushPayload();
      const request = makeRequest(payload);

      const result = await controller.handleWebhook('test-project', 'sha256=valid-signature', request, 'push');

      expect(mockVcsConnectionService.findInboundTarget).toHaveBeenCalledTimes(1);
      expect(mockVcsConnectionService.findInboundTarget).toHaveBeenCalledWith('test-project');
      expect(mockWebhookService.verifySignature).toHaveBeenCalledWith(
        request.rawBody!.toString('utf8'),
        'sha256=valid-signature',
        'super-secret-webhook-key',
      );
      expect(mockWebhookService.handleWebhook).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'conn-1', project: expect.objectContaining({ id: 'proj-1' }) }),
        'push',
        payload,
      );
      expect(result).toEqual({ success: true });
    });

    it('verifies against the raw request body bytes, not JSON.stringify of the parsed body (KODA-02)', async () => {
      const canonicalJson = '{"action":"","ref":"refs/heads/main","commits":[]}';
      const payload = makePushPayload({ commits: [] });

      await controller.handleWebhook('test-project', 'sha256=sig', makeRequest(payload, canonicalJson), 'push');

      expect(mockWebhookService.verifySignature).toHaveBeenCalledWith(
        canonicalJson,
        'sha256=sig',
        'super-secret-webhook-key',
      );
      const calledWith = mockWebhookService.verifySignature.mock.calls[0]?.[0] ?? '';
      expect(calledWith).not.toBe(JSON.stringify(payload));
    });

    it('falls back to JSON.stringify(body) when rawBody is absent (Express test setups)', async () => {
      const payload = makePushPayload();

      await controller.handleWebhook('test-project', 'sha256=sig', { body: payload }, 'push');

      expect(mockWebhookService.verifySignature).toHaveBeenCalledWith(
        JSON.stringify(payload),
        'sha256=sig',
        'super-secret-webhook-key',
      );
    });

    it('treats a signed non-object body as an empty payload instead of crashing', async () => {
      await controller.handleWebhook('test-project', 'sha256=sig', makeRequest(null, 'null'), undefined);

      expect(mockWebhookService.handleWebhook).toHaveBeenCalledWith(expect.anything(), 'unknown', {});
    });
  });

  describe('every inbound auth failure is the same 401 (no slug enumeration)', () => {
    it('a bad signature is an AuthException 401 and processes nothing', async () => {
      const err = await badSignatureRejection();

      expect(err).toBeInstanceOf(AuthException);
      expect(err.getStatus()).toBe(401);
      expect(mockWebhookService.handleWebhook).not.toHaveBeenCalled();
      expect(mockReplayGuard.assertFresh).not.toHaveBeenCalled();
    });

    it.each([
      ['an unknown slug, a deleted project, or no connection', null],
      ['a connection without a webhook secret', makeTarget({ webhookSecret: null })],
      ['a connection with an empty-string webhook secret', makeTarget({ webhookSecret: '' })],
    ])('%s gets the identical 401', async (_label, target) => {
      const reference = await badSignatureRejection();
      mockVcsConnectionService.findInboundTarget.mockResolvedValueOnce(target);

      const err = await rejectionOf(
        controller.handleWebhook('test-project', 'sha256=sig', makeRequest(makePushPayload()), 'push'),
      );

      expect(err).toBeInstanceOf(AuthException);
      expect(err.getStatus()).toBe(401);
      expect(err.getResponse()).toEqual(reference.getResponse());
      expect(mockWebhookService.handleWebhook).not.toHaveBeenCalled();
    });
  });

  describe('connection-state gate', () => {
    it('returns 200 { ignored } for an inactive connection without processing or recording the delivery', async () => {
      mockVcsConnectionService.findInboundTarget.mockResolvedValueOnce(makeTarget({ isActive: false }));

      const result = await controller.handleWebhook(
        'test-project', 'sha256=sig', makeRequest(makePushPayload()), 'push', 'delivery-1',
      );

      expect(result).toEqual({ success: true, ignored: true, reason: 'VCS connection is inactive' });
      expect(mockWebhookService.handleWebhook).not.toHaveBeenCalled();
      expect(mockReplayGuard.assertFresh).not.toHaveBeenCalled();
    });

    it.each(['off', 'polling'])("returns 200 { ignored } when syncMode is '%s'", async (syncMode) => {
      mockVcsConnectionService.findInboundTarget.mockResolvedValueOnce(makeTarget({ syncMode }));

      const result = await controller.handleWebhook(
        'test-project', 'sha256=sig', makeRequest(makePushPayload()), 'push', 'delivery-1',
      );

      expect(result).toEqual({
        success: true,
        ignored: true,
        reason: `VCS connection syncMode is '${syncMode}'; webhook deliveries are processed only in 'webhook' mode`,
      });
      expect(mockWebhookService.handleWebhook).not.toHaveBeenCalled();
      expect(mockReplayGuard.assertFresh).not.toHaveBeenCalled();
    });

    it.each([
      ['an inactive connection', makeTarget({ isActive: false })],
      ['a polling connection', makeTarget({ syncMode: 'polling' })],
    ])('checks the signature first: %s with a bad signature is the 401, not the ignored 200', async (_label, target) => {
      mockVcsConnectionService.findInboundTarget.mockResolvedValueOnce(target);
      mockWebhookService.verifySignature.mockReturnValueOnce(false);

      await expect(
        controller.handleWebhook('test-project', 'sha256=bad', makeRequest(makePushPayload()), 'push'),
      ).rejects.toThrow(AuthException);
    });
  });

  describe('event type', () => {
    it('infers "issues.opened" from the payload when the x-github-event header is absent', async () => {
      const issuePayload: GitHubWebhookPayload = {
        action: 'opened',
        issue: { number: 1, title: 'Bug', body: null, user: { login: 'dev' }, html_url: 'url', labels: [], created_at: '' },
        repository: { id: 1, full_name: 'owner/repo', name: 'repo', owner: { login: 'owner', id: 1 } },
        sender: { id: 1, login: 'dev', type: 'User' },
      };

      await controller.handleWebhook('test-project', 'sha256=sig', makeRequest(issuePayload), undefined);

      expect(mockWebhookService.handleWebhook).toHaveBeenCalledWith(expect.anything(), 'issues.opened', issuePayload);
    });

    it('passes the x-github-event header as the event type when provided', async () => {
      const payload = makePushPayload();

      await controller.handleWebhook('test-project', 'sha256=sig', makeRequest(payload), 'ping');

      expect(mockWebhookService.handleWebhook).toHaveBeenCalledWith(expect.anything(), 'ping', payload);
    });

    it('infers "pull_request" when the payload has pull_request and no header', async () => {
      const prPayload: GitHubWebhookPayload = {
        action: 'opened',
        pull_request: {
          number: 1,
          title: 'PR title',
          state: 'open',
          draft: false,
          merged: false,
          merged_at: null,
          merged_by: null,
          merge_commit_sha: null,
          html_url: 'url',
          head: { ref: 'feature/branch', repo: { full_name: 'owner/repo' } },
          base: { ref: 'main', repo: { full_name: 'owner/repo' } },
          user: { login: 'dev' },
          body: null,
        },
        repository: { id: 1, full_name: 'owner/repo', name: 'repo', owner: { login: 'owner', id: 1 } },
        sender: { id: 1, login: 'dev', type: 'User' },
      };

      await controller.handleWebhook('test-project', 'sha256=sig', makeRequest(prPayload), undefined);

      expect(mockWebhookService.handleWebhook).toHaveBeenCalledWith(expect.anything(), 'pull_request', prPayload);
    });
  });

  describe('replay protection (SEC-1)', () => {
    it('passes the delivery id and the resolved project id to the replay guard', async () => {
      await controller.handleWebhook(
        'test-project', 'sha256=sig', makeRequest(makePushPayload()), 'push', 'delivery-uuid-001',
      );

      expect(mockReplayGuard.assertFresh).toHaveBeenCalledWith({
        projectId: 'proj-1',
        source: 'github',
        deliveryId: 'delivery-uuid-001',
        dateHeader: undefined,
      });
    });

    it('propagates 409 when the delivery is a replay and skips processing', async () => {
      mockReplayGuard.assertFresh.mockRejectedValueOnce(new HttpException('Webhook already processed', 409));

      await expect(
        controller.handleWebhook('test-project', 'sha256=sig', makeRequest(makePushPayload()), 'push', 'delivery-dup'),
      ).rejects.toMatchObject({ status: 409 });

      expect(mockWebhookService.handleWebhook).not.toHaveBeenCalled();
    });

    it('forgets the delivery when processing throws so GitHub retries are accepted', async () => {
      mockWebhookService.handleWebhook.mockRejectedValueOnce(new Error('db down'));

      await expect(
        controller.handleWebhook('test-project', 'sha256=sig', makeRequest(makePushPayload()), 'push', 'delivery-retry-1'),
      ).rejects.toThrow('db down');

      expect(mockReplayGuard.forget).toHaveBeenCalledWith({
        projectId: 'proj-1',
        source: 'github',
        deliveryId: 'delivery-retry-1',
      });
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test -- src/vcs/vcs-webhook.controller.spec.ts`
Expected: FAIL. The controller still injects `ProjectsService`, which this module does not provide ("Nest can't resolve dependencies of the VcsWebhookController").

- [ ] **Step 3: Rewrite the controller**

Replace the whole of `apps/api/src/vcs/vcs-webhook.controller.ts` with:

```ts
import { Controller, Headers, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '@nathapp/nestjs-auth';
import { AuthException } from '@nathapp/nestjs-common';
import { VcsConnectionService } from './vcs-connection.service';
import { VcsWebhookService, GitHubWebhookPayload, WebhookHandleResult } from './vcs-webhook.service';
import { WebhookReplayGuard } from '../webhook-security/webhook-replay.guard';
import { InboundWebhookRequest, signedBytesOf } from '../webhook-security/inbound-webhook-request';
import type { VcsConnectionWithProjectDomain } from './domain/vcs.domain';

@ApiTags('vcs')
@Controller()
export class VcsWebhookController {
  constructor(
    private readonly vcsConnectionService: VcsConnectionService,
    private readonly webhookService: VcsWebhookService,
    private readonly replayGuard: WebhookReplayGuard,
  ) {}

  @Post('/projects/:slug/vcs-webhook')
  @HttpCode(HttpStatus.OK)
  @Public()
  @ApiOperation({ summary: 'Receive GitHub VCS issue webhook' })
  @ApiResponse({
    status: 200,
    description: 'Webhook processed, or ignored because the connection is inactive or not in webhook sync mode',
  })
  @ApiResponse({ status: 401, description: 'Unknown project, no VCS connection or webhook secret, or invalid signature' })
  async handleWebhook(
    @Param('slug') slug: string,
    @Headers('x-hub-signature-256') signature: string,
    @Req() request: InboundWebhookRequest,
    @Headers('x-github-event') githubEvent?: string,
    @Headers('x-github-delivery') deliveryId?: string,
    @Headers('date') dateHeader?: string,
  ): Promise<WebhookHandleResult> {
    // One lookup. An unknown slug, a missing connection or secret, and a bad
    // signature all get the same 401, so the route does not reveal which slugs
    // exist or which projects have a VCS connection.
    const connection = await this.vcsConnectionService.findInboundTarget(slug);
    if (
      !connection?.webhookSecret ||
      !this.webhookService.verifySignature(signedBytesOf(request), signature || '', connection.webhookSecret)
    ) {
      throw new AuthException({}, 'vcs_webhook');
    }

    // After the signature, so an unsigned caller cannot learn the connection
    // state. 200, not 4xx: GitHub retries non-2xx deliveries.
    const ignoreReason = this.ignoreReasonFor(connection);
    if (ignoreReason) {
      return { success: true, ignored: true, reason: ignoreReason };
    }

    const payload = (request.body !== null && typeof request.body === 'object' ? request.body : {}) as GitHubWebhookPayload;

    // SEC-1: reject replayed deliveries; forget on failure so GitHub's retry
    // with the same X-GitHub-Delivery id is accepted.
    await this.replayGuard.assertFresh({ projectId: connection.projectId, source: 'github', deliveryId, dateHeader });

    const eventType = githubEvent
      || (payload.pull_request ? 'pull_request' : payload.issue ? 'issues' : 'unknown');
    const event = eventType === 'issues'
      ? `issues.${payload.action || 'unknown'}`
      : eventType;

    try {
      return await this.webhookService.handleWebhook(connection, event, payload);
    } catch (err) {
      await this.replayGuard.forget({ projectId: connection.projectId, source: 'github', deliveryId });
      throw err;
    }
  }

  private ignoreReasonFor(connection: VcsConnectionWithProjectDomain): string | null {
    if (!connection.isActive) {
      return 'VCS connection is inactive';
    }
    if (connection.syncMode !== 'webhook') {
      return `VCS connection syncMode is '${connection.syncMode}'; webhook deliveries are processed only in 'webhook' mode`;
    }
    return null;
  }
}
```

- [ ] **Step 4: Run the controller spec to verify it passes**

Run: `cd apps/api && bun run test -- src/vcs/vcs-webhook.controller.spec.ts`
Expected: PASS

- [ ] **Step 5: Codemod the two mock-based integration specs**

Both files call `controller.handleWebhook(<slug>, <signature>, <payload>, webhookRequest(<payload>), ...)` at every call site (54 calls, verified at `8fc552bb`). Drop the third argument:

```bash
cd apps/api
perl -0pi -e 's/(controller\.handleWebhook\(\s*[^,()]+,\s*[^,()]+,)\s*[^,()]+,(\s*webhookRequest\()/$1$2/g' \
  test/integration/vcs/vcs-webhook.integration.spec.ts \
  test/integration/vcs/vcs-webhook-pull-request.integration.spec.ts
grep -c "controller.handleWebhook(" test/integration/vcs/vcs-webhook.integration.spec.ts test/integration/vcs/vcs-webhook-pull-request.integration.spec.ts
perl -0ne 'print "LEFTOVER: $&\n" while /controller\.handleWebhook\(\s*[^,()]+,\s*[^,()]+,\s*[^,()]+,\s*webhookRequest\(/g' \
  test/integration/vcs/vcs-webhook.integration.spec.ts test/integration/vcs/vcs-webhook-pull-request.integration.spec.ts
```

Expected: the call counts are 25 and 29, and no `LEFTOVER` lines are printed.

- [ ] **Step 6: Carry the body on the request helper (both files)**

In both `test/integration/vcs/vcs-webhook.integration.spec.ts` and `test/integration/vcs/vcs-webhook-pull-request.integration.spec.ts`, replace the `webhookRequest` helper with:

```ts
  function webhookRequest(payload: unknown): { rawBody: Buffer; body: unknown } {
    return { rawBody: Buffer.from(JSON.stringify(payload), 'utf8'), body: payload };
  }
```

- [ ] **Step 7: Point the mocks at `findInboundTarget` in `vcs-webhook.integration.spec.ts`**

1. Directly after the `const webhookSecret = mockVcsConnection.webhookSecret;` line, add:

```ts
  const mockTarget = {
    ...mockVcsConnection,
    project: { id: mockProject.id, key: mockProject.key, slug: mockProject.slug },
  };
```

2. In `resetMocks()`, add `connectionService?.findInboundTarget.mockClear();` after the `getFullByProject.mockClear()` line, and add `connectionService.findInboundTarget.mockResolvedValue(mockTarget as any);` after the `getFullByProject.mockResolvedValue(...)` line.

3. In `mockVcsServiceInstance` (in `beforeEach`), add:

```ts
      findInboundTarget: jest.fn().mockResolvedValue(mockTarget),
```

4. Replace the two tests `'should handle project not found error'` and `'should handle VCS connection not found'` with:

```ts
    it('answers an unknown slug (or deleted project, or no connection) with the same 401 as a bad signature', async () => {
      const payload = createGitHubPayload({ action: 'opened' });
      const validSignature = calculateSignature(JSON.stringify(payload));

      webhookService.verifySignature.mockReturnValue(false);
      const badSignature = await controller
        .handleWebhook(mockProject.slug, validSignature, webhookRequest(payload))
        .catch((err: AuthException) => err);

      webhookService.verifySignature.mockReturnValue(true);
      connectionService.findInboundTarget.mockResolvedValue(null);
      const unknownSlug = await controller
        .handleWebhook('no-such-project', validSignature, webhookRequest(payload))
        .catch((err: AuthException) => err);

      expect(unknownSlug).toBeInstanceOf(AuthException);
      expect((unknownSlug as AuthException).getResponse()).toEqual((badSignature as AuthException).getResponse());
      expect(webhookService.handleWebhook).not.toHaveBeenCalled();
    });
```

5. In `'should handle complete webhook flow: ...'`, replace the two lines

```ts
      expect(projectsService.findBySlug).toHaveBeenCalledWith(mockProject.slug);
      expect(connectionService.getFullByProject).toHaveBeenCalledWith(mockProject.id);
```

with

```ts
      expect(connectionService.findInboundTarget).toHaveBeenCalledWith(mockProject.slug);
```

6. If `NotFoundAppException` is now unused in the file, remove it from the `@nathapp/nestjs-common` import (lint `--max-warnings=0` flags unused imports).

- [ ] **Step 8: Point the mock at `findInboundTarget` in `vcs-webhook-pull-request.integration.spec.ts`**

In the `VcsConnectionService` `useValue` (in `beforeEach`), add after `getFullByProject: ...`:

```ts
            findInboundTarget: jest.fn().mockResolvedValue({
              ...mockVcsConnection,
              project: { id: mockProject.id, key: mockProject.key, slug: mockProject.slug },
            }),
```

- [ ] **Step 9: Run the VCS webhook specs**

These two files are mock-based. They sit under `test/integration`, so only `test:integration` picks them up, and they need no database rows.

Run: `cd apps/api && bun run test:integration -- test/integration/vcs/vcs-webhook.integration.spec.ts test/integration/vcs/vcs-webhook-pull-request.integration.spec.ts`
Expected: PASS. If a test fails because it expected a `NotFoundAppException`, a lookup through `ProjectsService`, or a positional payload argument, change it to the new contract (one `findInboundTarget` lookup, `AuthException` for every miss). Do not revert the controller.

- [ ] **Step 10: Run all VCS unit tests, lint and type-check**

Run: `cd apps/api && bun run test -- src/vcs && bun run lint && bun run type-check`
Expected: PASS, 0 lint warnings, no type errors.

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/vcs/vcs-webhook.controller.ts apps/api/src/vcs/vcs-webhook.controller.spec.ts \
  apps/api/test/integration/vcs/vcs-webhook.integration.spec.ts \
  apps/api/test/integration/vcs/vcs-webhook-pull-request.integration.spec.ts
git commit -m "fix(track3-slice2b): VCS webhook answers every miss with one 401 and honours isActive/syncMode"
```

---

### Task 5: Scope `DELETE projects/:slug/webhooks/:id` to its project

**Files:**
- Modify: `apps/api/src/webhook/webhook.service.ts` (after `remove`, line ~84)
- Modify: `apps/api/src/webhook/webhook.service.spec.ts` (the `describe('remove', ...)` block, line ~386)
- Modify: `apps/api/src/webhook/webhook.controller.ts:68-86`
- Modify: `apps/api/test/integration/webhook/webhook-routes.integration.spec.ts` (append tests)

**Interfaces:**
- Consumes: the existing `WebhookService.getProjectBySlug(slug): Promise<{ id: string }>` (throws `NotFoundAppException(..., 'webhooks')` for an unknown or deleted slug).
- Produces: `WebhookService.removeForProject(projectId: string, id: string): Promise<void>`. `WebhookService.remove(id)` stays for the slug-less admin route.

- [ ] **Step 1: Write the failing service test**

In `apps/api/src/webhook/webhook.service.spec.ts`, add directly after the `describe('remove', ...)` block:

```ts
  describe('removeForProject', () => {
    it("deletes the project's own webhook", async () => {
      webhookRepo.findById.mockResolvedValue(mockWebhook);
      webhookRepo.deleteWebhook.mockResolvedValue(mockWebhook);

      await service.removeForProject('proj-1', 'wh-1');

      expect(webhookRepo.deleteWebhook).toHaveBeenCalledWith('wh-1');
    });

    it("throws NotFoundAppException for another project's webhook and deletes nothing", async () => {
      webhookRepo.findById.mockResolvedValue(mockWebhook);

      await expect(service.removeForProject('proj-other', 'wh-1')).rejects.toThrow(NotFoundAppException);
      expect(webhookRepo.deleteWebhook).not.toHaveBeenCalled();
    });

    it('throws NotFoundAppException when the webhook does not exist', async () => {
      webhookRepo.findById.mockResolvedValue(null);

      await expect(service.removeForProject('proj-1', 'wh-missing')).rejects.toThrow(NotFoundAppException);
      expect(webhookRepo.deleteWebhook).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test -- src/webhook/webhook.service.spec.ts`
Expected: FAIL with "service.removeForProject is not a function"

- [ ] **Step 3: Implement `removeForProject`**

In `apps/api/src/webhook/webhook.service.ts`, add directly after `remove`:

```ts
  /** Deletes a project's webhook. Another project's webhook is a 404, as in `update`. */
  async removeForProject(projectId: string, id: string): Promise<void> {
    const webhook = await this.webhookRepo.findById(id);
    if (!webhook || webhook.projectId !== projectId) {
      throw new NotFoundAppException({}, 'webhooks');
    }
    await this.webhookRepo.deleteWebhook(id);
  }
```

- [ ] **Step 4: Run the service test to verify it passes**

Run: `cd apps/api && bun run test -- src/webhook/webhook.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Write the failing HTTP integration tests**

Append these tests inside the `describeIntegration('webhook routes over HTTP (US-003)', ...)` block of `apps/api/test/integration/webhook/webhook-routes.integration.spec.ts`, after the last `it(...)`:

```ts
  it("Slice 2b: DELETE projects/:slug/webhooks/:id of another project's webhook returns 404 and keeps the row", async () => {
    const id = await registerWebhook(projectBSlug, OTHER_ALLOWED_URL);

    const res = await request(httpServer)
      .delete(`/api/projects/${projectASlug}/webhooks/${id}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
    expect(await prisma.client.webhook.findUnique({ where: { id } })).not.toBeNull();
  });

  it("Slice 2b: DELETE projects/:slug/webhooks/:id of the project's own webhook returns 204 and removes the row", async () => {
    const id = await registerWebhook(projectASlug, ALLOWED_URL);

    await request(httpServer)
      .delete(`/api/projects/${projectASlug}/webhooks/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);

    expect(await prisma.client.webhook.findUnique({ where: { id } })).toBeNull();
  });

  it('Slice 2b: DELETE projects/:slug/webhooks/:id under an unknown slug returns 404 and keeps the row', async () => {
    const id = await registerWebhook(projectASlug, ALLOWED_URL);

    const res = await request(httpServer)
      .delete(`/api/projects/no-such-project/webhooks/${id}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
    expect(await prisma.client.webhook.findUnique({ where: { id } })).not.toBeNull();
  });

  it('Slice 2b: slug-less DELETE webhooks/:id stays the global-ADMIN cross-project route', async () => {
    const id = await registerWebhook(projectBSlug, OTHER_ALLOWED_URL);

    const asMember = await request(httpServer)
      .delete(`/api/webhooks/${id}`)
      .set('Authorization', `Bearer ${memberToken}`);
    expect(asMember.status).toBe(403);
    expect(await prisma.client.webhook.findUnique({ where: { id } })).not.toBeNull();

    await request(httpServer)
      .delete(`/api/webhooks/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);
    expect(await prisma.client.webhook.findUnique({ where: { id } })).toBeNull();
  });
```

- [ ] **Step 6: Run them to verify the cross-project case fails**

Run: `cd apps/api && bun run test:integration -- test/integration/webhook/webhook-routes.integration.spec.ts`
Expected: FAIL on the first new test only (`expected 404, received 204`). The route ignores `:slug`, so it deletes project B's row. The other three new tests pass already.

- [ ] **Step 7: Scope the controller route**

In `apps/api/src/webhook/webhook.controller.ts`, replace the two `@Delete` handlers (lines 68-86) with:

```ts
  /** Deliberate cross-project admin route (global ADMIN only); see the project-scoped route below. */
  @Delete('webhooks/:id')
  @HttpCode(204)
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Remove a webhook' })
  @ApiResponse({ status: 204, description: 'Webhook deleted' })
  @ApiResponse({ status: 404, description: 'Webhook not found' })
  async remove(@Param('id') id: string) {
    await this.webhookService.remove(id);
  }

  @Delete('projects/:slug/webhooks/:id')
  @HttpCode(204)
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Remove a webhook (project-scoped)' })
  @ApiResponse({ status: 204, description: 'Webhook deleted' })
  @ApiResponse({ status: 404, description: 'Project or webhook not found, or the webhook belongs to another project' })
  async removeByProject(@Param('slug') slug: string, @Param('id') id: string) {
    const project = await this.webhookService.getProjectBySlug(slug);
    await this.webhookService.removeForProject(project.id, id);
  }
```

- [ ] **Step 8: Run the webhook tests to verify they pass**

Run: `cd apps/api && bun run test -- src/webhook && bun run test:integration -- test/integration/webhook/webhook-routes.integration.spec.ts`
Expected: PASS (unit and HTTP integration)

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/webhook/webhook.service.ts apps/api/src/webhook/webhook.service.spec.ts \
  apps/api/src/webhook/webhook.controller.ts apps/api/test/integration/webhook/webhook-routes.integration.spec.ts
git commit -m "fix(track3-slice2b): scope DELETE projects/:slug/webhooks/:id to its project"
```

---

### Task 6: End-to-end expectations, contract regeneration, full verification

**Files:**
- Modify: `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` (the VCS webhook test at line ~1799; the `describe('CI Webhooks', ...)` block at lines ~1963-2055)
- Regenerate: `openapi.json`, `apps/cli/src/generated/**`

**Interfaces:**
- Consumes: the behaviour from Tasks 2, 4 and 5 over real HTTP with the real global pipes and filters.
- Produces: nothing downstream.

- [ ] **Step 1: Update the e2e expectations (failing against the old behaviour, passing against the new)**

In `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts`:

1. Replace the test `'POST /api/projects/:slug/vcs-webhook — returns 404 when project has no VCS connection'` with:

```ts
    it('POST /api/projects/:slug/vcs-webhook — no VCS connection and an unknown slug get the same 401', async () => {
      const noConnection = await request(httpServer)
        .post(`/api/projects/${projectSlug}/vcs-webhook`)
        .set('x-github-event', 'push')
        .set('x-hub-signature-256', 'sha256=invalid')
        .send({ action: 'push', ref: 'refs/heads/main' })
        .expect(401);

      const unknownSlug = await request(httpServer)
        .post('/api/projects/no-such-project/vcs-webhook')
        .set('x-github-event', 'push')
        .set('x-hub-signature-256', 'sha256=invalid')
        .send({ action: 'push', ref: 'refs/heads/main' })
        .expect(401);

      expect(unknownSlug.body).toEqual(noConnection.body);
    });
```

2. In `describe('CI Webhooks', ...)`, replace the two tests `'... returns 400 for invalid payload'` and `'... returns 404 for nonexistent project'` with:

```ts
    it('POST /api/projects/:slug/ci-webhook — an unsigned invalid payload gets 401, not a validation error', async () => {
      await request(httpServer)
        .post(`/api/projects/${projectSlug}/ci-webhook`)
        .send({
          event: 'invalid_event',
          pipeline: { id: '12345' },
          commit: { sha: 'abc123' },
          failures: [],
        })
        .expect(401);
    });

    it('POST /api/projects/:slug/ci-webhook — a signed invalid payload returns 400 and creates no ticket', async () => {
      const prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
      const project = await prisma.client.project.findUniqueOrThrow({ where: { slug: projectSlug } });
      const ticketsBefore = await prisma.client.ticket.count({ where: { projectId: project.id } });
      const payload = {
        event: 'pipeline_failed',
        pipeline: { id: '12347' },
        commit: { sha: 'abc123def458' },
        failures: [{ test: 'LineZero', line: 0 }],
      };
      const signature = `sha256=${createHmac('sha256', ciWebhookSecret).update(JSON.stringify(payload)).digest('hex')}`;

      await request(httpServer)
        .post(`/api/projects/${projectSlug}/ci-webhook`)
        .set('x-ci-signature', signature)
        .set('x-ci-delivery', 'e2e-ci-delivery-invalid')
        .send(payload)
        .expect(400);

      expect(await prisma.client.ticket.count({ where: { projectId: project.id } })).toBe(ticketsBefore);
    });

    it('POST /api/projects/:slug/ci-webhook — unknown slug, missing signature and bad signature get the same 401', async () => {
      const payload = {
        event: 'pipeline_failed',
        pipeline: { id: '99999' },
        commit: { sha: 'deadbeef' },
        failures: [{ test: 'AlwaysFail' }],
      };
      const signature = `sha256=${createHmac('sha256', ciWebhookSecret).update(JSON.stringify(payload)).digest('hex')}`;

      const unknownSlug = await request(httpServer)
        .post('/api/projects/nonexistent/ci-webhook')
        .set('x-ci-signature', signature)
        .send(payload)
        .expect(401);
      const unsigned = await request(httpServer)
        .post(`/api/projects/${projectSlug}/ci-webhook`)
        .send(payload)
        .expect(401);
      const badSignature = await request(httpServer)
        .post(`/api/projects/${projectSlug}/ci-webhook`)
        .set('x-ci-signature', `sha256=${'0'.repeat(64)}`)
        .send(payload)
        .expect(401);

      expect(unknownSlug.body).toEqual(badSignature.body);
      expect(unsigned.body).toEqual(badSignature.body);
    });
```

(`PrismaService`, `PrismaClient` and `createHmac` are already imported by this file: the CI `beforeAll` and the signed tests use them.)

- [ ] **Step 2: Run the affected e2e tests**

Run: `cd apps/api && bun run test:integration -- test/e2e/api-endpoint/endpoint.e2e.spec.ts -t "webhook"`
Expected: PASS for every `vcs-webhook` / `ci-webhook` test, including the pre-existing "creates ticket on pipeline failure" and "rejects a replayed delivery with 409". If an unrelated test in the filtered set fails with 429 (the known local login-throttle cascade from #150), re-run that test alone before treating it as a regression.

- [ ] **Step 3: Regenerate the contract**

Run (repo root): `bun run generate`
Then: `git diff --stat openapi.json apps/cli/src/generated`
Expected: changes only to the `ci-webhook` operation (response `404` becomes `401`; `400` description; `requestBody` still `$ref: CiWebhookPayloadDto`), `CiFailureDto.line` (`type: integer`, `minimum: 1`), the `vcs-webhook` `200`/`401` descriptions, the project-scoped webhook DELETE `404` description, and the matching regenerated CLI types. If `requestBody` disappeared from the `ci-webhook` operation, the `@ApiBody({ type: CiWebhookPayloadDto })` decorator is missing.

- [ ] **Step 4: Run the full API gate**

Run:
```bash
cd apps/api && bun run lint && bun run type-check && bun run test
cd apps/api && bun run test:integration -- test/integration/vcs test/integration/webhook
cd apps/cli && bun run test
```
Expected: 0 lint warnings, no type errors, all unit tests pass, all VCS + webhook integration tests pass, CLI tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts openapi.json apps/cli/src/generated
git commit -m "test(track3-slice2b): e2e 401 parity for inbound webhooks; regenerate openapi and CLI"
```

- [ ] **Step 6: Confirm the regenerated contract is stable**

Run (repo root): `bun run generate && git status --porcelain openapi.json apps/cli/src/generated`
Expected: no output (a second generate produces zero diff).

- [ ] **Step 7: Stop before pushing**

Do not push or open the PR. Run the whole-branch code review first (per the working agreement: review before push). Then hand back with the branch head, the test counts from Step 4, and this behaviour change for the PR body: **a VCS connection whose `syncMode` is `off` (the schema default) or `polling`, or whose `isActive` is false, now gets 200 `{ ignored: true }` for every GitHub delivery. Before this change it processed them.** Also for the PR body: CI and VCS inbound routes now return 401 (was 404) for an unknown project, and a CI payload is validated only after a valid signature.

---

## Self-Review

**Spec coverage (2b bullets):**
- No slug enumeration, CI: Task 2 (`findInboundTarget`, one `AuthException`), e2e Task 6. VCS: Tasks 3-4, e2e Task 6. The CI controller's early `NotFoundAppException` branch and the VCS controller's 404-throwing `projectsService.findBySlug` are both gone.
- Replay dedup after verification: Tasks 2 and 4 (replay tests assert the order and the resolved project id).
- Signature before DTO validation, `@Body()` removed, `plainToInstance` + `validate`, 400: Task 1 helper, Task 2 controller. The VCS payload is a TypeScript interface with no class-validator DTO, so its route has no validation step. Removing `@Body()` there only moves the read after the signature.
- `CiWebhookPayloadDto.line` `@IsInt() @Min(1)`: Task 2 Step 7.
- VCS `isActive` / `syncMode === 'webhook'` -> 200 `{ ignored: true, reason }`: Task 4.
- `DELETE projects/:slug/webhooks/:id` by project id, another project's id -> 404, slug-less admin route unchanged: Task 5.
- Spec "Tests" bullets: identical 401 for every inbound failure mode (Tasks 2, 4, 6), validation only after a valid signature (Tasks 2, 6), ignored deliveries 200 (Task 4).

**Review Focus:** each of the five lines has a test in its owning task (Tasks 1, 2 and 4).

**Type consistency:** `InboundWebhookRequest` / `signedBytesOf` / `parseInboundPayload` (Task 1) are used with the same names in Tasks 2 and 4. `findInboundTarget` is the name in both `CiWebhookService` (returns `{ projectId, secret } | null`) and `VcsConnectionService` (returns `VcsConnectionWithProjectDomain | null`). `findVcsConnectionByProjectSlug` (Task 3) is used by Task 3's service method. `removeForProject(projectId, id)` (Task 5) matches the controller call.
