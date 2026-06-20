# Config Pattern Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring all five config files into the nathapp pattern (DI token constant + typed interface + `validateUtil` schema class) and replace every `ConfigService.get<T>()` call in services/controllers with `@Inject(CFG_TOKEN) private config: IConfig` direct injection.

**Architecture:** Each config file exports a string DI token constant (`APP_CFG`, `AUTH_CFG`, etc.), a typed interface (`IAppConfig`, etc.), and a `class-validator` schema class passed to `validateUtil`. Services inject the typed config object directly instead of using `ConfigService`. `main.ts` uses `app.get<IAppConfig>(APP_CFG)` for bootstrap values. The existing Joi `validate` in `env.validation.ts` is left in place as a complementary startup guard.

**Tech Stack:** `@nestjs/config` `registerAs`, `validateUtil` from `@nathapp/nestjs-common`, `class-validator`, TypeScript strict.

## Global Constraints

- Never touch generated files under `apps/cli/src/generated/`.
- Keep the same namespace strings (`'app'`, `'auth'`, `'database'`, `'rag'`, `'vcs'`) so ConfigModule's `load` array and the Joi `validate` keep working unchanged.
- Keep every existing default value (`?? 'ollama'`, `?? 300_000`, etc.) — move them into the config factory, not the service.
- Do **not** invoke `bun test` directly — use `npx jest` per project memory (bun leaks memory).
- Commit after each task with the conventional commit format.
- `validateUtil` uses `plainToClass` with `enableImplicitConversion: true` — string env vars are coerced to `number`/`boolean` before validation, so `@IsNumber()` and `@IsBoolean()` on schema class fields are safe and correct.
- `auth.module.ts`'s `useFactory` for `NathappAuthModule.forRootAsync` legitimately uses `ConfigService` as a third-party integration adapter — do **not** change it. It is a justified exception and is intentionally left in place.
- When spec files already exist (`auth.config.spec.ts`, `vcs.config.spec.ts`), **extend** them with new tests rather than replacing them.

---

### Task 1: Update `app.config.ts` — add token, interface, schema, `validateUtil`, and `host` field

**Files:**
- Modify: `apps/api/src/config/app.config.ts`
- Create: `apps/api/src/config/app.config.spec.ts`

**Interfaces:**
- Produces: `APP_CFG = 'app'`, `IAppConfig { port, host, nodeEnv, globalPrefix }` — consumed by Task 6 (`main.ts`).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/config/app.config.spec.ts`:

```typescript
import { appConfig, IAppConfig } from './app.config';

describe('appConfig', () => {
  beforeEach(() => {
    delete process.env['API_PORT'];
    delete process.env['API_HOST'];
    delete process.env['NODE_ENV'];
    delete process.env['GLOBAL_PREFIX'];
  });

  it('returns typed IAppConfig with defaults', () => {
    const cfg: IAppConfig = appConfig();
    expect(cfg.port).toBe(3100);
    expect(cfg.host).toBe('0.0.0.0');
    expect(cfg.nodeEnv).toBe('development');
    expect(cfg.globalPrefix).toBe('api');
  });

  it('reads API_HOST from env', () => {
    process.env['API_HOST'] = '127.0.0.1';
    const cfg: IAppConfig = appConfig();
    expect(cfg.host).toBe('127.0.0.1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && npx jest src/config/app.config.spec.ts --no-coverage 2>&1
```

Expected: FAIL — `IAppConfig` not exported, `host` not on config.

- [ ] **Step 3: Rewrite `app.config.ts`**

```typescript
import { validateUtil } from '@nathapp/nestjs-common';
import { registerAs } from '@nestjs/config';
import { IsNumber, IsOptional, IsString } from 'class-validator';

export const APP_CFG = 'app';

export interface IAppConfig {
  port: number;
  host: string;
  nodeEnv: string;
  globalPrefix: string;
}

export class AppConfigSchema {
  @IsOptional()
  @IsNumber()
  API_PORT: number;

  @IsOptional()
  @IsString()
  API_HOST: string;

  @IsOptional()
  @IsString()
  NODE_ENV: string;

  @IsOptional()
  @IsString()
  GLOBAL_PREFIX: string;
}

export const appConfig = registerAs(APP_CFG, (): IAppConfig => {
  validateUtil(process.env, AppConfigSchema);
  return {
    port: parseInt(process.env['API_PORT'] ?? '3100', 10),
    host: process.env['API_HOST'] ?? '0.0.0.0',
    nodeEnv: process.env['NODE_ENV'] ?? 'development',
    globalPrefix: process.env['GLOBAL_PREFIX'] ?? 'api',
  };
});
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/api && npx jest src/config/app.config.spec.ts --no-coverage 2>&1
```

Expected: PASS.

- [ ] **Step 5: TypeScript check**

```bash
cd apps/api && npx tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/config/app.config.ts apps/api/src/config/app.config.spec.ts
git commit -m "feat: add APP_CFG token, IAppConfig interface, and validateUtil to app.config"
```

---

### Task 2: Update `auth.config.ts` — add token, interface, schema, `validateUtil`

**Files:**
- Modify: `apps/api/src/config/auth.config.ts`
- Create: `apps/api/src/config/auth.config.spec.ts`

**Interfaces:**
- Produces: `AUTH_CFG = 'auth'`, `IAuthConfig { jwtSecret, jwtExpiresIn, jwtRefreshSecret, jwtRefreshExpiresIn, apiKeySecret }` — consumed by Task 9 (`AgentsService`).

- [ ] **Step 1: Extend the existing `auth.config.spec.ts`**

`apps/api/src/config/auth.config.spec.ts` already exists. Add these tests to the existing `describe` block (do NOT replace the file):

```typescript
// Add inside the existing describe block:
import { IAuthConfig } from './auth.config'; // add to existing import

it('returns typed IAuthConfig', () => {
  process.env['JWT_SECRET'] = 'test-secret';
  process.env['JWT_REFRESH_SECRET'] = 'test-refresh-secret';
  process.env['API_KEY_SECRET'] = 'test-api-key-secret';
  const cfg: IAuthConfig = authConfig();
  expect(cfg.jwtSecret).toBe('test-secret');
  expect(cfg.apiKeySecret).toBe('test-api-key-secret');
  delete process.env['JWT_SECRET'];
  delete process.env['JWT_REFRESH_SECRET'];
  delete process.env['API_KEY_SECRET'];
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && npx jest src/config/auth.config.spec.ts --no-coverage 2>&1
```

Expected: FAIL — `IAuthConfig` not exported.

- [ ] **Step 3: Rewrite `auth.config.ts`**

```typescript
import { validateUtil } from '@nathapp/nestjs-common';
import { registerAs } from '@nestjs/config';
import { IsOptional, IsString } from 'class-validator';

export const AUTH_CFG = 'auth';

export interface IAuthConfig {
  jwtSecret: string | undefined;
  jwtExpiresIn: string;
  jwtRefreshSecret: string | undefined;
  jwtRefreshExpiresIn: string;
  apiKeySecret: string | undefined;
}

export class AuthConfigSchema {
  @IsString()
  JWT_SECRET: string;

  @IsOptional()
  @IsString()
  JWT_EXPIRES_IN: string;

  @IsString()
  JWT_REFRESH_SECRET: string;

  @IsOptional()
  @IsString()
  JWT_REFRESH_EXPIRES_IN: string;

  @IsString()
  API_KEY_SECRET: string;
}

export const authConfig = registerAs(AUTH_CFG, (): IAuthConfig => {
  validateUtil(process.env, AuthConfigSchema);
  return {
    jwtSecret: process.env['JWT_SECRET'],
    jwtExpiresIn: process.env['JWT_EXPIRES_IN'] ?? '15m',
    jwtRefreshSecret: process.env['JWT_REFRESH_SECRET'],
    jwtRefreshExpiresIn: process.env['JWT_REFRESH_EXPIRES_IN'] ?? '7d',
    apiKeySecret: process.env['API_KEY_SECRET'],
  };
});
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/api && npx jest src/config/auth.config.spec.ts --no-coverage 2>&1
```

Expected: PASS.

- [ ] **Step 5: TypeScript check**

```bash
cd apps/api && npx tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/config/auth.config.ts apps/api/src/config/auth.config.spec.ts
git commit -m "feat: add AUTH_CFG token, IAuthConfig interface, and validateUtil to auth.config"
```

---

### Task 3: Update `database.config.ts` — add token, interface, schema, `validateUtil`

**Files:**
- Modify: `apps/api/src/config/database.config.ts`
- Create: `apps/api/src/config/database.config.spec.ts`

**Interfaces:**
- Produces: `DATABASE_CFG = 'database'`, `IDatabaseConfig { url, provider }`. No service currently injects database config directly; this task applies the pattern for consistency.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/config/database.config.spec.ts`:

```typescript
import { databaseConfig, IDatabaseConfig } from './database.config';

describe('databaseConfig', () => {
  beforeEach(() => {
    process.env['DATABASE_URL'] = 'file:./test.db';
    delete process.env['DATABASE_PROVIDER'];
  });

  afterEach(() => {
    delete process.env['DATABASE_URL'];
  });

  it('returns typed IDatabaseConfig with defaults', () => {
    const cfg: IDatabaseConfig = databaseConfig();
    expect(cfg.url).toBe('file:./test.db');
    expect(cfg.provider).toBe('sqlite');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && npx jest src/config/database.config.spec.ts --no-coverage 2>&1
```

Expected: FAIL — `IDatabaseConfig` not exported.

- [ ] **Step 3: Rewrite `database.config.ts`**

```typescript
import { validateUtil } from '@nathapp/nestjs-common';
import { registerAs } from '@nestjs/config';
import { IsOptional, IsString } from 'class-validator';

export const DATABASE_CFG = 'database';

export interface IDatabaseConfig {
  url: string | undefined;
  provider: string;
}

export class DatabaseConfigSchema {
  @IsString()
  DATABASE_URL: string;

  @IsOptional()
  @IsString()
  DATABASE_PROVIDER: string;
}

export const databaseConfig = registerAs(DATABASE_CFG, (): IDatabaseConfig => {
  validateUtil(process.env, DatabaseConfigSchema);
  return {
    url: process.env['DATABASE_URL'],
    provider: process.env['DATABASE_PROVIDER'] ?? 'sqlite',
  };
});
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/api && npx jest src/config/database.config.spec.ts --no-coverage 2>&1
```

Expected: PASS.

- [ ] **Step 5: TypeScript check**

```bash
cd apps/api && npx tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/config/database.config.ts apps/api/src/config/database.config.spec.ts
git commit -m "feat: add DATABASE_CFG token, IDatabaseConfig interface, and validateUtil to database.config"
```

---

### Task 4: Update `rag.config.ts` — add token, interface, schema, `validateUtil`, and missing `graphifyEnabledCacheTtlSec`

**Files:**
- Modify: `apps/api/src/config/rag.config.ts`
- Create: `apps/api/src/config/rag.config.spec.ts`

**Interfaces:**
- Produces: `RAG_CFG = 'rag'`, `IRagConfig` with all RAG fields including previously-missing `graphifyEnabledCacheTtlSec: number` (default `60`) — consumed by Tasks 7 and 8.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/config/rag.config.spec.ts`:

```typescript
import { ragConfig, IRagConfig } from './rag.config';

describe('ragConfig', () => {
  beforeEach(() => {
    Object.keys(process.env)
      .filter((k) => ['EMBEDDING_PROVIDER', 'EMBEDDING_MODEL', 'OLLAMA_BASE_URL',
        'OPENAI_API_KEY', 'LANCEDB_PATH', 'RAG_IN_MEMORY_ONLY', 'FTS_INDEX_MODE',
        'SIMILARITY_HIGH', 'SIMILARITY_MEDIUM', 'SIMILARITY_LOW',
        'FTS_OPTIMIZE_STRATEGY', 'FTS_OPTIMIZE_THRESHOLD', 'FTS_OPTIMIZE_INTERVAL_MS',
        'GRAPHIFY_CACHE_TTL_SEC'].includes(k))
      .forEach((k) => delete process.env[k]);
    process.env['NODE_ENV'] = 'test';
  });

  it('returns typed IRagConfig with defaults', () => {
    const cfg: IRagConfig = ragConfig();
    expect(cfg.embeddingProvider).toBe('ollama');
    expect(cfg.embeddingModel).toBe('nomic-embed-text');
    expect(cfg.lancedbPath).toBe('./lancedb');
    expect(cfg.inMemoryOnly).toBe(true); // NODE_ENV=test defaults to true
    expect(cfg.similarityHigh).toBe(0.85);
    expect(cfg.ftsOptimizeThreshold).toBe(10);
    expect(cfg.graphifyEnabledCacheTtlSec).toBe(60);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && npx jest src/config/rag.config.spec.ts --no-coverage 2>&1
```

Expected: FAIL — `IRagConfig` not exported, `graphifyEnabledCacheTtlSec` missing.

- [ ] **Step 3: Rewrite `rag.config.ts`**

```typescript
import { validateUtil } from '@nathapp/nestjs-common';
import { registerAs } from '@nestjs/config';
import { IsBoolean, IsNumber, IsOptional, IsString } from 'class-validator';

export const RAG_CFG = 'rag';

export interface IRagConfig {
  embeddingProvider: string;
  embeddingModel: string;
  ollamaBaseUrl: string;
  openaiApiKey: string;
  lancedbPath: string;
  inMemoryOnly: boolean;
  ftsIndexMode: string;
  similarityHigh: number;
  similarityMedium: number;
  similarityLow: number;
  ftsOptimizeStrategy: string;
  ftsOptimizeThreshold: number;
  ftsOptimizeIntervalMs: number;
  graphifyEnabledCacheTtlSec: number;
}

export class RagConfigSchema {
  @IsOptional()
  @IsString()
  EMBEDDING_PROVIDER: string;

  @IsOptional()
  @IsString()
  EMBEDDING_MODEL: string;

  @IsOptional()
  @IsString()
  OLLAMA_BASE_URL: string;

  @IsOptional()
  @IsString()
  OPENAI_API_KEY: string;

  @IsOptional()
  @IsString()
  LANCEDB_PATH: string;

  @IsOptional()
  @IsBoolean()
  RAG_IN_MEMORY_ONLY: boolean;

  @IsOptional()
  @IsString()
  FTS_INDEX_MODE: string;

  @IsOptional()
  @IsNumber()
  SIMILARITY_HIGH: number;

  @IsOptional()
  @IsNumber()
  SIMILARITY_MEDIUM: number;

  @IsOptional()
  @IsNumber()
  SIMILARITY_LOW: number;

  @IsOptional()
  @IsString()
  FTS_OPTIMIZE_STRATEGY: string;

  @IsOptional()
  @IsNumber()
  FTS_OPTIMIZE_THRESHOLD: number;

  @IsOptional()
  @IsNumber()
  FTS_OPTIMIZE_INTERVAL_MS: number;

  @IsOptional()
  @IsNumber()
  GRAPHIFY_CACHE_TTL_SEC: number;
}

export const ragConfig = registerAs(RAG_CFG, (): IRagConfig => {
  validateUtil(process.env, RagConfigSchema);
  return {
    embeddingProvider: process.env['EMBEDDING_PROVIDER'] ?? 'ollama',
    embeddingModel: process.env['EMBEDDING_MODEL'] ?? 'nomic-embed-text',
    ollamaBaseUrl: process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434',
    openaiApiKey: process.env['OPENAI_API_KEY'] ?? '',
    lancedbPath: process.env['LANCEDB_PATH'] ?? './lancedb',
    inMemoryOnly: process.env['RAG_IN_MEMORY_ONLY']
      ? process.env['RAG_IN_MEMORY_ONLY'].toLowerCase() === 'true'
      : process.env['NODE_ENV'] === 'test',
    ftsIndexMode: process.env['FTS_INDEX_MODE'] ?? 'simple',
    similarityHigh: parseFloat(process.env['SIMILARITY_HIGH'] ?? '0.85'),
    similarityMedium: parseFloat(process.env['SIMILARITY_MEDIUM'] ?? '0.70'),
    similarityLow: parseFloat(process.env['SIMILARITY_LOW'] ?? '0.50'),
    ftsOptimizeStrategy: process.env['FTS_OPTIMIZE_STRATEGY'] ?? 'counter',
    ftsOptimizeThreshold: parseInt(process.env['FTS_OPTIMIZE_THRESHOLD'] ?? '10', 10),
    ftsOptimizeIntervalMs: parseInt(process.env['FTS_OPTIMIZE_INTERVAL_MS'] ?? '300000', 10),
    graphifyEnabledCacheTtlSec: parseInt(process.env['GRAPHIFY_CACHE_TTL_SEC'] ?? '60', 10),
  };
});
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/api && npx jest src/config/rag.config.spec.ts --no-coverage 2>&1
```

Expected: PASS.

- [ ] **Step 5: TypeScript check**

```bash
cd apps/api && npx tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/config/rag.config.ts apps/api/src/config/rag.config.spec.ts
git commit -m "feat: add RAG_CFG token, IRagConfig interface, validateUtil, and graphifyEnabledCacheTtlSec to rag.config"
```

---

### Task 5: Update `vcs.config.ts` — add token, interface, schema, `validateUtil`

**Files:**
- Modify: `apps/api/src/config/vcs.config.ts`
- Create: `apps/api/src/config/vcs.config.spec.ts`

**Interfaces:**
- Produces: `VCS_CFG = 'vcs'`, `IVcsConfig { encryptionKey, defaultPollingIntervalMs, githubApiUrl }` — consumed by Task 10.

- [ ] **Step 1: Extend the existing `vcs.config.spec.ts`**

`apps/api/src/config/vcs.config.spec.ts` already exists with 192 lines of tests. Add an import of `IVcsConfig` to the existing imports and one new test inside the existing `describe` block to verify the typed interface export — do NOT replace the file:

```typescript
// Add to existing imports:
import { IVcsConfig } from './vcs.config';

// Add inside the existing describe block:
it('return value satisfies IVcsConfig interface', () => {
  const cfg: IVcsConfig = vcsConfig();
  expect(typeof cfg.defaultPollingIntervalMs).toBe('number');
  expect(typeof cfg.githubApiUrl).toBe('string');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && npx jest src/config/vcs.config.spec.ts --no-coverage 2>&1
```

Expected: FAIL — `IVcsConfig` not exported yet.

- [ ] **Step 3: Rewrite `vcs.config.ts`**

```typescript
import { validateUtil } from '@nathapp/nestjs-common';
import { registerAs } from '@nestjs/config';
import { IsNumber, IsOptional, IsString } from 'class-validator';

export const VCS_CFG = 'vcs';

export interface IVcsConfig {
  encryptionKey: string | undefined;
  defaultPollingIntervalMs: number;
  githubApiUrl: string;
}

export class VcsConfigSchema {
  @IsOptional()
  @IsString()
  VCS_ENCRYPTION_KEY: string;

  @IsOptional()
  @IsNumber()
  VCS_DEFAULT_POLLING_INTERVAL_MS: number;

  @IsOptional()
  @IsString()
  GITHUB_API_URL: string;
}

export const vcsConfig = registerAs(VCS_CFG, (): IVcsConfig => {
  validateUtil(process.env, VcsConfigSchema);
  return {
    encryptionKey: process.env['VCS_ENCRYPTION_KEY'],
    defaultPollingIntervalMs: parseInt(
      process.env['VCS_DEFAULT_POLLING_INTERVAL_MS'] ?? '600000',
      10,
    ),
    githubApiUrl: process.env['GITHUB_API_URL'] ?? 'https://api.github.com',
  };
});
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/api && npx jest src/config/vcs.config.spec.ts --no-coverage 2>&1
```

Expected: PASS.

- [ ] **Step 5: TypeScript check**

```bash
cd apps/api && npx tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/config/vcs.config.ts apps/api/src/config/vcs.config.spec.ts
git commit -m "feat: add VCS_CFG token, IVcsConfig interface, and validateUtil to vcs.config"
```

---

### Task 6: Fix `main.ts` — eliminate raw `process.env`, use `app.get<IAppConfig>(APP_CFG)`

**Files:**
- Modify: `apps/api/src/main.ts`

**Interfaces:**
- Consumes: `APP_CFG`, `IAppConfig` from Task 1.

- [ ] **Step 1: Update `main.ts`**

Replace lines 38–39 and add the import. The final `main.ts`:

```typescript
import { Readable } from 'stream';
import { AppFactory } from '@nathapp/nestjs-app';
import { Logger } from '@nathapp/nestjs-logging';
import { HttpAdapterHost } from '@nestjs/core';
import { AppModule } from './app.module';
import { CombinedAuthGuard } from './auth/guards/combined-auth.guard';
import { APP_CFG, IAppConfig } from './config/app.config';

async function bootstrap() {
  const app = await AppFactory.createFastifyApp(AppModule, {
    bufferLogs: true,
  });

  app.useLogger(app.get(Logger));

  // Register preParsing hook to allow empty JSON bodies before server starts
  const { httpAdapter } = app.get(HttpAdapterHost);
  const fastify = httpAdapter.getInstance();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fastify.addHook('preParsing', async (request: any, _reply: unknown, payload: AsyncIterable<Buffer>) => {
    const ct = String(request.headers?.['content-type'] ?? '');
    if (!ct.includes('application/json')) return payload;

    // Collect the entire body stream
    const chunks: Buffer[] = [];
    for await (const chunk of payload) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    // Use empty JSON object if body is empty
    const body = chunks.length > 0 ? Buffer.concat(chunks) : Buffer.from('{}');

    // Update Content-Length so Fastify's parser doesn't throw size mismatch
    request.headers['content-length'] = String(body.length);

    return Readable.from([body]);
  });

  const { port, host } = app.get<IAppConfig>(APP_CFG);

  // DI container is ready right after createFastifyApp() — get the guard before
  // setting up global handlers. Global guards MUST be registered before init()
  // because NestJS compiles route handlers (capturing guards) during init().
  const combinedGuard = app.get(CombinedAuthGuard);
  app.setJwtAuthGuard(combinedGuard);

  app
    .useAppGlobalPrefix()
    .useAppGlobalPipes()
    .useAppGlobalFilters()
    .useAppGlobalGuards()
    .useSwaggerUIOnDevOnly({
      name: 'Koda API',
      description: 'Dev ticket tracker API',
      version: '1.0.0',
    });

  await app.start(port, host);
}

bootstrap();
```

- [ ] **Step 2: TypeScript check**

```bash
cd apps/api && npx tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/main.ts
git commit -m "fix: replace process.env in main.ts with app.get IAppConfig via APP_CFG token"
```

---

### Task 7: Fix RAG services — `EmbeddingService`, `HybridRetrieverService`, `RagService`

**Files:**
- Modify: `apps/api/src/rag/embedding.service.ts`
- Modify: `apps/api/src/rag/hybrid-retriever.service.ts`
- Modify: `apps/api/src/rag/rag.service.ts`

**Interfaces:**
- Consumes: `RAG_CFG`, `IRagConfig` from Task 4.

- [ ] **Step 1: Update `embedding.service.ts`**

Replace the constructor signature and all config reads:

```typescript
import { Injectable, Inject } from '@nestjs/common';
import { RAG_CFG, IRagConfig } from '../config/rag.config';
import { EmbeddingProvider } from './embedding.interface';
import { OllamaEmbeddingProvider } from './providers/ollama-embedding.provider';
import { OpenAIEmbeddingProvider } from './providers/openai-embedding.provider';

@Injectable()
export class EmbeddingService {
  private readonly provider: EmbeddingProvider;
  private readonly _modelName: string;

  constructor(@Inject(RAG_CFG) ragConfig: IRagConfig) {
    const { embeddingProvider, embeddingModel, openaiApiKey, ollamaBaseUrl } = ragConfig;
    this._modelName = embeddingModel;

    if (embeddingProvider === 'openai') {
      this.provider = new OpenAIEmbeddingProvider(openaiApiKey, embeddingModel);
    } else {
      this.provider = new OllamaEmbeddingProvider(ollamaBaseUrl, embeddingModel);
    }
  }
  // ... rest of file unchanged
}
```

- [ ] **Step 2: Update `hybrid-retriever.service.ts` constructor**

Replace the `ConfigService` import and constructor. Change the six config reads:

```typescript
// Remove: import { ConfigService } from '@nestjs/config';
// Add:
import { RAG_CFG, IRagConfig } from '../config/rag.config';

// In the constructor parameter list, replace:
//   private readonly configService: ConfigService,
// with:
//   @Inject(RAG_CFG) ragConfig: IRagConfig,

// Replace the six configService.get lines with:
    this.lancedbPath = ragConfig.lancedbPath;
    this.similarityHigh = ragConfig.similarityHigh;
    this.similarityMedium = ragConfig.similarityMedium;
    this.similarityLow = ragConfig.similarityLow;
    this.inMemoryOnly = ragConfig.inMemoryOnly;
    this.graphifyEnabledCacheTtlMs = ragConfig.graphifyEnabledCacheTtlSec * 1000;
```

Note: the original code stored the value in `graphifyEnabledCacheTtlMs` (milliseconds) but read from `rag.graphifyEnabledCacheTtlSec` without multiplying by 1000 — a pre-existing bug. The `* 1000` conversion is intentionally added here as a bundled bug fix.

- [ ] **Step 3: Update `rag.service.ts` constructor**

Replace the `ConfigService` import and constructor. Change the six config reads:

```typescript
// Remove: import { ConfigService } from '@nestjs/config';
// Add:
import { RAG_CFG, IRagConfig } from '../config/rag.config';

// In the constructor parameter list, replace:
//   private readonly configService: ConfigService,
// with:
//   @Inject(RAG_CFG) ragConfig: IRagConfig,

// Replace the six configService.get lines with:
    this.lancedbPath = ragConfig.lancedbPath;
    this.similarityHigh = ragConfig.similarityHigh;
    this.similarityMedium = ragConfig.similarityMedium;
    this.similarityLow = ragConfig.similarityLow;
    this.ftsIndexMode = ragConfig.ftsIndexMode;
    this.inMemoryOnly = ragConfig.inMemoryOnly;
```

- [ ] **Step 4: TypeScript check**

```bash
cd apps/api && npx tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 5: Run unit tests**

```bash
cd apps/api && npx jest src/rag/ --testPathIgnorePatterns='integration|e2e' --no-coverage 2>&1
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/rag/embedding.service.ts \
        apps/api/src/rag/hybrid-retriever.service.ts \
        apps/api/src/rag/rag.service.ts
git commit -m "fix: replace ConfigService with @Inject(RAG_CFG) IRagConfig in RAG services"
```

---

### Task 8: Fix RAG strategies and module factory

**Files:**
- Modify: `apps/api/src/rag/strategies/counter-optimize.strategy.ts`
- Modify: `apps/api/src/rag/strategies/cron-optimize.strategy.ts`
- Modify: `apps/api/src/rag/rag.module.ts`

**Interfaces:**
- Consumes: `RAG_CFG`, `IRagConfig` from Task 4.

- [ ] **Step 1: Update `counter-optimize.strategy.ts`**

```typescript
// Remove: import { ConfigService } from '@nestjs/config';
// Add:
import { RAG_CFG, IRagConfig } from '../../config/rag.config';

// Change constructor:
  constructor(@Inject(RAG_CFG) ragConfig: IRagConfig) {
    this.threshold = ragConfig.ftsOptimizeThreshold;
  }
```

Remove `private readonly configService: ConfigService` from the class body — it is no longer stored.

- [ ] **Step 2: Update `cron-optimize.strategy.ts`**

```typescript
// Remove: import { ConfigService } from '@nestjs/config';
// Add:
import { RAG_CFG, IRagConfig } from '../../config/rag.config';

// Change constructor (ConfigService is first param, SchedulerRegistryLike is second):
  constructor(
    @Inject(RAG_CFG) ragConfig: IRagConfig,
    private readonly schedulerRegistry: SchedulerRegistryLike,
  ) {
    this.intervalMs = ragConfig.ftsOptimizeIntervalMs;
    this.intervalId = setInterval(() => {
      void this.optimizeDirtyTables();
    }, this.intervalMs);
    this.schedulerRegistry.addInterval('fts-optimize', this.intervalId);
  }
```

Remove `private readonly configService: ConfigService` from the class body.

- [ ] **Step 3: Update `rag.module.ts` useFactory**

```typescript
// Remove: import { ConfigService } from '@nestjs/config';
// Add:
import { RAG_CFG, IRagConfig } from '../config/rag.config';

// Change the FTS_OPTIMIZE_STRATEGY provider:
    {
      provide: FTS_OPTIMIZE_STRATEGY,
      useFactory: (ragConfig: IRagConfig, schedulerRegistry: SchedulerRegistry): FtsOptimizeStrategy => {
        const strategy = ragConfig.ftsOptimizeStrategy;

        switch (strategy) {
          case 'cron':
            return new CronOptimizeStrategy(ragConfig, schedulerRegistry);
          case 'manual':
            return new ManualOptimizeStrategy();
          case 'counter':
          default:
            return new CounterOptimizeStrategy(ragConfig);
        }
      },
      inject: [RAG_CFG, SchedulerRegistry],
    },
```

Note: `CronOptimizeStrategy` and `CounterOptimizeStrategy` constructors now take `IRagConfig` instead of `ConfigService` (from Steps 1–2 above), so the factory passes `ragConfig` directly.

- [ ] **Step 4: TypeScript check**

```bash
cd apps/api && npx tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 5: Run unit tests**

```bash
cd apps/api && npx jest src/rag/ --testPathIgnorePatterns='integration|e2e' --no-coverage 2>&1
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/rag/strategies/counter-optimize.strategy.ts \
        apps/api/src/rag/strategies/cron-optimize.strategy.ts \
        apps/api/src/rag/rag.module.ts
git commit -m "fix: replace ConfigService with @Inject(RAG_CFG) IRagConfig in RAG strategies and module"
```

---

### Task 9: Fix `AgentsService`

**Files:**
- Modify: `apps/api/src/agents/agents.service.ts`

**Interfaces:**
- Consumes: `AUTH_CFG`, `IAuthConfig` from Task 2.

- [ ] **Step 1: Update `agents.service.ts`**

```typescript
// Remove: import { ConfigService } from '@nestjs/config';
// Add:
import { AUTH_CFG, IAuthConfig } from '../config/auth.config';

// Change constructor — replace `private configService: ConfigService`:
  constructor(
    private readonly agentRepo: PrismaAgentRepository,
    @Inject(AUTH_CFG) private readonly authConfig: IAuthConfig,
    @Optional() private readonly kodaDomainWriter?: KodaDomainWriter,
    @Optional() private readonly agentAuthProvider?: AgentAuthProvider,
  ) {}

// In generateApiKey(), replace the two config lines:
//   const authCfg = this.configService.get<{ apiKeySecret?: string }>('auth');
//   const apiKeySecret = authCfg?.apiKeySecret;
// with:
    const apiKeySecret = this.authConfig.apiKeySecret;
```

- [ ] **Step 2: TypeScript check**

```bash
cd apps/api && npx tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 3: Run unit tests**

```bash
cd apps/api && npx jest src/agents/ --testPathIgnorePatterns='integration|e2e' --no-coverage 2>&1
```

Expected: all pass. If any test instantiates `AgentsService` with a mock `ConfigService`, update that mock to provide `@Inject(AUTH_CFG)` with `{ apiKeySecret: 'test-secret' }` instead.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/agents/agents.service.ts
git commit -m "fix: replace ConfigService with @Inject(AUTH_CFG) IAuthConfig in AgentsService"
```

---

### Task 10: Fix VCS controller, services, and ticket transitions

**Files:**
- Modify: `apps/api/src/vcs/vcs.controller.ts`
- Modify: `apps/api/src/vcs/vcs-connection.service.ts`
- Modify: `apps/api/src/vcs/vcs-polling.service.ts`
- Modify: `apps/api/src/vcs/vcs-webhook.service.ts`
- Modify: `apps/api/src/vcs/vcs-pr-sync.service.ts` (dead code removal only)
- Modify: `apps/api/src/code-intel/code-commit-outbox-handler.ts`
- Modify: `apps/api/src/auth/guards/combined-auth.guard.ts`
- Modify: `apps/api/src/tickets/state-machine/ticket-transitions.service.ts`

**Interfaces:**
- Consumes: `VCS_CFG`, `IVcsConfig` from Task 5; `AUTH_CFG`, `IAuthConfig` from Task 2.

- [ ] **Step 1: Update `vcs.controller.ts`**

```typescript
// Remove: import { ConfigService } from '@nestjs/config';
// Add:
import { VCS_CFG, IVcsConfig } from '../config/vcs.config';

// Change constructor — replace `private readonly configService: ConfigService`:
  constructor(
    private readonly vcsService: VcsConnectionService,
    private readonly syncService: VcsSyncService,
    private readonly prSyncService: VcsPrSyncService,
    private readonly projectsService: ProjectsService,
    @Inject(VCS_CFG) private readonly vcsConfig: IVcsConfig,
  ) {}

// Replace all six occurrences of:
//   const encryptionKey = this.configService.get<string>('vcs.encryptionKey');
// with:
    const encryptionKey = this.vcsConfig.encryptionKey;
```

The `if (!encryptionKey) { this.throwEncryptionKeyNotConfigured(); }` guards remain unchanged.

- [ ] **Step 2: Update `vcs-connection.service.ts`**

```typescript
// Remove: import { ConfigService } from '@nestjs/config';
// Add:
import { VCS_CFG, IVcsConfig } from '../config/vcs.config';

// Change constructor — replace `private readonly configService: ConfigService`:
  constructor(
    @Inject(VCS_REPOSITORY) private readonly vcsRepo: IVcsRepository,
    @Inject(VCS_CFG) private readonly vcsConfig: IVcsConfig,
    private readonly vcsPollingService: VcsPollingService,
  ) {}

// Replace (line ~68):
//   ?? this.configService.get<number>('vcs.defaultPollingIntervalMs')
// with:
//   ?? this.vcsConfig.defaultPollingIntervalMs
```

The full expression becomes:
```typescript
    const pollingIntervalMs =
      dto.pollingIntervalMs
      ?? this.vcsConfig.defaultPollingIntervalMs
      ?? 600000;
```

- [ ] **Step 3: Update `vcs-polling.service.ts`**

```typescript
// Remove: import { ConfigService } from '@nestjs/config';
// Add:
import { VCS_CFG, IVcsConfig } from '../config/vcs.config';

// Change constructor — replace `private readonly configService: ConfigService`:
  constructor(
    @Inject(VCS_REPOSITORY) private readonly vcsRepo: IVcsRepository,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly syncService: VcsSyncService,
    private readonly prSyncService: VcsPrSyncService,
    @Inject(VCS_CFG) private readonly vcsConfig: IVcsConfig,
  ) {}

// Replace in poll() method:
//   const encryptionKey = this.configService.get<string>('vcs.encryptionKey');
// with:
      const encryptionKey = this.vcsConfig.encryptionKey;
```

- [ ] **Step 4: Update `vcs-webhook.service.ts`**

```typescript
// Remove: import { ConfigService } from '@nestjs/config';
// Add:
import { VCS_CFG, IVcsConfig } from '../config/vcs.config';

// Change constructor — find ConfigService in the constructor params and replace with:
//   @Inject(VCS_CFG) private readonly vcsConfig: IVcsConfig,
// (keep all other constructor params unchanged)

// Replace:
//   const encryptionKey = this.configService.get<string>('vcs.encryptionKey');
// with:
      const encryptionKey = this.vcsConfig.encryptionKey;

// The guard that checked for configService becomes a check for vcsLinkExtractorService only
// (vcsConfig is non-optional so it is always truthy — no need to guard on it):
//   if (this.vcsLinkExtractorService && this.configService) {
// becomes:
      if (this.vcsLinkExtractorService) {
```

- [ ] **Step 5: Remove dead `ConfigService` injection from `vcs-pr-sync.service.ts`**

`VcsPrSyncService` receives `encryptionKey` as a plain parameter to `syncPrStatus()` and never calls `configService.get()`. Remove the dead field:

```typescript
// Remove: import { ConfigService } from '@nestjs/config';
// Remove from constructor params:
//   @Optional() private readonly configService?: ConfigService,
```

The remaining constructor is:
```typescript
  constructor(
    @Inject(VCS_REPOSITORY) private readonly vcsRepo: IVcsRepository,
    @Optional() private readonly vcsLinkExtractorService?: VcsLinkExtractorService,
  ) {}
```

- [ ] **Step 6: Update `code-commit-outbox-handler.ts` in `src/code-intel/`**

```typescript
// Remove: import { ConfigService } from '@nestjs/config';
// Add:
import { VCS_CFG, IVcsConfig } from '../config/vcs.config';

// Change constructor — replace:
//   @Optional() @Inject(ConfigService) private readonly configService?: ConfigService,
// with:
    @Optional() @Inject(VCS_CFG) private readonly vcsConfig?: IVcsConfig,

// Replace:
//   const encryptionKey = this.configService?.get<string>('vcs.encryptionKey');
// with:
    const encryptionKey = this.vcsConfig?.encryptionKey;
```

- [ ] **Step 7: Update `combined-auth.guard.ts` in `src/auth/guards/`**

```typescript
// Remove: import { ConfigService } from '@nestjs/config';
// Add:
import { AUTH_CFG, IAuthConfig } from '../config/auth.config';

// Change constructor — replace:
//   private readonly config: ConfigService,
// with:
    @Inject(AUTH_CFG) private readonly authConfig: IAuthConfig,

// Replace in tryApiKey():
//   const authCfg = this.config.get<{ apiKeySecret?: string }>('auth');
//   const secret = authCfg?.apiKeySecret;
// with:
    const secret = this.authConfig.apiKeySecret;
    if (!secret) {
      this.combinedLogger.error('auth.apiKeySecret not configured');
      return false;
    }
```

Remove the now-unused `if (!secret)` check that immediately followed the old two-liner (it is now inlined above).

- [ ] **Step 8: Update `ticket-transitions.service.ts`**

```typescript
// Remove: import { ConfigService } from '@nestjs/config';
// Add:
import { VCS_CFG, IVcsConfig } from '../../config/vcs.config';

// In constructor params, replace:
//   @Optional() private readonly configService?: ConfigService,
// with:
    @Optional() @Inject(VCS_CFG) private readonly vcsConfig?: IVcsConfig,

// In createPrForTicket(), replace:
//   if (!this.vcsConnectionService || !this.ticketLinksService || !this.vcsLinkExtractorService || !this.configService) return Promise.resolve();
//   ...
//   const encryptionKey = this.configService.get<string>('vcs.encryptionKey');
// with:
    if (!this.vcsConnectionService || !this.ticketLinksService || !this.vcsLinkExtractorService || !this.vcsConfig) return Promise.resolve();
    ...
    const encryptionKey = this.vcsConfig.encryptionKey;
```

- [ ] **Step 9: TypeScript check**

```bash
cd apps/api && npx tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 10: Run unit tests**

```bash
cd apps/api && npx jest src/vcs/ src/tickets/ src/auth/ src/code-intel/ --testPathIgnorePatterns='integration|e2e' --no-coverage 2>&1
```

Expected: all pass. For any test that previously mocked `ConfigService`, replace it with the appropriate typed config token:
- `{ provide: VCS_CFG, useValue: { encryptionKey: 'test-key', defaultPollingIntervalMs: 600000, githubApiUrl: 'https://api.github.com' } }`
- `{ provide: AUTH_CFG, useValue: { apiKeySecret: 'test-secret', jwtSecret: undefined, jwtExpiresIn: '15m', jwtRefreshSecret: undefined, jwtRefreshExpiresIn: '7d' } }`

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/vcs/vcs.controller.ts \
        apps/api/src/vcs/vcs-connection.service.ts \
        apps/api/src/vcs/vcs-polling.service.ts \
        apps/api/src/vcs/vcs-webhook.service.ts \
        apps/api/src/vcs/vcs-pr-sync.service.ts \
        apps/api/src/code-intel/code-commit-outbox-handler.ts \
        apps/api/src/auth/guards/combined-auth.guard.ts \
        apps/api/src/tickets/state-machine/ticket-transitions.service.ts
git commit -m "fix: replace ConfigService with typed config token injection in VCS, auth guard, code-intel, and ticket transitions"
```

---

### Task 11: Final verification

- [ ] **Step 1: Grep for remaining `ConfigService.get` violations**

```bash
grep -rn 'configService\.get\|\.config\.get\b' apps/api/src/ 2>&1
```

Expected: no output. The only legitimate remaining `ConfigService` usage is inside `auth.module.ts`'s `useFactory` for `NathappAuthModule.forRootAsync` — this is a justified third-party integration exception and does NOT call `.get()` via a stored field; it is injected as a factory parameter. Verify with:

```bash
grep -n 'ConfigService' apps/api/src/auth/auth.module.ts 2>&1
```

That file is the only acceptable remaining consumer of `ConfigService`.

- [ ] **Step 2: Grep for raw `process.env` outside config files**

```bash
grep -rn 'process\.env' apps/api/src/ | grep -v 'apps/api/src/config/' 2>&1
```

Expected: no output.

- [ ] **Step 3: Full unit test run**

```bash
cd apps/api && npx jest --testPathIgnorePatterns='integration|e2e' --no-coverage 2>&1
```

Expected: all pass.

- [ ] **Step 4: Final TypeScript check**

```bash
cd apps/api && npx tsc --noEmit 2>&1
```

Expected: no errors.
