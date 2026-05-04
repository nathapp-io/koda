---
paths:
  - "apps/api/src/**/*"
priority: 50
---

# API Logging Rules — apps/api/src

## Logger Import
- Use `import { Logger } from '@nestjs/common';` in all service/controller files.
- `import { Logger } from '@nathapp/nestjs-logging';` is reserved **only** for `apps/api/src/main.ts` (to override the app-level logger via `app.useLogger(...)`).

## No Console in Source
- Never use `console.log`, `console.warn`, `console.error`, `console.debug`, or `console.info` in `apps/api/src/`.
- Use `this.logger.warn(...)`, `this.logger.error(...)`, `this.logger.debug(...)`, etc. instead.

## Pattern
```typescript
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class SomeService {
  private readonly logger = new Logger(SomeService.name);

  doWork() {
    this.logger.debug('Starting work');
    // ...
  }
}
```

## Anti-Patterns
- Wrong: `import { Logger } from '@nathapp/nestjs-logging';` in a service or controller.
- Wrong: `console.warn('...')` or `console.log('...')` anywhere in `apps/api/src/`.
