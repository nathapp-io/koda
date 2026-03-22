# US-009: Replace custom JsonResponse & AppException with @nathapp/nestjs-common

## Context

During PR review of `feat/refactor-standard`, it was found that nax generated its own
`apps/api/src/common/json-response.ts` and `apps/api/src/common/app-exception.ts` instead
of importing the standard implementations from `@nathapp/nestjs-common`.

This story replaces all usages with the correct imports and deletes the custom files.

## Scope

**Files to delete (after all usages migrated):**
- `apps/api/src/common/json-response.ts`
- `apps/api/src/common/app-exception.ts`

**Production files to update (6 controllers + 12+ services):**

### Controllers (JsonResponse migration)
- `apps/api/src/auth/auth.controller.ts`
- `apps/api/src/agents/agents.controller.ts`
- `apps/api/src/projects/projects.controller.ts`
- `apps/api/src/tickets/tickets.controller.ts`
- `apps/api/src/comments/comments.controller.ts`
- `apps/api/src/labels/labels.controller.ts`

### Services + Guards (AppException migration)
- `apps/api/src/auth/auth.service.ts`
- `apps/api/src/auth/auth.controller.ts`
- `apps/api/src/agents/agents.service.ts`
- `apps/api/src/agents/agents.controller.ts`
- `apps/api/src/agents/guards/agent-api-key.guard.ts`
- `apps/api/src/projects/projects.service.ts`
- `apps/api/src/projects/projects.controller.ts`
- `apps/api/src/tickets/tickets.service.ts`
- `apps/api/src/tickets/state-machine/ticket-transitions.ts`
- `apps/api/src/tickets/state-machine/ticket-transitions.service.ts`
- `apps/api/src/comments/comments.service.ts`
- `apps/api/src/labels/labels.service.ts`

## Migration Rules

### JsonResponse

**Before:**
```typescript
import { JsonResponse } from '../common/json-response';
return JsonResponse.ok(data);     // lowercase .ok()
return JsonResponse.created(data); // no equivalent in nathapp
return JsonResponse.paginated(data, meta); // no equivalent
```

**After:**
```typescript
import { JsonResponse } from '@nathapp/nestjs-common';
return JsonResponse.Ok(data);  // capital O — ALL usages
// JsonResponse.ok() → JsonResponse.Ok()
// JsonResponse.created() → JsonResponse.Ok()   (no .created() in nathapp v3)
// JsonResponse.paginated() → JsonResponse.Ok() (no .paginated() in nathapp v3)
```

### AppException

**Before:**
```typescript
import { AppException } from '../common/app-exception';
throw new AppException('errors.notFound', HttpStatus.NOT_FOUND);   // string key + HttpStatus
throw new AppException('errors.forbidden', HttpStatus.FORBIDDEN);
throw new AppException('errors.unauthorized', HttpStatus.UNAUTHORIZED);
throw new AppException('projects.nameTooShort', HttpStatus.BAD_REQUEST);
throw new AppException('projects.slugTaken', HttpStatus.CONFLICT);
```

**After — use pre-built exception classes where possible:**
```typescript
import {
  AppException,
  NotFoundAppException,
  ForbiddenAppException,
  AuthException,
  ValidationAppException,
} from '@nathapp/nestjs-common';

// NOT_FOUND (HTTP 404)  → NotFoundAppException(args?, prefix?)
throw new NotFoundAppException({}, 'errors');
throw new NotFoundAppException({}, 'projects');
throw new NotFoundAppException({}, 'tickets');

// FORBIDDEN (HTTP 403)  → ForbiddenAppException(args?, prefix?)
throw new ForbiddenAppException({}, 'errors');

// UNAUTHORIZED (HTTP 401) → AuthException(args?, prefix?)
throw new AuthException({}, 'errors');
throw new AuthException({}, 'auth');

// BAD_REQUEST (HTTP 400) → ValidationAppException(args?, prefix?)
throw new ValidationAppException({}, 'projects');
throw new ValidationAppException({}, 'tickets');
throw new ValidationAppException({}, 'errors');

// CONFLICT (HTTP 409) → AppException with custom code (no pre-built conflict class)
// Use CommonExceptionCode.REQUEST_INVALID (-3) with httpStatus 409
import { AppException } from '@nathapp/nestjs-common';
throw new AppException(-3, {}, 'projects', 409);   // for slugTaken, keyTaken
throw new AppException(-3, {}, 'labels', 409);     // for alreadyAssigned, alreadyExists
```

**AppException constructor signature (v3):**
```typescript
new AppException(code: number, args?: Record<string, unknown>, prefix?: string, httpStatus?: number)
```
- `code` — numeric error code (use `CommonExceptionCode` or custom; do NOT pass a string)
- `args` — i18n interpolation args (pass `{}` if none)
- `prefix` — i18n namespace prefix (the part before the dot in your i18n key, e.g. `'projects'`)
- `httpStatus` — HTTP status code (defaults to 500; always set explicitly)

## Acceptance Criteria

### AC-1: No local custom JsonResponse class
`apps/api/src/common/json-response.ts` must not exist.

### AC-2: No local custom AppException class
`apps/api/src/common/app-exception.ts` must not exist.

### AC-3: All controllers import JsonResponse from @nathapp/nestjs-common
`grep -r "from '../common/json-response'" apps/api/src/` must return 0 results.

### AC-4: All services/guards import AppException from @nathapp/nestjs-common
`grep -r "from '../common/app-exception'" apps/api/src/` must return 0 results.
`grep -r "from '../../common/app-exception'" apps/api/src/` must return 0 results.

### AC-5: No JsonResponse.ok() or JsonResponse.created() calls (lowercase)
`grep -rn "JsonResponse\.ok\|JsonResponse\.created\|JsonResponse\.paginated" apps/api/src/` must return 0 results.

### AC-6: No string-keyed AppException constructor calls
`grep -rn "new AppException('[a-z]" apps/api/src/` must return 0 results.

### AC-7: All existing tests still pass
`npx turbo test --filter=@nathapp/koda-api` exits 0.
Test count must be >= 737.

### AC-8: TypeScript compiles without errors
`npx tsc --noEmit` exits 0 in `apps/api/`.

## Implementation Notes

- `@nathapp/nestjs-common` is already installed at `^3.0.0` in `apps/api/package.json`.
- After deleting the custom files, check if `apps/api/src/common/` directory becomes empty. If so, delete the directory too (or keep if other shared files remain).
- Do NOT change any i18n translation files or keys — only the import source and constructor signature changes.
- Update test files that import from `../common/json-response` or `../common/app-exception` as well.
- Run tests after each file update to catch regressions early.
