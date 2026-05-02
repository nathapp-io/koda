---
paths:
  - "apps/api/*"
appliesTo:
  - "**/*.controller.ts"
priority: 80
---

# API Controllers — apps/api

## Responses & Exceptions
- Controllers return `JsonResponse.Ok<T>(data)`
- Prefer exceptions from `@nathapp/nestjs-common`
- Use app exception classes (`NotFoundAppException`, `ForbiddenAppException`, `AuthException`, `ValidationAppException`) where applicable
- For domain/authz 403, throw `ForbiddenAppException`
- If no app exception equivalent exists, document the exception choice inline

## Swagger
- Controllers require `@ApiTags`, `@ApiBearerAuth`, `@ApiOperation`, `@ApiResponse`
- Response DTO fields must have `@ApiProperty()`
